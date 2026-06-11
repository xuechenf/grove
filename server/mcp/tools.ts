import type { CopilotScope } from '../../src/types'
import { scopeVmId } from '../../src/types'
import type { CopilotToolHost, ToolResult } from '../copilotTypes'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpTool extends McpToolDefinition {
  run(args: Record<string, unknown>): Promise<ToolResult> | ToolResult
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function int(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/**
 * Build the tool set for a scope. Scope enforcement is physical: a `vm:<id>` session gets
 * tools pinned to that VM (no vmId argument is accepted), and fleet-only tools simply do
 * not exist in it — and vice versa. The model cannot reach another machine by argument.
 */
export function buildToolsForScope(scope: CopilotScope, host: CopilotToolHost): McpTool[] {
  const focusedVmId = scopeVmId(scope)
  const tools: McpTool[] = []

  // Shared inspection tools.
  tools.push({
    name: 'list_vms',
    description: 'List all VMs Grove manages with their lifecycle, health, and connection summary.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const vms = host.listVms()
      return {
        ok: true,
        summary: `Fleet has ${vms.length} VM${vms.length === 1 ? '' : 's'}.`,
        data: vms.map((vm) => ({
          id: vm.id,
          name: vm.name,
          host: vm.connection.host,
          lifecycle: vm.lifecycle,
          health: vm.health,
          os: vm.os,
          cpuPercent: vm.metrics.cpuPercent,
          memoryPercent: vm.metrics.memoryPercent,
          diskPercent: vm.metrics.diskPercent,
        })),
      }
    },
  })

  tools.push({
    name: 'get_vm',
    description: focusedVmId
      ? 'Get full live state for the focused VM: metrics, services, processes, alerts.'
      : 'Get full live state for a VM by id: metrics, services, processes, alerts.',
    inputSchema: focusedVmId
      ? { type: 'object', properties: {} }
      : {
          type: 'object',
          properties: { vmId: { type: 'string', description: 'Target VM id (see list_vms).' } },
          required: ['vmId'],
        },
    run: (args) => {
      const vmId = focusedVmId ?? str(args.vmId)
      const vm = host.getVm(vmId)
      if (!vm) {
        return { ok: false, summary: 'VM not found.', error: `Unknown VM ${vmId}.` }
      }
      return {
        ok: true,
        summary: `${vm.name} is ${vm.lifecycle}/${vm.health}.`,
        data: {
          id: vm.id,
          name: vm.name,
          os: vm.os,
          lifecycle: vm.lifecycle,
          health: vm.health,
          connection: { host: vm.connection.host, user: vm.connection.user, port: vm.connection.port },
          metrics: vm.metrics,
          services: vm.services,
          processes: vm.processes.slice(0, 8),
          alerts: vm.alerts,
          appServices: vm.appServices.map((service) => ({ name: service.name, port: service.port, state: service.state })),
        },
      }
    },
  })

  tools.push({
    name: 'get_history',
    description: 'Search this conversation scope\'s operation history (past messages, tool calls, executed actions).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring filter.' },
        limit: { type: 'number', description: 'Max entries (default 40).' },
      },
    },
    run: (args) => host.getHistory({ scope, query: str(args.query) || undefined, limit: int(args.limit, 40) }),
  })

  tools.push({
    name: 'record_note',
    description: 'Save a durable fact about this scope (config locations, ports, decisions) for future sessions.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The fact to remember.' } },
      required: ['content'],
    },
    run: (args) => host.recordNote({ scope, content: str(args.content) }),
  })

  tools.push({
    name: 'inspect_vm',
    description:
      (focusedVmId
        ? 'Refresh and return live metrics, services, and top processes for the focused VM '
        : 'Refresh and return live metrics, services, and top processes for a VM ') +
      'in a single SSH round-trip. Prefer this over separate uptime/free/df/systemctl probes.',
    inputSchema: focusedVmId
      ? { type: 'object', properties: {} }
      : {
          type: 'object',
          properties: { vmId: { type: 'string', description: 'Target VM id (see list_vms).' } },
          required: ['vmId'],
        },
    run: (args) => host.inspectVm({ scope, vmId: focusedVmId ?? str(args.vmId) }),
  })

  if (focusedVmId) {
    // VM-focused tools: vmId is pinned, never an argument.
    tools.push({
      name: 'diagnose_service',
      description:
        'Get systemd status, recent journal lines, and listening ports for one unit on the ' +
        'focused VM in a single SSH round-trip. Prefer this over separate service_status + read_logs calls.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Service/unit name, e.g. nginx.' },
          lines: { type: 'number', description: 'Journal lines to include (default 80, max 400).' },
        },
        required: ['name'],
      },
      run: (args) =>
        host.diagnoseService({
          scope,
          vmId: focusedVmId,
          unit: str(args.name),
          lines: int(args.lines, 80),
        }),
    })

    tools.push({
      name: 'run_command',
      description:
        'Run a shell command on the focused VM. Read-only commands run immediately. Mutating ' +
        'commands are paused for explicit user confirmation in the Grove UI before they execute.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          reason: { type: 'string', description: 'Why this command is needed (shown to the user).' },
        },
        required: ['command', 'reason'],
      },
      run: (args) =>
        host.runScopedCommand({
          scope,
          vmId: focusedVmId,
          command: str(args.command),
          reason: str(args.reason, 'Requested by copilot.'),
        }),
    })

    tools.push({
      name: 'read_logs',
      description: 'Read recent logs on the focused VM (journalctl or a unit), optionally filtered.',
      inputSchema: {
        type: 'object',
        properties: {
          unit: { type: 'string', description: 'Optional systemd unit name.' },
          grep: { type: 'string', description: 'Optional case-insensitive filter.' },
          lines: { type: 'number', description: 'Max lines (default 120).' },
        },
      },
      run: (args) =>
        host.readRemoteLogs({
          vmId: focusedVmId,
          unit: str(args.unit) || undefined,
          grep: str(args.grep) || undefined,
          lines: int(args.lines, 120),
        }),
    })

    tools.push({
      name: 'service_status',
      description: 'Show systemd status for a service on the focused VM.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Service/unit name.' } },
        required: ['name'],
      },
      run: (args) => host.serviceStatus({ vmId: focusedVmId, name: str(args.name) }),
    })

    tools.push({
      name: 'list_files',
      description: 'List files over SFTP on the focused VM.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Remote path, e.g. /etc.' } },
        required: ['path'],
      },
      run: (args) => host.listRemoteFiles({ vmId: focusedVmId, path: str(args.path, '/') }),
    })
  } else {
    // Fleet-only tool: targets are frozen at call time and each run is gated + locked.
    tools.push({
      name: 'fleet_run_command',
      description:
        'Run the same command across multiple VMs. Always paused for explicit user confirmation ' +
        'before executing. Targets default to all running VMs and are frozen when proposed.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run on each target.' },
          reason: { type: 'string', description: 'Why this fleet command is needed.' },
          targetVmIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit VM ids; omit to target all running VMs.',
          },
        },
        required: ['command', 'reason'],
      },
      run: (args) =>
        host.fleetRunCommand({
          scope,
          command: str(args.command),
          reason: str(args.reason, 'Requested by copilot.'),
          targetVmIds: Array.isArray(args.targetVmIds) ? args.targetVmIds.map((value) => String(value)) : undefined,
        }),
    })
  }

  return tools
}
