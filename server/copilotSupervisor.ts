import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CopilotRuntimeStatus, CopilotScope, VM } from '../src/types'
import { scopeVmId } from '../src/types'
import { OPENUI_OPERATOR_BRIEF_PROMPT } from '../src/openui/operatorBriefPrompt'
import type { CopilotDriver, CopilotToolHost, DriverUpdate, McpServerSpec } from './copilotTypes'
import { GROVE_KIMI_MODEL_NAME, ensureKimiConfigFile, kimiToolCallTimeoutMs } from './copilotProvider'
import { AcpDriver } from './drivers/acpDriver'
import { MockDriver } from './drivers/mockDriver'
import { PrintDriver } from './drivers/printDriver'
import { envFlag, envValue } from './env'
import { ScopeTokenRegistry } from './mcp/endpoint'
import { projectStatePath } from './projectState'

function resolveProxyPath() {
  try {
    return fileURLToPath(new URL('./mcp/groveStdioProxy.mjs', import.meta.url))
  } catch {
    return join(process.cwd(), 'server', 'mcp', 'groveStdioProxy.mjs')
  }
}

export interface CopilotSupervisorOptions {
  driver?: CopilotDriver
  host: CopilotToolHost
  tokens?: ScopeTokenRegistry
  /** Backend base url the spawned MCP proxy calls back into. */
  backendUrl?: string
  rootDir?: string
}

/**
 * Owns the copilot brain (kimi-code CLI) and everything around it: which driver runs, the
 * per-scope workspace + generated AGENTS.md, the scoped MCP config, and session lifecycle.
 * The store orchestrates events/journal/proposals; the supervisor only turns a scoped
 * message into streamed updates and a final answer.
 */
export class CopilotSupervisor {
  readonly tokens: ScopeTokenRegistry
  private readonly driver: CopilotDriver
  private readonly host: CopilotToolHost
  private readonly backendUrl: string
  private readonly rootDir: string
  private readonly preparedScopes = new Set<CopilotScope>()

  constructor(options: CopilotSupervisorOptions) {
    this.host = options.host
    this.tokens = options.tokens ?? new ScopeTokenRegistry()
    this.backendUrl = options.backendUrl ?? `http://127.0.0.1:${envValue('GROVE_PORT') ?? 8787}`
    this.rootDir = options.rootDir ?? projectStatePath('copilot')
    this.driver = options.driver ?? defaultDriver()
  }

  async start() {
    await this.driver.start().catch(() => {
      // Driver start failures surface through status(); a prompt will retry.
    })
  }

  status(): CopilotRuntimeStatus {
    return this.driver.status()
  }

  driverName() {
    return this.driver.name
  }

  async prompt(scope: CopilotScope, message: string, onUpdate: (update: DriverUpdate) => void) {
    const cwd = this.prepareWorkspace(scope)
    const mcp = this.mcpSpec(scope)
    return this.driver.prompt({ scope, cwd, mcp, message, onUpdate })
  }

  cancel(scope: CopilotScope) {
    this.driver.cancel(scope)
  }

  async stop() {
    await this.driver.stop()
  }

  workspaceDir(scope: CopilotScope) {
    return this.scopeDir(scope)
  }

  /** Append a durable note to the scope's notes.md (read natively by future kimi sessions). */
  appendNote(scope: CopilotScope, content: string) {
    const dir = this.prepareWorkspace(scope)
    const stamp = new Date().toISOString()
    appendFileSync(join(dir, 'notes.md'), `\n- (${stamp}) ${content.trim()}\n`, 'utf8')
  }

  private scopeDir(scope: CopilotScope) {
    return join(this.rootDir, 'workspaces', scope.replace(/[^a-zA-Z0-9_-]/g, '-'))
  }

  private prepareWorkspace(scope: CopilotScope) {
    const dir = this.scopeDir(scope)
    mkdirSync(dir, { recursive: true })
    // AGENTS.md holds only stable facts (identity, how-to, sibling ids), so its bytes are
    // identical turn-over-turn — that lets Moonshot's prompt cache reuse the prefix instead of
    // re-billing it. Live state (metrics, service/health) is fetched via tools, never embedded.
    writeFileSync(join(dir, 'AGENTS.md'), this.buildAgentsDoc(scope), 'utf8')
    const notesPath = join(dir, 'notes.md')
    if (!existsSync(notesPath)) {
      writeFileSync(notesPath, '# Notes\n\nDurable facts learned about this scope.\n', 'utf8')
    }
    this.preparedScopes.add(scope)
    return dir
  }

  private mcpSpec(scope: CopilotScope): McpServerSpec {
    const token = this.tokens.tokenForScope(scope)
    // The proxy's HTTP wait must outlast kimi's tool-call timeout, so it never gives up on a
    // long (but legitimately running) backend call before kimi would.
    const env = {
      GROVE_MCP_URL: this.backendUrl,
      GROVE_MCP_SCOPE_TOKEN: token,
      GROVE_MCP_PROXY_TIMEOUT_MS: String(kimiToolCallTimeoutMs() + 60000),
    }
    const configDir = join(this.rootDir, 'mcp')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, `${scope.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`)
    const spec: McpServerSpec = {
      name: 'grove',
      command: process.execPath,
      args: [resolveProxyPath()],
      env,
      configPath,
    }
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { grove: { command: spec.command, args: spec.args, env } } }, null, 2),
      'utf8',
    )
    return spec
  }

  private buildAgentsDoc(scope: CopilotScope): string {
    const vmId = scopeVmId(scope)
    if (vmId) {
      const vm = this.host.getVm(vmId)
      return vm ? buildVmAgentsDoc(vm, this.host.listVms()) : `# Grove VM ${vmId}\n\nThis VM is no longer in inventory.\n`
    }
    return buildFleetAgentsDoc(this.host.listVms())
  }
}

export function buildVmAgentsDoc(vm: VM, fleet: VM[]): string {
  const siblings = fleet
    .filter((other) => other.id !== vm.id)
    .map((other) => `${other.name} (${other.id})`)
    .join(', ')
  return [
    `# Grove VM: ${vm.name}`,
    '',
    'You operate this single Linux VM through the Grove backend, using the `grove` MCP tools.',
    '',
    '## Identity',
    `- id: ${vm.id}`,
    `- name: ${vm.name}`,
    `- connection: ${vm.connection.user}@${vm.connection.host}:${vm.connection.port}`,
    `- os: ${vm.os}`,
    '',
    '## How to act',
    '- Start with inspect_vm: one SSH round-trip returns live metrics, services, and top processes.',
    '- Use diagnose_service for a unit\'s status + recent logs + listening ports in one call,',
    '  instead of separate service_status and read_logs calls.',
    '- Need several read-only probes? Combine them into ONE run_command script (chain with `;`,',
    '  print a marker line between sections) — every extra tool call is a slow round-trip.',
    '- Read-only commands run immediately. Mutating commands pause for the user to confirm in the',
    '  Grove UI, so explain why before proposing one through run_command.',
    '- You cannot reach other VMs from this session.',
    '- Save durable facts with record_note; check get_history and notes.md for earlier context.',
    '',
    OPENUI_OPERATOR_BRIEF_PROMPT,
    '',
    // Live service/health state is intentionally NOT embedded here (it would bust the prompt
    // cache every turn and risk going stale); call inspect_vm / diagnose_service for it.
    `## Fleet siblings\n${siblings ? `- ${siblings}` : '- none'}`,
    '',
    'See notes.md in this directory for facts learned in earlier sessions.',
    '',
  ].join('\n')
}

export function buildFleetAgentsDoc(fleet: VM[]): string {
  return [
    '# Grove Fleet',
    '',
    `You operate a fleet of ${fleet.length} Linux VM${fleet.length === 1 ? '' : 's'} through the Grove backend.`,
    '',
    '## How to act',
    '- Use list_vms first; use inspect_vm with a vmId for fresh metrics/services/processes on one',
    '  machine in a single SSH round-trip (get_vm returns cached state).',
    '- Use fleet_run_command to act across machines. It always pauses for confirmation, freezes',
    '  its target set when proposed, and runs targets in parallel once confirmed.',
    '- For deep single-machine work, tell the user to select that VM (its own focused session).',
    '- Save durable facts with record_note; check get_history and notes.md for earlier context.',
    '',
    OPENUI_OPERATOR_BRIEF_PROMPT,
    '',
    // Names/ids/hosts only — current lifecycle/health is fetched via list_vms / inspect_vm so
    // this prefix stays byte-stable across turns for prompt-cache reuse.
    '## VMs',
    fleet.length
      ? fleet.map((vm) => `- ${vm.name} (${vm.id}): ${vm.connection.host}`).join('\n')
      : '- none',
    '',
    'See notes.md in this directory for facts learned in earlier sessions.',
    '',
  ].join('\n')
}

function defaultDriver(): CopilotDriver {
  const explicit = envValue('GROVE_COPILOT_DRIVER')
  if (explicit === 'mock' || envFlag('GROVE_USE_FIXTURES')) {
    return new MockDriver()
  }

  // A Grove-local kimi config lets kimi run with the user's saved Moonshot key, no global
  // `kimi login`. When present we use the model name from that config.
  const configFile = ensureKimiConfigFile()
  const model = configFile ? GROVE_KIMI_MODEL_NAME : envValue('GROVE_MOONSHOT_MODEL')

  if (explicit === 'acp') {
    return new AcpDriver({ model })
  }
  // Default to the print driver: it works non-interactively with the saved key via
  // --config-file. ACP stays available via GROVE_COPILOT_DRIVER=acp (needs `kimi login`).
  return new PrintDriver({ model, configFile })
}

export function loadNotes(supervisor: CopilotSupervisor, scope: CopilotScope): string {
  const path = join(supervisor.workspaceDir(scope), 'notes.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
