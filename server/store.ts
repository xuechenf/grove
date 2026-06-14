import { EventEmitter } from 'node:events'
import { initialMessages, initialProposals, initialTransfers, vms as fixtureVms } from '../src/data/fixtures'
import type {
  ActionProposal,
  AppRunnerService,
  AppRunnerServiceInput,
  AppRunnerServiceState,
  ActivityEvent,
  AppSnapshot,
  AuditEvent,
  CommandRun,
  CopilotInstallState,
  CopilotMessage,
  CopilotPermissionDecision,
  CopilotPlanEntryStatus,
  CopilotPlanState,
  CopilotProgressEvent,
  CopilotRuntimeStatus,
  CopilotScope,
  CopilotToolCall,
  ProcessInfo,
  ServiceInfo,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
  VmConfig,
  VmConnectionInput,
} from '../src/types'
import { scopeVmId, vmScope } from '../src/types'
import { loadAppRunnerServices, saveAppRunnerServices } from './appRunnerMetadata'
import { classifyCommand, isReadOnlyCommand } from './commandProfiles'
import { installKimiCli } from './copilotInstall'
import { CopilotJournal } from './copilotJournal'
import { CopilotPolicy } from './copilotPolicy'
import { CopilotSupervisor } from './copilotSupervisor'
import type { CopilotDriver, CopilotToolHost, DriverUpdate, ToolResult } from './copilotTypes'
import {
  DEFAULT_MOONSHOT_BASE_URL,
  DEFAULT_MOONSHOT_MODEL,
  moonshotConfigFromEnv,
  type MoonshotConfig,
} from './copilotProvider'
import { envFlag, envValue, saveMoonshotLocalEnv } from './env'
import { loadInventory, saveInventory, vmFromConfig } from './inventory'
import { ScopeTokenRegistry } from './mcp/endpoint'
import { KeyedMutex } from './mutationLock'
import { extractOpenUiArtifact } from './openUiArtifacts'
import type { SshSessionManager } from './sshSessionManager'
import { MockSshSessionManager, RealSshSessionManager } from './sshSessionManager'

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

/** Max journal entries injected when the user opts into "Reference history"; keeps the cost bounded. */
const HISTORY_REFERENCE_LIMIT = 30

interface PendingPermission {
  resolve: (decision: CopilotPermissionDecision) => void
  timer: NodeJS.Timeout
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function cleanText(value: string | undefined) {
  const text = value?.trim()
  return text || undefined
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueVmId(input: VmConnectionInput, configs: VmConfig[]) {
  const base = `vm-${slugify(cleanText(input.name) ?? input.ipAddress) || 'remote'}`
  let nextId = base
  let suffix = 2

  while (configs.some((config) => config.id === nextId)) {
    nextId = `${base}-${suffix}`
    suffix += 1
  }

  return nextId
}

function configFromConnectionInput(input: VmConnectionInput, id: string, existing?: VmConfig): VmConfig {
  const ipAddress = input.ipAddress.trim()
  const port = Number(input.port)
  return {
    id,
    name: cleanText(input.name) ?? existing?.name ?? ipAddress,
    host: ipAddress,
    user: cleanText(input.user) ?? existing?.user ?? 'root',
    port,
    keyPath: input.pemPath.trim(),
    useAgent: false,
    os: cleanText(input.os) ?? existing?.os ?? 'Linux',
    // Inventory labels are inert metadata (no UI); preserve whatever the YAML had.
    labels: existing?.labels,
    provider: {
      name: existing?.provider?.name ?? 'SSH',
      region: existing?.provider?.region ?? 'remote',
      node: ipAddress,
    },
  }
}

const processesMarker = '__GROVE_PROCESSES__'
const servicesMarker = '__GROVE_SERVICES__'

function roundPercent(value: number) {
  return Math.round(value * 10) / 10
}

function boundedCommand(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed
}

function parseProcesses(text: string): ProcessInfo[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
      if (!match) {
        return undefined
      }

      return {
        pid: Number(match[1]),
        user: match[2],
        cpuPercent: roundPercent(Number(match[3]) || 0),
        memoryMb: Math.round((Number(match[4]) || 0) / 1024),
        command: boundedCommand(match[5]),
      }
    })
    .filter((process): process is ProcessInfo => Boolean(process))
}

function parseServiceState(value: string): ServiceInfo['state'] {
  if (/failed|degrad/i.test(value)) {
    return 'degraded'
  }

  if (/dead|exited|inactive|stopped/i.test(value)) {
    return 'stopped'
  }

  return 'running'
}

function parseServices(text: string): ServiceInfo[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, state, port, cpu, rss] = line.split('\t')
      if (!name || !state) {
        return undefined
      }

      const parsedPort = Number(port)
      const service: ServiceInfo = {
        name,
        state: parseServiceState(state),
        cpuPercent: roundPercent(Number(cpu) || 0),
        memoryMb: Math.round((Number(rss) || 0) / 1024),
      }
      if (Number.isFinite(parsedPort) && parsedPort > 0) {
        service.port = parsedPort
      }

      return service
    })
    .filter((service): service is ServiceInfo => Boolean(service))
}

function parseRuntimeSections(output: string) {
  const [metricsText, rest = ''] = output.split(processesMarker)
  const [processText = '', serviceText = ''] = rest.split(servicesMarker)
  const values = Object.fromEntries(
    metricsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const [key, ...restParts] = line.split('=')
        return [key, restParts.join('=')]
      }),
  )

  return {
    values,
    processes: parseProcesses(processText),
    services: parseServices(serviceText),
  }
}

function refreshVmCommand() {
  return [
    // CPU% and network Mbps need a rate: two samples one second apart, diffed in awk.
    `CPU1=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8" "$5}' /proc/stat 2>/dev/null)`,
    `NET1=$(awk -F: 'NR>2{name=$1; gsub(/ /,"",name); if(name!="lo"){split($2,f," "); rx+=f[1]; tx+=f[9]}} END{print rx+0" "tx+0}' /proc/net/dev 2>/dev/null)`,
    'sleep 1',
    `CPU2=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8" "$5}' /proc/stat 2>/dev/null)`,
    `NET2=$(awk -F: 'NR>2{name=$1; gsub(/ /,"",name); if(name!="lo"){split($2,f," "); rx+=f[1]; tx+=f[9]}} END{print rx+0" "tx+0}' /proc/net/dev 2>/dev/null)`,
    `printf "CPU_PCT=%s\\n" "$(echo "$CPU1 $CPU2" | awk '{dt=$3-$1; di=$4-$2; if(dt>0){printf "%.0f", 100*(dt-di)/dt} else {print 0}}')"`,
    `printf "NET_RX_MBPS=%s\\n" "$(echo "$NET1 $NET2" | awk '{printf "%.1f", ($3-$1)*8/1000000}')"`,
    `printf "NET_TX_MBPS=%s\\n" "$(echo "$NET1 $NET2" | awk '{printf "%.1f", ($4-$2)*8/1000000}')"`,
    'printf "HOSTNAME=%s\\n" "$(hostname)"',
    '. /etc/os-release 2>/dev/null; printf "OS=%s\\n" "${PRETTY_NAME:-Linux}"',
    'printf "UPTIME=%s\\n" "$(uptime -p 2>/dev/null || uptime)"',
    "awk '{print \"LOAD=\"$1\",\"$2\",\"$3}' /proc/loadavg",
    'printf "CPUS=%s\\n" "$(nproc 2>/dev/null || echo 1)"',
    'free -m | awk \'/Mem:/ {print "MEM_TOTAL_MB="$2"\\nMEM_USED_MB="$3}\'',
    'df -Pk / | awk \'NR==2 {print "DISK_TOTAL_KB="$2"\\nDISK_USED_KB="$3"\\nDISK_PCT="$5}\'',
    `printf "${processesMarker}\\n"`,
    'ps -eo pid=,user=,pcpu=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 8',
    `printf "${servicesMarker}\\n"`,
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl list-units --type=service --state=running,failed --no-legend --no-pager --plain 2>/dev/null | head -n 12 | while read -r unit load active sub rest; do',
    '    pid=$(systemctl show "$unit" -p MainPID --value 2>/dev/null || echo 0)',
    '    cpu=0',
    '    rss=0',
    '    if [ -n "$pid" ] && [ "$pid" != "0" ]; then set -- $(ps -p "$pid" -o pcpu=,rss= 2>/dev/null); cpu=${1:-0}; rss=${2:-0}; fi',
    '    port=""',
    '    if [ -n "$pid" ] && [ "$pid" != "0" ] && command -v ss >/dev/null 2>&1; then port=$(ss -ltnp 2>/dev/null | awk -v needle="pid=$pid," \'$0 ~ needle {n=split($4,a,":"); print a[n]; exit}\'); fi',
    '    printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$unit" "$sub" "$port" "$cpu" "$rss"',
    '  done',
    'else',
    '  ps -eo comm=,stat=,pcpu=,rss= --sort=-pcpu 2>/dev/null | head -n 8 | awk \'BEGIN{OFS="\\t"} {state=($2 ~ /Z/ ? "degraded" : "running"); print $1,state,"",$3,$4}\'',
    'fi',
  ].join('\n')
}

const unitStatusMarker = '__GROVE_UNIT_STATUS__'
const unitLogsMarker = '__GROVE_UNIT_LOGS__'
const unitPortsMarker = '__GROVE_UNIT_PORTS__'

/** Status + recent logs + listening ports for one unit, packed into a single SSH exec. */
function diagnoseServiceCommand(unit: string, lines: number) {
  const quoted = shellQuote(unit)
  return [
    `printf "${unitStatusMarker}\\n"`,
    `systemctl status ${quoted} --no-pager -l 2>&1 | head -n 40`,
    `printf "${unitLogsMarker}\\n"`,
    `journalctl -u ${quoted} -n ${lines} --no-pager 2>&1`,
    `printf "${unitPortsMarker}\\n"`,
    `PID=$(systemctl show ${quoted} -p MainPID --value 2>/dev/null); if [ -n "$PID" ] && [ "$PID" != "0" ]; then ss -ltnp 2>/dev/null | awk -v needle="pid=$PID," 'NR==1 || $0 ~ needle'; fi`,
    // A stopped or failed unit must not read as a transport failure.
    'true',
  ].join('\n')
}

function makeActivity(title: string, detail: string, severity: ActivityEvent['severity'] = 'info'): ActivityEvent {
  return {
    id: id('act'),
    timestamp: nowLabel(),
    title,
    detail,
    severity,
  }
}

function patchFleetCommand() {
  return [
    'set -e',
    'SUDO=""',
    'if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  $SUDO apt-get update',
    '  $SUDO apt-get -y upgrade',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  $SUDO dnf -y upgrade',
    'elif command -v yum >/dev/null 2>&1; then',
    '  $SUDO yum -y update',
    'else',
    '  echo "No supported package manager found" >&2',
    '  exit 1',
    'fi',
    'if [ -f /var/run/reboot-required ]; then echo "REBOOT_REQUIRED=1"; fi',
  ].join('\n')
}

function runningVms(vms: VM[]) {
  return vms.filter((vm) => vm.lifecycle === 'running')
}

function targetSummary(vms: VM[]) {
  const targets = runningVms(vms)
  return targets.length ? targets.map((target) => target.name).join(', ') : 'no running VMs'
}

function proposalFor(type: ActionProposal['actionType'], vm: VM, activeTab: TabId, allVms: VM[] = [vm]): ActionProposal {
  const base = {
    id: id('proposal'),
    vmId: vm.id,
    status: 'pending_confirmation' as const,
  }

  if (type === 'inspect_logs') {
    return {
      ...base,
      title: `Inspect logs on ${vm.name}`,
      description: `Collect recent warning and alert logs for the ${activeTab} context.`,
      command: 'sudo journalctl -p warning..alert -n 120 --no-pager',
      actionType: type,
      risk: 'low',
    }
  }

  if (type === 'restart_service') {
    return {
      ...base,
      title: 'Restart degraded service',
      description: 'Restart a degraded service after explicit confirmation.',
      command: 'sudo systemctl restart wal-archive',
      actionType: type,
      risk: 'medium',
    }
  }

  if (type === 'transfer_file') {
    return {
      ...base,
      title: `Stage file transfer for ${vm.name}`,
      description: 'Prepare an SFTP transfer and flag path conflicts before writing.',
      command: `sftp -P ${vm.connection.port} ${vm.connection.user}@${vm.connection.host}`,
      actionType: type,
      risk: 'low',
    }
  }

  if (type === 'patch_vms') {
    const targets = runningVms(allVms)
    return {
      ...base,
      title: `Patch ${targets.length} running VM${targets.length === 1 ? '' : 's'}`,
      description: `Run a confirmed package update plan over SSH for: ${targetSummary(allVms)}. Each VM uses a separate exec channel and activity entry.`,
      command: patchFleetCommand(),
      actionType: type,
      risk: 'high',
    }
  }

  return {
    ...base,
    title: `Explain ${vm.name} metrics`,
    description: 'Summarize resource pressure and suggest safe next checks.',
    command: 'uptime && free -h && df -h && systemctl --failed',
    actionType: 'explain_metrics',
    risk: 'low',
  }
}

const appRunnerStatusMarker = '__GROVE_APPRUNNER_STATUS__'
const appRunnerHomeMarker = '__GROVE_HOME__'
const appRunnerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

function systemdQuote(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

function appRunnerUnitName(serviceName: string) {
  return `grove-apprunner-${serviceName}.service`
}

function appRunnerRemotePath(serviceName: string) {
  return `~/services/${serviceName}`
}

function appRunnerAccessUrl(vm: VM, port: number) {
  return `http://${vm.connection.host}:${port}/`
}

function trimOptional(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function normalizeAppRunnerInput(input: AppRunnerServiceInput): AppRunnerServiceInput {
  const name = input.name.trim()
  const installCommand = trimOptional(input.installCommand)
  const buildCommand = trimOptional(input.buildCommand)
  const startCommand = input.startCommand.trim()

  if (!appRunnerNamePattern.test(name)) {
    throw new Error('Service name must be a lowercase slug using letters, numbers, and hyphens.')
  }

  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('Service port must be from 1 to 65535.')
  }

  if (!startCommand) {
    throw new Error('Start command is required.')
  }

  if (input.source.type === 'github') {
    validateGithubSource(input.source.repoUrl)
    const ref = trimOptional(input.source.ref)
    return {
      name,
      port: input.port,
      source: {
        type: 'github',
        repoUrl: input.source.repoUrl.trim(),
        ref,
      },
      installCommand,
      buildCommand,
      startCommand,
    }
  }

  const path = input.source.path.trim()
  if (!path) {
    throw new Error('Local source path is required.')
  }

  return {
    name,
    port: input.port,
    source: {
      type: 'local',
      path,
    },
    installCommand,
    buildCommand,
    startCommand,
  }
}

function validateGithubSource(repoUrl: string) {
  const trimmed = repoUrl.trim()
  if (/^git@github\.com:[^/]+\/[^/]+/i.test(trimmed)) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('GitHub source must be a valid GitHub URL.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('GitHub URL must not include embedded credentials.')
  }

  if (parsed.hostname !== 'github.com' || !['https:', 'ssh:'].includes(parsed.protocol)) {
    throw new Error('GitHub source must point to github.com.')
  }
}

function commandLine(command: string | undefined) {
  return command ? [`bash -lc ${shellQuote(command)}`] : []
}

function buildSystemdUnit(vm: VM, service: AppRunnerService, targetPath: string) {
  return [
    '[Unit]',
    `Description=Grove AppRunner service ${service.name}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${vm.connection.user}`,
    `WorkingDirectory=${targetPath}`,
    'Environment=HOST=0.0.0.0',
    `Environment=PORT=${service.port}`,
    `ExecStart=/bin/bash -lc ${systemdQuote(`exec ${service.startCommand}`)}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n')
}

function appRunnerDeployCommand(input: AppRunnerServiceInput, service: AppRunnerService, stagePath: string, targetPath: string, unitText: string) {
  const cloneLines =
    input.source.type === 'github'
      ? [
          `rm -rf "$STAGE_DIR"`,
          `mkdir -p "$(dirname "$STAGE_DIR")"`,
          input.source.ref
            ? `git clone --depth 1 --branch ${shellQuote(input.source.ref)} ${shellQuote(input.source.repoUrl)} "$STAGE_DIR"`
            : `git clone --depth 1 ${shellQuote(input.source.repoUrl)} "$STAGE_DIR"`,
        ]
      : []

  return [
    'set -euo pipefail',
    'SUDO=""',
    'if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi',
    `UNIT_NAME=${shellQuote(service.unitName)}`,
    `STAGE_DIR=${shellQuote(stagePath)}`,
    `TARGET_DIR=${shellQuote(targetPath)}`,
    'mkdir -p "$(dirname "$TARGET_DIR")"',
    ...cloneLines,
    'if [ ! -d "$STAGE_DIR" ]; then echo "Stage directory is missing" >&2; exit 1; fi',
    'cd "$STAGE_DIR"',
    ...commandLine(input.installCommand),
    ...commandLine(input.buildCommand),
    '$SUDO systemctl stop "$UNIT_NAME" 2>/dev/null || true',
    'rm -rf "$TARGET_DIR.previous"',
    'if [ -d "$TARGET_DIR" ]; then mv "$TARGET_DIR" "$TARGET_DIR.previous"; fi',
    'mv "$STAGE_DIR" "$TARGET_DIR"',
    'rm -rf "$TARGET_DIR.previous"',
    'UNIT_TMP="$(mktemp)"',
    `cat > "$UNIT_TMP" <<'__GROVE_UNIT__'\n${unitText}\n__GROVE_UNIT__`,
    '$SUDO install -m 0644 "$UNIT_TMP" "/etc/systemd/system/$UNIT_NAME"',
    'rm -f "$UNIT_TMP"',
    '$SUDO systemctl daemon-reload',
    '$SUDO systemctl enable --now "$UNIT_NAME"',
    '$SUDO systemctl is-active "$UNIT_NAME"',
  ].join('\n')
}

function appRunnerPrepareLocalStageCommand(stagePath: string) {
  return [
    'set -euo pipefail',
    `STAGE_DIR=${shellQuote(stagePath)}`,
    'rm -rf "$STAGE_DIR"',
    'mkdir -p "$STAGE_DIR"',
  ].join('\n')
}

function appRunnerRemoveCommand(service: AppRunnerService, targetPath: string) {
  return [
    'set -euo pipefail',
    'SUDO=""',
    'if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi',
    `UNIT_NAME=${shellQuote(service.unitName)}`,
    `TARGET_DIR=${shellQuote(targetPath)}`,
    '$SUDO systemctl stop "$UNIT_NAME" 2>/dev/null || true',
    '$SUDO systemctl disable "$UNIT_NAME" 2>/dev/null || true',
    '$SUDO rm -f "/etc/systemd/system/$UNIT_NAME"',
    '$SUDO systemctl daemon-reload',
    'rm -rf "$TARGET_DIR"',
  ].join('\n')
}

function appRunnerStatusCommand(service: AppRunnerService) {
  return [
    `UNIT=${shellQuote(service.unitName)}`,
    `PORT=${shellQuote(String(service.port))}`,
    'state="unknown"',
    'if command -v systemctl >/dev/null 2>&1; then state=$(systemctl is-active "$UNIT" 2>/dev/null || true); fi',
    'pid=0',
    'if command -v systemctl >/dev/null 2>&1; then pid=$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0); fi',
    'cpu=0',
    'rss=0',
    'if [ -n "$pid" ] && [ "$pid" != "0" ]; then set -- $(ps -p "$pid" -o pcpu=,rss= 2>/dev/null); cpu=${1:-0}; rss=${2:-0}; fi',
    'listening=0',
    'if command -v ss >/dev/null 2>&1; then listening=$(ss -ltn 2>/dev/null | awk -v port=":$PORT" \'$4 ~ port "$" {found=1} END {print found ? 1 : 0}\'); fi',
    `printf "${appRunnerStatusMarker}\\nstate=%s\\npid=%s\\ncpu=%s\\nrss=%s\\nlistening=%s\\n" "$state" "$pid" "$cpu" "$rss" "$listening"`,
  ].join('\n')
}

function remoteHomeCommand() {
  return `printf "${appRunnerHomeMarker}\\n%s\\n" "$HOME"`
}

function appRunnerStateFromSystemd(value: string): AppRunnerServiceState {
  if (value === 'active') {
    return 'running'
  }

  if (value === 'failed' || value === 'activating' || value === 'deactivating') {
    return 'degraded'
  }

  if (value === 'inactive') {
    return 'stopped'
  }

  return 'unknown'
}

function parseKeyValueOutput(output: string) {
  return Object.fromEntries(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const [key, ...valueParts] = line.split('=')
        return [key, valueParts.join('=')]
      }),
  )
}

function scopeLabel(scope: CopilotScope, vms: VM[]) {
  const vmId = scopeVmId(scope)
  if (!vmId) {
    return `All VMs (${vms.length})`
  }
  return vms.find((vm) => vm.id === vmId)?.name ?? vmId
}

function commandKind(command: string): CopilotToolCall['kind'] {
  return isReadOnlyCommand(command) ? 'read' : 'execute'
}

function compactLine(value: string, max = 400) {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Clip a multiline block for the timeline, preserving line structure (unlike compactLine). */
function clipBlock(value: string, maxChars = 8000, maxLines = 200) {
  const lines = value.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const clippedLines = lines.length > maxLines ? [...lines.slice(0, maxLines), `… +${lines.length - maxLines} lines`] : lines
  const joined = clippedLines.join('\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined
}

/**
 * Tools the Grove backend executes and instruments itself (startToolCall/finishToolCall with
 * the real command and output). The agent also reports these calls from its side; that view
 * is dropped so each step appears exactly once, with the authoritative card winning.
 */
const GROVE_INSTRUMENTED_TOOLS = new Set([
  'run_command',
  'read_logs',
  'service_status',
  'list_files',
  'fleet_run_command',
  'inspect_vm',
  'diagnose_service',
])

/** Normalize an agent-reported tool title ("mcp__grove__run_command", "grove:run_command") to its base name. */
function agentToolName(title: string): string {
  const normalized = title.toLowerCase().trim().replace(/\s+/g, '_')
  const segments = normalized.split(/__|[:./]/).filter(Boolean)
  return segments[segments.length - 1] ?? normalized
}

function toPlanEntryStatus(value: string): CopilotPlanEntryStatus {
  if (value === 'completed' || value === 'done') {
    return 'completed'
  }
  if (value === 'in_progress' || value === 'active' || value === 'running') {
    return 'in_progress'
  }
  return 'pending'
}

/** Mutable per-prompt state threaded through driver updates for one copilot turn. */
interface CopilotTurn {
  scope: CopilotScope
  assistantId: string
  text: string
  /**
   * When the first answer token arrived. The assistant message is re-anchored to this
   * moment so the timeline reads like the agent's run: steps first, then the answer.
   */
  textStartedAt?: number
  /** Open streaming thought block, closed when any non-thought update arrives. */
  thought?: CopilotToolCall
  /** This turn's plan checklist id, allocated on the first plan update. */
  planId?: string
}

function commandOutput(run: CommandRun) {
  return run.stdout?.trim() || run.stderr?.trim() || run.summary
}

/** A terminal-style transcript of one SSH command run for the step's "console log" view. */
function commandConsoleDump(run: CommandRun): string {
  const lines = [`$ ${run.command}`]
  const stdout = (run.stdout ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (stdout) {
    lines.push(stdout)
  }
  const stderr = (run.stderr ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (stderr) {
    lines.push('--- stderr ---', stderr)
  }
  const exit = run.exitCode ?? (run.status === 'completed' ? 0 : 1)
  lines.push(`[exit ${exit}]`)
  // Generous bound — this is the detailed view — but still capped for journal/snapshot size.
  return clipBlock(lines.join('\n'), 20000, 500)
}

/** One transcript per VM for a fleet command, each labelled with the VM name. */
function fleetConsoleDump(runs: CommandRun[], vms: VM[]): string {
  return runs.map((run, index) => `# ${vms[index]?.name ?? run.vmId}\n${commandConsoleDump(run)}`).join('\n\n')
}

function toolResultFromRun(run: CommandRun, reason: string): ToolResult {
  return {
    ok: run.status === 'completed',
    summary: `${reason}: ${run.summary}`.trim(),
    data: {
      status: run.status,
      exitCode: run.exitCode,
      stdout: (run.stdout ?? '').slice(0, 6000),
      stderr: (run.stderr ?? '').slice(0, 2000),
    },
    error: run.status === 'failed' ? run.stderr || run.summary : undefined,
  }
}

export interface GroveStoreOptions {
  supervisor?: CopilotSupervisor
  driver?: CopilotDriver
  journal?: CopilotJournal
  policy?: CopilotPolicy
  tokens?: ScopeTokenRegistry
  /** kimi-code CLI installer; injectable so tests don't shell out to a real install. */
  installer?: typeof installKimiCli
}

export class GroveStore implements CopilotToolHost {
  private readonly events = new EventEmitter()
  private readonly ssh: SshSessionManager
  private readonly journal: CopilotJournal
  private readonly policy: CopilotPolicy
  readonly scopeTokens: ScopeTokenRegistry
  private readonly supervisor: CopilotSupervisor
  private readonly installer: typeof installKimiCli
  private installState: CopilotInstallState = { status: 'idle', log: '' }
  private readonly mutationLock = new KeyedMutex()
  /**
   * One confirmation card at a time per scope. When the agent issues several gated
   * commands in parallel, their cards surface strictly in arrival order and the next one
   * only appears once the previous is decided — the user can never confirm out of order.
   */
  private readonly confirmationLock = new KeyedMutex()
  /** Strictly increasing timeline-order counter; see {@link nextStamp}. */
  private lastStamp = 0
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private vmConfigs: VmConfig[]
  private vms: VM[]
  private transfers: TransferJob[]
  private messages: CopilotMessage[]
  private proposals: ActionProposal[]
  private toolCalls: CopilotToolCall[]
  private plans: CopilotPlanState[]
  private refreshedOnce = false

  constructor(
    ssh: SshSessionManager = envFlag('GROVE_USE_FIXTURES') ? new MockSshSessionManager() : new RealSshSessionManager(),
    options: GroveStoreOptions = {},
  ) {
    const useFixtures = envFlag('GROVE_USE_FIXTURES')
    this.ssh = ssh
    // In fixtures/test mode the journal is disabled so tests never touch the real .grove.
    this.journal = options.journal ?? new CopilotJournal(undefined, !useFixtures)
    this.policy = options.policy ?? new CopilotPolicy({ persist: !useFixtures })
    this.scopeTokens = options.tokens ?? new ScopeTokenRegistry()
    this.supervisor =
      options.supervisor ??
      new CopilotSupervisor({ host: this, tokens: this.scopeTokens, driver: options.driver })
    this.installer = options.installer ?? installKimiCli
    const configs = loadInventory()
    this.vmConfigs = configs
    this.vms = this.vmConfigs.map((config) => vmFromConfig(config, fixtureVms.find((vm) => vm.id === config.id)))
    if (!useFixtures) {
      const appServices = loadAppRunnerServices()
      this.vms = this.vms.map((vm) => ({
        ...vm,
        appServices: appServices
          .filter((service) => service.vmId === vm.id)
          .map((service) => ({
            ...service,
            accessUrl: appRunnerAccessUrl(vm, service.port),
          })),
      }))
    }
    this.transfers = useFixtures ? [...initialTransfers] : []
    if (useFixtures) {
      this.messages = [...initialMessages]
      this.proposals = [...initialProposals]
      this.toolCalls = []
      this.plans = []
    } else {
      const hydrated = this.journal.load()
      this.messages = hydrated.messages
      this.proposals = hydrated.proposals
      this.toolCalls = hydrated.toolCalls
      this.plans = hydrated.plans
    }
    void this.supervisor.start()
  }

  /**
   * Allocate a strictly increasing `createdAt` for timeline items. `Date.now()` has only
   * millisecond resolution, so steps started in the same tick would share an order value and
   * the UI would fall back to insertion order across kinds. A monotonic counter guarantees
   * unique, temporally-correct ordering for messages, tool calls, thoughts, and plans.
   */
  private nextStamp() {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  copilotProviderStatus() {
    return {
      provider: 'moonshot' as const,
      configured: Boolean(moonshotConfigFromEnv()),
      baseUrl: envValue('GROVE_MOONSHOT_BASE_URL') ?? DEFAULT_MOONSHOT_BASE_URL,
      model: envValue('GROVE_MOONSHOT_MODEL') ?? DEFAULT_MOONSHOT_MODEL,
    }
  }

  copilotRuntimeStatus(): CopilotRuntimeStatus {
    return this.supervisor.status()
  }

  copilotInstallState(): CopilotInstallState {
    return this.installState
  }

  private setInstallState(next: Partial<CopilotInstallState>) {
    this.installState = { ...this.installState, ...next }
    this.publish({ type: 'copilot.install', payload: this.installState })
  }

  /**
   * Install the kimi-code CLI on demand (uv tool install kimi-cli), streaming progress to the
   * copilot panel via copilot.install events and refreshing runtime status when it finishes so
   * the install prompt clears. Idempotent while a run is in flight.
   */
  async installKimi(): Promise<{ install: CopilotInstallState; runtime: CopilotRuntimeStatus }> {
    if (this.installState.status === 'running') {
      return { install: this.installState, runtime: this.supervisor.status() }
    }
    // Fresh run: reset the log (don't merge onto a previous run's output).
    this.installState = { status: 'running', log: '', detail: 'Starting install…' }
    this.publish({ type: 'copilot.install', payload: this.installState })

    const append = (line: string) => {
      this.setInstallState({ log: this.installState.log ? `${this.installState.log}\n${line}` : line })
    }

    try {
      const result = await this.installer(append)
      this.setInstallState(
        result.ok
          ? { status: 'done', detail: `kimi-code CLI installed (${result.binary}).` }
          : { status: 'error', detail: result.error ?? 'Install failed.' },
      )
    } catch (error) {
      this.setInstallState({ status: 'error', detail: error instanceof Error ? error.message : 'Install failed.' })
    }

    const runtime = this.supervisor.status()
    this.publish({ type: 'copilot.runtime', payload: runtime })
    return { install: this.installState, runtime }
  }

  copilotWorkspaceDir(scope: CopilotScope) {
    return this.supervisor.workspaceDir(scope)
  }

  configureCopilotProvider(input: MoonshotConfig) {
    saveMoonshotLocalEnv(input)
    return this.copilotProviderStatus()
  }

  onEvent(listener: (event: ServerEvent) => void) {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  snapshot(): AppSnapshot {
    return {
      vms: this.vms,
      transfers: this.transfers,
      messages: this.messages,
      proposals: this.proposals,
      toolCalls: this.toolCalls,
      plans: this.plans,
      runtime: this.supervisor.status(),
      install: this.installState,
    }
  }

  async refreshAllVmInfoOnce() {
    if (this.refreshedOnce || envFlag('GROVE_USE_FIXTURES')) {
      return
    }

    this.refreshedOnce = true
    await Promise.allSettled(this.vms.map((vm) => this.refreshVmInfo(vm.id)))
  }

  listVms() {
    return this.vms
  }

  getVm(vmId: string) {
    return this.vms.find((vm) => vm.id === vmId)
  }

  createVm(input: VmConnectionInput) {
    const config = configFromConnectionInput(input, uniqueVmId(input, this.vmConfigs))
    this.assertUniqueEndpoint(config)
    this.vmConfigs = [config, ...this.vmConfigs]
    this.persistInventory()

    const activity = makeActivity(
      'VM added',
      `${config.user}@${config.host}:${config.port} using ${config.keyPath}`,
      'success',
    )
    const template = vmFromConfig(config)
    const vm: VM = {
      ...template,
      health: 'warning',
      lifecycle: 'running',
      metrics: {
        ...template.metrics,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        networkInMbps: 0,
        networkOutMbps: 0,
        loadAverage: [0, 0, 0],
        uptime: 'not sampled',
        sampledAt: 'not sampled',
      },
      alerts: ['Connection profile has not been tested yet'],
      services: [],
      appServices: [],
      processes: [],
      activity: [activity],
    }

    this.vms = [vm, ...this.vms]
    this.publish({ type: 'vm.updated', payload: vm })
    this.publish({
      type: 'activity.created',
      payload: {
        ...activity,
        vmId: vm.id,
        actor: 'user',
      },
    })
    return vm
  }

  updateVm(vmId: string, input: VmConnectionInput) {
    const vm = this.requireVm(vmId)
    const existingConfig = this.vmConfigs.find((config) => config.id === vmId)
    const config = configFromConnectionInput(input, vmId, existingConfig)
    this.assertUniqueEndpoint(config, vmId)
    this.vmConfigs = this.vmConfigs.some((item) => item.id === vmId)
      ? this.vmConfigs.map((item) => (item.id === vmId ? config : item))
      : [config, ...this.vmConfigs]
    this.persistInventory()

    const activity = makeActivity(
      'Connection profile updated',
      `${config.user}@${config.host}:${config.port} using ${config.keyPath}`,
      'success',
    )
    const template = vmFromConfig(config, vm)
    const updatedVm: VM = {
      ...template,
      health: vm.health === 'offline' ? 'warning' : vm.health,
      lifecycle: vm.lifecycle === 'stopped' ? 'running' : vm.lifecycle,
      connection: {
        ...template.connection,
        lastConnected: vm.connection.lastConnected,
        testStatus: 'idle',
      },
      alerts:
        vm.alerts.length === 1 && vm.alerts[0] === 'Connection profile has not been tested yet'
          ? vm.alerts
          : ['Connection profile has not been tested yet'],
      activity: [activity, ...vm.activity],
    }

    this.replaceVm(updatedVm)
    this.publish({
      type: 'activity.created',
      payload: {
        ...activity,
        vmId,
        actor: 'user',
      },
    })
    return updatedVm
  }

  async listFiles(vmId: string, path = '/') {
    const vm = this.requireVm(vmId)
    return this.ssh.listFiles(vm, path)
  }

  async listAppRunnerServices(vmId: string) {
    const vm = this.requireVm(vmId)
    if (envFlag('GROVE_USE_FIXTURES') || vm.appServices.length === 0) {
      return vm.appServices
    }

    const appServices = await Promise.all(vm.appServices.map((service) => this.collectAppRunnerStatus(vm, service)))
    const updatedVm = { ...vm, appServices }
    this.replaceVm(updatedVm)
    this.persistAppRunnerServices()
    return appServices
  }

  async createAppRunnerService(vmId: string, input: AppRunnerServiceInput) {
    const vm = this.requireVm(vmId)
    const normalized = normalizeAppRunnerInput(input)
    this.assertUniqueAppRunnerService(vm, normalized)

    const timestamp = new Date().toISOString()
    const service: AppRunnerService = {
      id: `apprunner-${vm.id}-${normalized.name}`,
      vmId: vm.id,
      name: normalized.name,
      source: normalized.source,
      port: normalized.port,
      remotePath: appRunnerRemotePath(normalized.name),
      unitName: appRunnerUnitName(normalized.name),
      accessUrl: appRunnerAccessUrl(vm, normalized.port),
      state: 'unknown',
      cpuPercent: 0,
      memoryMb: 0,
      listening: false,
      installCommand: normalized.installCommand,
      buildCommand: normalized.buildCommand,
      startCommand: normalized.startCommand,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastDeployStatus: 'pending',
      lastDeploySummary: 'Deployment queued.',
    }

    const deployedService = await this.deployAppRunnerService(vm, normalized, service)
    this.upsertAppRunnerService(vm.id, deployedService)
    this.addActivity(
      vm.id,
      makeActivity('AppRunner service created', `${deployedService.name} listening on port ${deployedService.port}.`, 'success'),
      'user',
    )
    return deployedService
  }

  async updateAppRunnerService(vmId: string, serviceName: string, input: AppRunnerServiceInput) {
    const vm = this.requireVm(vmId)
    const existing = this.requireAppRunnerService(vm, serviceName)
    const normalized = normalizeAppRunnerInput(input)
    if (normalized.name !== serviceName) {
      throw new Error('Renaming AppRunner services is not supported. Remove and recreate the service instead.')
    }
    this.assertUniqueAppRunnerService(vm, normalized, serviceName)

    const service: AppRunnerService = {
      ...existing,
      source: normalized.source,
      port: normalized.port,
      accessUrl: appRunnerAccessUrl(vm, normalized.port),
      installCommand: normalized.installCommand,
      buildCommand: normalized.buildCommand,
      startCommand: normalized.startCommand,
      updatedAt: new Date().toISOString(),
      lastDeployStatus: 'pending',
      lastDeploySummary: 'Update queued.',
    }

    const deployedService = await this.deployAppRunnerService(vm, normalized, service)
    this.upsertAppRunnerService(vm.id, deployedService)
    this.addActivity(
      vm.id,
      makeActivity('AppRunner service updated', `${deployedService.name} restarted on port ${deployedService.port}.`, 'success'),
      'user',
    )
    return deployedService
  }

  async removeAppRunnerService(vmId: string, serviceName: string) {
    const vm = this.requireVm(vmId)
    const service = this.requireAppRunnerService(vm, serviceName)
    const home = await this.resolveRemoteHome(vm)
    const targetPath = `${home}/services/${service.name}`
    const run = await this.ssh.executeCommand({
      vm,
      command: appRunnerRemoveCommand(service, targetPath),
      actor: 'user',
      mutating: true,
    })
    if (run.status === 'failed') {
      throw new Error(run.stderr || run.summary)
    }

    const updatedVm = {
      ...this.requireVm(vmId),
      appServices: this.requireVm(vmId).appServices.filter((item) => item.name !== serviceName),
    }
    this.replaceVm(updatedVm)
    this.persistAppRunnerServices()
    this.addActivity(vm.id, makeActivity('AppRunner service removed', `${service.name} and ${service.remotePath} purged.`, 'success'), 'user', {
      commandRunId: run.id,
    })
    return { serviceName }
  }

  async refreshVmInfo(vmId: string): Promise<VM> {
    return (await this.sampleVmInfo(vmId)).vm
  }

  /** Like refreshVmInfo, but also returns the raw command run so callers can keep its console dump. */
  private async sampleVmInfo(vmId: string): Promise<{ vm: VM; run: CommandRun }> {
    const vm = this.requireVm(vmId)
    const command = refreshVmCommand()
    const run = await this.ssh.executeCommand({
      vm,
      command,
      actor: 'system',
      mutating: false,
    })

    if (run.status === 'failed') {
      const failedVm: VM = {
        ...vm,
        health: 'critical',
        lifecycle: vm.lifecycle === 'stopped' ? 'running' : vm.lifecycle,
        alerts: ['VM is unreachable over SSH'],
        connection: {
          ...vm.connection,
          testStatus: 'failed',
        },
      }
      this.replaceVm(failedVm)
      return { vm: failedVm, run }
    }

    const { values, processes, services } = parseRuntimeSections(run.stdout ?? '')
    const memoryTotalMb = Number(values.MEM_TOTAL_MB) || vm.resources.memoryGb * 1024
    const memoryUsedMb = Number(values.MEM_USED_MB) || Math.round((memoryTotalMb * vm.metrics.memoryPercent) / 100)
    const diskTotalKb = Number(values.DISK_TOTAL_KB) || vm.resources.diskGb * 1024 * 1024
    const diskUsedKb = Number(values.DISK_USED_KB) || Math.round((diskTotalKb * vm.metrics.diskPercent) / 100)
    const diskPercent = Number(String(values.DISK_PCT ?? '').replace('%', '')) || Math.round((diskUsedKb / diskTotalKb) * 100)
    const parsedLoadAverage = String(values.LOAD ?? '0,0,0')
      .split(',')
      .map((value) => Number(value))
      .slice(0, 3)
    const loadAverage: [number, number, number] = [
      parsedLoadAverage[0] ?? 0,
      parsedLoadAverage[1] ?? 0,
      parsedLoadAverage[2] ?? 0,
    ]

    // Sampled rates; absent keys (non-Linux host, mock without them) keep the prior value.
    const sampledNumber = (raw: string | undefined, fallback: number) => {
      const parsed = Number(raw)
      return raw !== undefined && Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
    }
    const cpuPercent = Math.round(sampledNumber(values.CPU_PCT, vm.metrics.cpuPercent))
    const memoryPercent = Math.round((memoryUsedMb / memoryTotalMb) * 100)

    // Live problem list derived from this sample; replaces any previous alerts wholesale.
    const alerts: string[] = []
    if (diskPercent >= vm.metrics.thresholds.diskWarning) {
      alerts.push(`Disk usage at ${diskPercent}% (warning threshold ${vm.metrics.thresholds.diskWarning}%)`)
    }
    if (memoryPercent >= vm.metrics.thresholds.memoryWarning) {
      alerts.push(`Memory usage at ${memoryPercent}% (warning threshold ${vm.metrics.thresholds.memoryWarning}%)`)
    }
    for (const service of services) {
      if (service.state !== 'running') {
        alerts.push(`Service ${service.name} is ${service.state}`)
      }
    }

    const updatedVm: VM = {
      ...vm,
      hostname: values.HOSTNAME || vm.hostname,
      os: values.OS || vm.os,
      health: alerts.length ? 'warning' : 'healthy',
      lifecycle: 'running',
      alerts: alerts.length ? alerts : ['No active alerts'],
      resources: {
        cpuCores: Number(values.CPUS) || vm.resources.cpuCores,
        memoryGb: Math.max(1, Math.round(memoryTotalMb / 1024)),
        diskGb: Math.max(1, Math.round(diskTotalKb / 1024 / 1024)),
      },
      metrics: {
        ...vm.metrics,
        cpuPercent,
        memoryPercent,
        networkInMbps: sampledNumber(values.NET_RX_MBPS, vm.metrics.networkInMbps),
        networkOutMbps: sampledNumber(values.NET_TX_MBPS, vm.metrics.networkOutMbps),
        diskPercent,
        loadAverage,
        uptime: values.UPTIME || vm.metrics.uptime,
        sampledAt: nowLabel(),
      },
      services,
      processes,
      connection: {
        ...vm.connection,
        lastConnected: nowLabel(),
        testStatus: 'passed',
      },
    }
    this.replaceVm(updatedVm)
    return { vm: updatedVm, run }
  }

  async runTerminalCommand(vmId: string, command: string) {
    const vm = this.requireVm(vmId)
    const classification = classifyCommand(command)
    const run = await this.ssh.executeCommand({
      vm,
      command,
      actor: 'user',
      mutating: classification.mutating,
    })
    if (run.status === 'completed') {
      this.markVmReachable(vmId)
    }
    this.addActivity(vmId, makeActivity(`Command ran: ${command}`, run.summary, run.status === 'failed' ? 'critical' : 'info'), 'user', {
      commandRunId: run.id,
    })
    return run
  }

  async rebootVm(vmId: string) {
    const vm = this.requireVm(vmId)
    const command = 'sudo reboot'
    const run = await this.ssh.executeCommand({
      vm,
      command,
      actor: 'user',
      mutating: true,
    })
    const updatedVm: VM = {
      ...vm,
      health: run.status === 'completed' ? 'warning' : 'critical',
      activity: [
        makeActivity('Reboot requested', run.summary, run.status === 'completed' ? 'success' : 'critical'),
        ...vm.activity,
      ],
    }
    this.replaceVm(updatedVm)
    return { vm: updatedVm, commandRun: run }
  }

  deleteVm(vmId: string) {
    this.requireVm(vmId)
    this.vmConfigs = this.vmConfigs.filter((config) => config.id !== vmId)
    this.persistInventory()
    this.vms = this.vms.filter((vm) => vm.id !== vmId)
    this.persistAppRunnerServices()
    this.publish({ type: 'vm.deleted', payload: { vmId } })
    return { vmId }
  }

  async createTransfer(input: {
    vmId: string
    direction: TransferJob['direction']
    source: string
    target: string
    fileName: string
    conflict?: TransferJob['conflict']
  }) {
    const vm = this.requireVm(input.vmId)
    const transfer: TransferJob = this.ssh.transferFile
      ? await this.ssh.transferFile({ vm, ...input })
      : {
          id: id('job'),
          vmId: input.vmId,
          direction: input.direction,
          source: input.source,
          target: input.target,
          fileName: input.fileName,
          status: 'in_progress',
          progress: input.conflict ? 56 : 64,
          speed: input.conflict
            ? input.conflict === 'overwrite'
              ? 'overwriting remote file'
              : `${input.conflict} remote file`
            : input.direction === 'download'
              ? '18.2 MB/s'
              : '12.4 MB/s',
          conflict: input.conflict,
        }
    this.transfers = [transfer, ...this.transfers]
    this.publish({ type: 'transfer.updated', payload: transfer })
    this.addActivity(
      input.vmId,
      makeActivity(input.direction === 'download' ? 'Download started' : 'Upload started', `${input.source} -> ${input.target}`),
      'user',
      { transferJobId: transfer.id },
    )
    return transfer
  }

  /**
   * Drive one copilot turn for a scope. The supervisor (kimi-code CLI) streams updates; we
   * translate them into events + journal entries. Mutating work the agent attempts arrives
   * back through the MCP tool host methods below, which gate and execute it.
   */
  async sendCopilotMessage(input: { scope: CopilotScope; message: string; referenceHistory?: boolean }) {
    const scope = input.scope
    const vmId = scopeVmId(scope)
    if (vmId) {
      // Warm the SSH connection while kimi boots and thinks, so the agent's first
      // command doesn't pay the TCP+handshake cost serially.
      void this.ssh.warmConnection?.(this.requireVm(vmId))
    }

    // Build the model-facing prompt before recording this turn, so referenced history reflects
    // only earlier turns. The displayed/stored user message stays the original text.
    const promptText = input.referenceHistory ? this.withReferencedHistory(scope, input.message) : input.message

    const userMessage: CopilotMessage = {
      id: id('msg-user'),
      role: 'user',
      content: input.message,
      timestamp: nowLabel(),
      scope,
      createdAt: this.nextStamp(),
      contextVmId: vmId,
    }
    this.appendMessage(userMessage)
    this.publishCopilotProgress(scope, { title: 'Queued copilot request', detail: scopeLabel(scope, this.vms), status: 'running' })

    const assistantId = id('msg-assistant')
    const assistant: CopilotMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: nowLabel(),
      scope,
      createdAt: this.nextStamp(),
      streaming: true,
      contextVmId: vmId,
    }
    this.messages = [...this.messages, assistant]
    this.publish({ type: 'copilot.message', payload: assistant })

    const turn: CopilotTurn = { scope, assistantId, text: '' }
    try {
      const result = await this.supervisor.prompt(scope, promptText, (update) =>
        this.applyDriverUpdate(turn, update),
      )
      turn.text = result.text?.trim() ? result.text : turn.text
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Copilot run failed.'
      turn.text = turn.text || `Copilot error: ${detail}`
      this.publishCopilotProgress(scope, { title: 'Copilot request failed', detail, status: 'failed' })
    }
    this.closeThought(turn)

    const extracted = extractOpenUiArtifact(turn.text || 'No response produced.')
    const finalAssistant: CopilotMessage = {
      ...assistant,
      content: extracted.content,
      openUi: extracted.openUi,
      createdAt: turn.textStartedAt ?? this.nextStamp(),
      streaming: false,
      timestamp: nowLabel(),
    }
    this.messages = this.messages.map((message) => (message.id === assistantId ? finalAssistant : message))
    this.journal.recordMessage(scope, finalAssistant)
    this.publish({ type: 'copilot.message', payload: finalAssistant })
    this.publishCopilotProgress(scope, { title: 'Copilot response ready', status: 'completed' })

    return { messages: [userMessage, finalAssistant], proposals: this.proposals.filter((proposal) => proposal.scope === scope) }
  }

  /**
   * Prepend a bounded slice of this scope's recorded execution history to the model prompt, so a
   * stateless turn can still reference earlier work when the user opts in. Same source as the
   * get_history tool ({@link CopilotJournal.history}); returns the message unchanged when empty.
   */
  private withReferencedHistory(scope: CopilotScope, message: string): string {
    const entries = this.journal.history(scope, { limit: HISTORY_REFERENCE_LIMIT })
    if (!entries.length) {
      return message
    }
    return [
      'Reference — recent operation history for this scope (most recent first):',
      entries.map((entry) => `- ${entry}`).join('\n'),
      '',
      'Use it for continuity; it may be stale, so verify with tools before acting.',
      '',
      '---',
      '',
      message,
    ].join('\n')
  }

  cancelCopilot(scope: CopilotScope) {
    this.supervisor.cancel(scope)
    // Release tool calls paused on confirmation: the agent is going away, and a stuck
    // awaiting card would hold the scope's confirmation queue until its timeout.
    for (const [proposalId, pending] of [...this.pendingPermissions]) {
      const proposal = this.proposals.find((item) => item.id === proposalId)
      if (!proposal || (proposal.scope ?? vmScope(proposal.vmId)) !== scope) {
        continue
      }
      clearTimeout(pending.timer)
      this.pendingPermissions.delete(proposalId)
      this.updateProposal({ ...proposal, status: 'dismissed', result: 'Cancelled.' })
      pending.resolve('deny')
    }
    this.publishCopilotProgress(scope, { title: 'Cancellation requested', status: 'failed' })
    return { scope }
  }

  createCopilotProposal(input: { vmId: string; activeTab: TabId; actionType: ActionProposal['actionType'] }) {
    const vm = this.requireVm(input.vmId)
    const proposal = proposalFor(input.actionType, vm, input.activeTab, this.vms)
    this.addProposal(proposal)
    return proposal
  }

  /**
   * Resolve a proposal. For MCP-gated proposals (a mutating command the agent paused on)
   * this releases the awaiting tool call. For suggestion-button proposals it executes the
   * command directly. `always_allow` records a narrow policy rule.
   */
  async decideProposal(proposalId: string, decision: CopilotPermissionDecision) {
    const proposal = this.proposals.find((item) => item.id === proposalId)
    if (!proposal) {
      throw new Error('Proposal not found')
    }

    const pending = this.pendingPermissions.get(proposalId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingPermissions.delete(proposalId)
      this.updateProposal({ ...proposal, decision, status: decision === 'deny' ? 'dismissed' : proposal.status })
      pending.resolve(decision)
      return { proposal: this.proposals.find((item) => item.id === proposalId) ?? proposal }
    }

    // Legacy suggestion-button proposal: execute (or dismiss) immediately.
    if (decision === 'deny') {
      const dismissed: ActionProposal = { ...proposal, status: 'dismissed', decision, result: 'Dismissed by user.' }
      this.updateProposal(dismissed)
      return { proposal: dismissed }
    }
    if (decision === 'always_allow') {
      this.policy.remember(proposal.scope ?? vmScope(proposal.vmId), proposal.command)
    }
    // Record and broadcast the decision before executing: the SSH run can take a while and
    // every client should see the card switch to its executing state immediately.
    const decided: ActionProposal = { ...proposal, decision }
    this.updateProposal(decided)
    return this.runLegacyProposal(decided)
  }

  // -- CopilotToolHost: backend capabilities exposed to the agent through scoped MCP tools.

  async runScopedCommand(input: { scope: CopilotScope; vmId: string; command: string; reason: string }): Promise<ToolResult> {
    const vm = this.getVm(input.vmId)
    if (!vm) {
      return { ok: false, summary: 'VM not found.', error: `Unknown VM ${input.vmId}.` }
    }

    const toolCall = this.startToolCall(input.scope, 'run_command', commandKind(input.command), vm.id, input.command)

    if (isReadOnlyCommand(input.command)) {
      const run = await this.ssh.executeCommand({ vm, command: input.command, actor: 'copilot', mutating: false })
      this.recordCommandActivity(vm.id, 'Copilot inspection', run)
      this.finishToolCall(toolCall, run.status === 'completed' ? 'completed' : 'failed', commandOutput(run), commandConsoleDump(run))
      return toolResultFromRun(run, input.reason)
    }

    if (this.policy.allows(input.scope, input.command)) {
      return this.executeGatedCommand({ scope: input.scope, vm, command: input.command, reason: input.reason, toolCall })
    }

    const confirmation = await this.requestConfirmation(input.scope, input.command, () =>
      this.permissionProposal(input.scope, vm, input.command, input.reason, toolCall.id),
    )

    if (confirmation.decision === 'deny') {
      this.finishToolCall(toolCall, 'failed', 'User declined the command.')
      return { ok: false, summary: 'User declined this command.', error: 'declined' }
    }
    return this.executeGatedCommand({
      scope: input.scope,
      vm,
      command: input.command,
      reason: input.reason,
      toolCall,
      proposalId: confirmation.proposalId,
    })
  }

  /**
   * Surface a confirmation card and block until the user decides, holding the per-scope
   * confirmation slot. Queued callers re-check policy once they reach the head: an earlier
   * card may have granted always-allow for the same command, in which case no card is shown.
   */
  private async requestConfirmation(
    scope: CopilotScope,
    command: string,
    makeProposal: () => ActionProposal,
  ): Promise<{ decision: CopilotPermissionDecision; proposalId?: string }> {
    return this.confirmationLock.run(
      scope,
      async () => {
        if (this.policy.allows(scope, command)) {
          return { decision: 'allow_once' }
        }
        const proposal = makeProposal()
        this.addProposal(proposal)
        this.publishCopilotProgress(scope, { title: 'Awaiting confirmation', detail: command, status: 'running' })
        const decision = await this.awaitDecision(proposal.id)
        if (decision === 'deny') {
          // Cancellation and timeout record their own outcome before resolving deny.
          const current = this.currentProposal(proposal)
          if (!current.result) {
            this.updateProposal({ ...current, status: 'dismissed', result: 'Declined by user.' })
          }
        } else if (decision === 'always_allow') {
          // Remember inside the slot so the next queued identical command skips its card.
          this.policy.remember(scope, command)
        }
        return { decision, proposalId: proposal.id }
      },
      () => this.publishCopilotProgress(scope, { title: 'Queued for confirmation', detail: command, status: 'running' }),
    )
  }

  async readRemoteLogs(input: { vmId: string; unit?: string; grep?: string; lines: number }): Promise<ToolResult> {
    const lines = Math.min(Math.max(input.lines, 1), 1000)
    const base = input.unit
      ? `journalctl -u ${shellQuote(input.unit)} -n ${lines} --no-pager`
      : `journalctl -n ${lines} --no-pager`
    const command = input.grep ? `${base} | grep -i ${shellQuote(input.grep)}` : base
    return this.runScopedCommand({ scope: vmScope(input.vmId), vmId: input.vmId, command, reason: 'Read logs' })
  }

  async serviceStatus(input: { vmId: string; name: string }): Promise<ToolResult> {
    const command = `systemctl status ${shellQuote(input.name)} --no-pager`
    return this.runScopedCommand({ scope: vmScope(input.vmId), vmId: input.vmId, command, reason: 'Service status' })
  }

  async listRemoteFiles(input: { vmId: string; path: string }): Promise<ToolResult> {
    const vm = this.getVm(input.vmId)
    if (!vm) {
      return { ok: false, summary: 'VM not found.', error: `Unknown VM ${input.vmId}.` }
    }
    const toolCall = this.startToolCall(vmScope(vm.id), 'list_files', 'read', vm.id, input.path)
    try {
      const files = await this.ssh.listFiles(vm, input.path)
      this.finishToolCall(toolCall, 'completed', `${files.length} items`)
      return {
        ok: true,
        summary: `Listed ${files.length} item${files.length === 1 ? '' : 's'} at ${input.path}.`,
        data: files.slice(0, 80).map((file) => ({ name: file.name, type: file.type, size: file.size })),
      }
    } catch (error) {
      this.finishToolCall(toolCall, 'failed', error instanceof Error ? error.message : 'SFTP failed.')
      return { ok: false, summary: 'SFTP listing failed.', error: error instanceof Error ? error.message : 'SFTP failed.' }
    }
  }

  /**
   * Composite inspection for the agent: one SSH exec refreshes metrics, services, and top
   * processes (reusing the UI refresh path, so the VM card updates as a side effect).
   */
  async inspectVm(input: { scope: CopilotScope; vmId: string }): Promise<ToolResult> {
    const existing = this.getVm(input.vmId)
    if (!existing) {
      return { ok: false, summary: 'VM not found.', error: `Unknown VM ${input.vmId}.` }
    }

    const toolCall = this.startToolCall(input.scope, 'inspect_vm', 'read', existing.id, 'Live metrics, services, and processes (one SSH round-trip)')
    const { vm, run } = await this.sampleVmInfo(existing.id)
    if (vm.connection.testStatus === 'failed') {
      this.finishToolCall(toolCall, 'failed', 'SSH inspection failed; the VM is unreachable.', commandConsoleDump(run))
      return { ok: false, summary: `${vm.name} is unreachable over SSH.`, error: 'SSH inspection failed.' }
    }

    const degraded = vm.services.filter((service) => service.state !== 'running').length
    const summary = `${vm.name}: load ${vm.metrics.loadAverage[0]}, mem ${vm.metrics.memoryPercent}%, disk ${vm.metrics.diskPercent}%, ${vm.services.length} services (${degraded} not running).`
    this.finishToolCall(toolCall, 'completed', summary, commandConsoleDump(run))
    return {
      ok: true,
      summary,
      data: {
        hostname: vm.hostname,
        os: vm.os,
        lifecycle: vm.lifecycle,
        health: vm.health,
        metrics: vm.metrics,
        services: vm.services,
        processes: vm.processes.slice(0, 8),
        alerts: vm.alerts,
      },
    }
  }

  /** Composite unit diagnosis: systemctl status + recent journal + listening ports, one exec. */
  async diagnoseService(input: { scope: CopilotScope; vmId: string; unit: string; lines: number }): Promise<ToolResult> {
    const vm = this.getVm(input.vmId)
    if (!vm) {
      return { ok: false, summary: 'VM not found.', error: `Unknown VM ${input.vmId}.` }
    }
    const unit = input.unit.trim()
    if (!unit) {
      return { ok: false, summary: 'A unit name is required.', error: 'Missing unit.' }
    }

    const lines = Math.min(Math.max(input.lines, 1), 400)
    const toolCall = this.startToolCall(input.scope, 'diagnose_service', 'read', vm.id, `Status, ${lines} log lines, and ports for ${unit}`)
    const run = await this.ssh.executeCommand({ vm, command: diagnoseServiceCommand(unit, lines), actor: 'copilot', mutating: false })
    if (run.status === 'failed') {
      this.recordCommandActivity(vm.id, 'Copilot inspection', run)
      this.finishToolCall(toolCall, 'failed', commandOutput(run), commandConsoleDump(run))
      return { ok: false, summary: `Could not diagnose ${unit}: ${run.summary}`, error: run.stderr || run.summary }
    }

    const [, afterStatus = ''] = (run.stdout ?? '').split(unitStatusMarker)
    const [statusText = '', afterLogs = ''] = afterStatus.split(unitLogsMarker)
    const [logsText = '', portsText = ''] = afterLogs.split(unitPortsMarker)
    const status = statusText.trim()
    const statusLine = status.split('\n')[0] ?? ''
    const logLines = logsText.trim() ? logsText.trim().split('\n').length : 0
    const ports = portsText.trim()

    const summary = `${unit}: ${compactLine(statusLine, 160) || 'no status output'}; ${logLines} log line${logLines === 1 ? '' : 's'}${ports ? '; listening sockets found' : ''}.`
    this.recordCommandActivity(vm.id, 'Copilot inspection', run)
    this.finishToolCall(toolCall, 'completed', summary, commandConsoleDump(run))
    return {
      ok: true,
      summary,
      data: {
        status: clipBlock(status, 4000, 60),
        logs: clipBlock(logsText.trim(), 5000, 120),
        ports: clipBlock(ports, 1500, 30),
      },
    }
  }

  /**
   * Run one command on many VMs with bounded parallelism (default 4, GROVE_FLEET_CONCURRENCY
   * to override). Per-VM mutation locks still serialize writes on each machine; results come
   * back in target order regardless of completion order.
   */
  private async fanOutCommand(input: {
    targets: VM[]
    command: string
    scope?: CopilotScope
    proposalId?: string
    activityLabel: string
  }): Promise<CommandRun[]> {
    const { targets, command, scope, proposalId, activityLabel } = input
    const concurrency = Math.max(1, Number(envValue('GROVE_FLEET_CONCURRENCY')) || 4)
    const runs: CommandRun[] = new Array(targets.length)
    let nextIndex = 0

    const worker = async () => {
      while (nextIndex < targets.length) {
        const index = nextIndex
        nextIndex += 1
        const target = targets[index]
        try {
          runs[index] = await this.mutationLock.run(
            target.id,
            () => this.ssh.executeCommand({ vm: target, command, actor: 'copilot', mutating: true }),
            scope
              ? () => this.publishCopilotProgress(scope, { title: `Queued behind work on ${target.name}`, status: 'running' })
              : undefined,
          )
        } catch (error) {
          // executeCommand resolves failed runs rather than rejecting; this is a backstop.
          const message = error instanceof Error ? error.message : 'Command failed.'
          const timestamp = new Date().toISOString()
          runs[index] = {
            id: id('cmd'),
            vmId: target.id,
            actor: 'copilot',
            command,
            status: 'failed',
            startedAt: timestamp,
            completedAt: timestamp,
            stderr: message,
            summary: message,
            mutating: true,
          }
        }
        this.recordCommandActivity(target.id, `${activityLabel} ${runs[index].status}`, runs[index], proposalId)
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()))
    return runs
  }

  async fleetRunCommand(input: { scope: CopilotScope; command: string; reason: string; targetVmIds?: string[] }): Promise<ToolResult> {
    const targets = (input.targetVmIds?.length
      ? input.targetVmIds.map((vmId) => this.getVm(vmId)).filter((vm): vm is VM => Boolean(vm))
      : runningVms(this.vms))
    if (!targets.length) {
      return { ok: false, summary: 'No target VMs available.', error: 'No running VMs.' }
    }

    const toolCall = this.startToolCall(input.scope, 'fleet_run_command', commandKind(input.command), undefined, input.command)
    const confirmation = await this.requestConfirmation(input.scope, input.command, () =>
      this.fleetPermissionProposal(input.scope, targets, input.command, input.reason, toolCall.id),
    )

    if (confirmation.decision === 'deny') {
      this.finishToolCall(toolCall, 'failed', 'User declined the fleet command.')
      return { ok: false, summary: 'User declined this fleet command.', error: 'declined' }
    }

    const runs = await this.fanOutCommand({
      targets,
      command: input.command,
      scope: input.scope,
      proposalId: confirmation.proposalId,
      activityLabel: 'Fleet command',
    })
    const completed = runs.filter((run) => run.status === 'completed').length
    const results = runs.map((run, index) => `${targets[index].name}: ${run.status} - ${run.summary}`)

    const summary = `Fleet command ran on ${targets.length} VM${targets.length === 1 ? '' : 's'}; ${completed} succeeded.`
    const proposal = confirmation.proposalId
      ? this.proposals.find((item) => item.id === confirmation.proposalId)
      : undefined
    if (proposal) {
      this.updateProposal({ ...proposal, status: 'executed', result: [summary, ...results].join('\n') })
    }
    this.finishToolCall(toolCall, completed ? 'completed' : 'failed', summary, fleetConsoleDump(runs, targets))
    return { ok: completed > 0, summary, data: results }
  }

  recordNote(input: { scope: CopilotScope; content: string }): ToolResult {
    this.supervisor.appendNote(input.scope, input.content)
    return { ok: true, summary: 'Saved a durable note for this scope.' }
  }

  getHistory(input: { scope: CopilotScope; query?: string; limit?: number }): ToolResult {
    const entries = this.journal.history(input.scope, { query: input.query, limit: input.limit })
    return { ok: true, summary: `Found ${entries.length} history entr${entries.length === 1 ? 'y' : 'ies'}.`, data: entries }
  }

  /**
   * Translate one streamed driver update into timeline state + events. Everything the agent
   * does is surfaced as a first-class timeline item — thought blocks, its own tool
   * executions, and plan checklists — not flattened into transient progress blips.
   */
  private applyDriverUpdate(turn: CopilotTurn, update: DriverUpdate) {
    const scope = turn.scope
    if (update.type === 'message_delta') {
      this.closeThought(turn)
      turn.text += update.text
      if (!turn.textStartedAt) {
        // First token: re-anchor the message and re-publish it whole. No deltas have been
        // sent yet, so the client cannot double-append this chunk.
        turn.textStartedAt = this.nextStamp()
        this.messages = this.messages.map((message) =>
          message.id === turn.assistantId ? { ...message, content: turn.text, createdAt: turn.textStartedAt } : message,
        )
        const anchored = this.messages.find((message) => message.id === turn.assistantId)
        if (anchored) {
          this.publish({ type: 'copilot.message', payload: anchored })
        }
        return
      }
      this.messages = this.messages.map((message) =>
        message.id === turn.assistantId ? { ...message, content: turn.text } : message,
      )
      this.publish({ type: 'copilot.delta', payload: { scope, messageId: turn.assistantId, delta: update.text } })
      return
    }
    if (update.type === 'thought') {
      this.appendThought(turn, update.text)
      return
    }
    if (update.type === 'tool_call') {
      this.closeThought(turn)
      this.applyAgentToolCall(turn, update)
      this.publishCopilotProgress(scope, {
        title: update.title,
        detail: update.detail ? compactLine(update.detail) : update.status,
        status: 'running',
      })
      return
    }
    if (update.type === 'plan') {
      this.closeThought(turn)
      this.applyPlanUpdate(turn, update.entries)
      return
    }
    this.publishCopilotProgress(scope, { title: update.title, detail: update.detail, status: 'running' })
  }

  /** Stream a thought chunk into the turn's open think-block timeline item. */
  private appendThought(turn: CopilotTurn, text: string) {
    const now = Date.now()
    if (!turn.thought) {
      const block: CopilotToolCall = {
        id: id('toolcall'),
        scope: turn.scope,
        title: 'Thinking',
        kind: 'think',
        status: 'running',
        origin: 'agent',
        output: '',
        createdAt: this.nextStamp(),
        updatedAt: now,
      }
      turn.thought = block
      this.toolCalls = [...this.toolCalls, block]
    }
    turn.thought = { ...turn.thought, output: clipBlock(`${turn.thought.output ?? ''}${text}`), updatedAt: now }
    this.toolCalls = this.toolCalls.map((item) => (item.id === turn.thought!.id ? turn.thought! : item))
    this.publish({ type: 'copilot.toolcall.updated', payload: turn.thought })
  }

  /** Finalize the open thought block; journaled once here rather than per streamed chunk. */
  private closeThought(turn: CopilotTurn) {
    const open = turn.thought
    if (!open) {
      return
    }
    turn.thought = undefined
    const closed: CopilotToolCall = { ...open, status: 'completed', updatedAt: Date.now() }
    this.toolCalls = this.toolCalls.map((item) => (item.id === closed.id ? closed : item))
    this.journal.recordToolCall(closed.scope, closed)
    this.publish({ type: 'copilot.toolcall.updated', payload: closed })
  }

  /** Surface a tool execution the agent reported (built-in shell/file/web tools, MCP reads). */
  private applyAgentToolCall(turn: CopilotTurn, update: Extract<DriverUpdate, { type: 'tool_call' }>) {
    if (GROVE_INSTRUMENTED_TOOLS.has(agentToolName(update.title))) {
      return
    }
    const scope = turn.scope
    // Scope the id to the turn: kimi numbers its tool calls per process and the print driver
    // spawns a fresh kimi each turn, so a bare `update.id` (or its tool-name fallback) would
    // collide across turns — the new card would overwrite an old one and inherit its stale
    // position. The per-turn assistantId makes each turn's tool calls distinct.
    const toolCallId = `agent-${turn.assistantId}-${update.id}`
    const existing = this.toolCalls.find((item) => item.id === toolCallId)
    const next: CopilotToolCall = {
      id: toolCallId,
      scope,
      title: update.title || existing?.title || 'tool',
      kind: update.kind ?? existing?.kind ?? 'other',
      status: update.status,
      origin: 'agent',
      detail: update.detail ? clipBlock(update.detail, 600, 12) : existing?.detail,
      output: update.output ? clipBlock(update.output) : existing?.output,
      createdAt: existing?.createdAt ?? this.nextStamp(),
      updatedAt: Date.now(),
    }
    this.toolCalls = existing
      ? this.toolCalls.map((item) => (item.id === toolCallId ? next : item))
      : [...this.toolCalls, next]
    this.journal.recordToolCall(scope, next)
    this.publish({ type: 'copilot.toolcall.updated', payload: next })
  }

  /** Upsert this turn's plan checklist; it ticks off in place as the agent progresses. */
  private applyPlanUpdate(turn: CopilotTurn, entries: Array<{ title: string; status: string }>) {
    if (!turn.planId) {
      turn.planId = `plan-${turn.assistantId}`
    }
    const existing = this.plans.find((plan) => plan.id === turn.planId)
    const next: CopilotPlanState = {
      id: turn.planId,
      scope: turn.scope,
      entries: entries
        .filter((entry) => entry.title.trim())
        .map((entry) => ({ title: entry.title, status: toPlanEntryStatus(entry.status) })),
      createdAt: existing?.createdAt ?? this.nextStamp(),
      updatedAt: Date.now(),
    }
    this.plans = existing ? this.plans.map((plan) => (plan.id === next.id ? next : plan)) : [...this.plans, next]
    this.journal.recordPlan(turn.scope, next)
    this.publish({ type: 'copilot.plan', payload: next })
  }

  private appendMessage(message: CopilotMessage) {
    this.messages = [...this.messages, message]
    if (message.scope) {
      this.journal.recordMessage(message.scope, message)
    }
    this.publish({ type: 'copilot.message', payload: message })
  }

  private startToolCall(
    scope: CopilotScope,
    title: string,
    kind: CopilotToolCall['kind'],
    vmId: string | undefined,
    detail: string,
  ): CopilotToolCall {
    const toolCall: CopilotToolCall = {
      id: id('toolcall'),
      scope,
      title,
      kind,
      status: 'running',
      vmId,
      detail: compactLine(detail, 240),
      createdAt: this.nextStamp(),
      updatedAt: Date.now(),
    }
    this.toolCalls = [...this.toolCalls, toolCall]
    this.journal.recordToolCall(scope, toolCall)
    this.publish({ type: 'copilot.toolcall.updated', payload: toolCall })
    return toolCall
  }

  private finishToolCall(
    toolCall: CopilotToolCall,
    status: CopilotToolCall['status'],
    output?: string,
    consoleLog?: string,
  ) {
    const updated: CopilotToolCall = {
      ...toolCall,
      status,
      // Line structure is preserved: the timeline renders output as a terminal block.
      output: output ? clipBlock(output) : toolCall.output,
      consoleLog: consoleLog ?? toolCall.consoleLog,
      updatedAt: Date.now(),
    }
    this.toolCalls = this.toolCalls.map((item) => (item.id === toolCall.id ? updated : item))
    this.journal.recordToolCall(toolCall.scope, updated)
    this.publish({ type: 'copilot.toolcall.updated', payload: updated })
  }

  private addProposal(proposal: ActionProposal) {
    this.proposals = [proposal, ...this.proposals]
    if (proposal.scope) {
      this.journal.recordProposal(proposal.scope, proposal)
    }
    this.publish({ type: 'copilot.proposal.updated', payload: proposal })
  }

  private updateProposal(proposal: ActionProposal) {
    this.proposals = this.proposals.map((item) => (item.id === proposal.id ? proposal : item))
    if (proposal.scope) {
      this.journal.recordProposal(proposal.scope, proposal)
    }
    this.publish({ type: 'copilot.proposal.updated', payload: proposal })
  }

  private currentProposal(proposal: ActionProposal) {
    return this.proposals.find((item) => item.id === proposal.id) ?? proposal
  }

  /** Block a gated tool call until the user decides, or auto-deny after a timeout. */
  private awaitDecision(proposalId: string): Promise<CopilotPermissionDecision> {
    return new Promise<CopilotPermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(proposalId)
        const proposal = this.proposals.find((item) => item.id === proposalId)
        if (proposal && proposal.status === 'awaiting_confirmation') {
          this.updateProposal({ ...proposal, status: 'dismissed', result: 'No response; timed out.' })
        }
        resolve('deny')
      }, PERMISSION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      this.pendingPermissions.set(proposalId, { resolve, timer })
    })
  }

  private permissionProposal(
    scope: CopilotScope,
    vm: VM,
    command: string,
    reason: string,
    toolCallId: string,
  ): ActionProposal {
    const classification = classifyCommand(command)
    return {
      id: id('proposal'),
      vmId: vm.id,
      scope,
      targetVmIds: [vm.id],
      title: `Run on ${vm.name}`,
      description: reason,
      command,
      actionType: 'custom_command',
      risk: classification.mutating ? 'medium' : 'low',
      status: 'awaiting_confirmation',
      toolCallId,
      createdAt: Date.now(),
    }
  }

  private fleetPermissionProposal(
    scope: CopilotScope,
    targets: VM[],
    command: string,
    reason: string,
    toolCallId: string,
  ): ActionProposal {
    return {
      id: id('proposal'),
      vmId: targets[0].id,
      scope,
      targetVmIds: targets.map((vm) => vm.id),
      title: `Run on ${targets.length} VM${targets.length === 1 ? '' : 's'}`,
      description: `${reason} Targets: ${targets.map((vm) => vm.name).join(', ')}.`,
      command,
      actionType: 'patch_vms',
      risk: 'high',
      status: 'awaiting_confirmation',
      toolCallId,
      createdAt: Date.now(),
    }
  }

  private async executeGatedCommand(input: {
    scope: CopilotScope
    vm: VM
    command: string
    reason: string
    toolCall: CopilotToolCall
    proposalId?: string
  }): Promise<ToolResult> {
    const run = await this.mutationLock.run(
      input.vm.id,
      () => this.ssh.executeCommand({ vm: input.vm, command: input.command, actor: 'copilot', mutating: true }),
      () => this.publishCopilotProgress(input.scope, { title: `Queued behind work on ${input.vm.name}`, status: 'running' }),
    )
    this.recordCommandActivity(input.vm.id, 'Copilot action', run, input.proposalId)
    this.finishToolCall(input.toolCall, run.status === 'completed' ? 'completed' : 'failed', commandOutput(run), commandConsoleDump(run))
    if (input.proposalId) {
      const proposal = this.proposals.find((item) => item.id === input.proposalId)
      if (proposal) {
        this.updateProposal({
          ...proposal,
          status: run.status === 'completed' ? 'executed' : 'dismissed',
          result: run.status === 'completed' ? run.summary : run.stderr || run.summary,
        })
      }
    }
    return toolResultFromRun(run, input.reason)
  }

  private recordCommandActivity(vmId: string, title: string, run: CommandRun, proposalId?: string) {
    this.addActivity(
      vmId,
      makeActivity(title, run.summary, run.status === 'failed' ? 'critical' : 'success'),
      'copilot',
      { commandRunId: run.id, proposalId },
    )
  }

  /** Execute a suggestion-button proposal (patch_vms or a single command) on confirmation. */
  private async runLegacyProposal(proposal: ActionProposal) {
    if (proposal.actionType === 'patch_vms') {
      const targets = runningVms(this.vms)
      const runs = await this.fanOutCommand({
        targets,
        command: proposal.command,
        proposalId: proposal.id,
        activityLabel: 'Fleet patch',
      })
      const completed = runs.filter((run) => run.status === 'completed').length
      const results = runs.map((run, index) => `${targets[index].name}: ${run.status} - ${run.summary}`)
      const summary = targets.length
        ? `Fleet patch attempted on ${targets.length} VM${targets.length === 1 ? '' : 's'}; ${completed} succeeded.`
        : 'No running VMs were available for patching.'
      const updated: ActionProposal = {
        ...proposal,
        status: targets.length ? 'executed' : 'dismissed',
        result: [summary, ...results].join('\n'),
      }
      this.updateProposal(updated)
      return { proposal: updated }
    }

    const vm = this.requireVm(proposal.vmId)
    const classification = classifyCommand(proposal.command)
    const run = await this.mutationLock.run(vm.id, () =>
      this.ssh.executeCommand({ vm, command: proposal.command, actor: 'copilot', mutating: classification.mutating }),
    )
    const updated: ActionProposal = {
      ...proposal,
      status: run.status === 'completed' ? 'executed' : 'dismissed',
      result: proposal.actionType === 'custom_command' ? run.stdout || run.stderr || run.summary : run.summary,
    }
    this.updateProposal(updated)
    this.recordCommandActivity(vm.id, proposal.title, run, proposal.id)
    return { proposal: updated }
  }

  async openTerminal(vmId: string) {
    const vm = this.requireVm(vmId)
    const session = await this.ssh.openTerminal(vm)
    if (session.status === 'open') {
      this.markVmReachable(vmId)
    }
    return session
  }

  async openTerminalShell(vmId: string, options: { cols: number; rows: number }) {
    const vm = this.requireVm(vmId)
    if (!this.ssh.openTerminalShell) {
      throw new Error('Interactive terminal shell is unavailable.')
    }

    const shell = await this.ssh.openTerminalShell(vm, options)
    if (shell.session.status === 'open') {
      this.markVmReachable(vmId)
    }
    return shell
  }

  private async deployAppRunnerService(vm: VM, input: AppRunnerServiceInput, service: AppRunnerService) {
    const home = await this.resolveRemoteHome(vm)
    const stagePath = `${home}/services/.grove-stage-${service.name}-${Date.now()}`
    const targetPath = `${home}/services/${service.name}`
    let copiedFiles: number | undefined

    if (input.source.type === 'local') {
      if (!this.ssh.uploadDirectory) {
        throw new Error('This SSH adapter cannot upload local project folders.')
      }

      const prepareRun = await this.ssh.executeCommand({
        vm,
        command: appRunnerPrepareLocalStageCommand(stagePath),
        actor: 'user',
        mutating: true,
      })
      if (prepareRun.status === 'failed') {
        throw new Error(prepareRun.stderr || prepareRun.summary)
      }

      const upload = await this.ssh.uploadDirectory({
        vm,
        sourcePath: input.source.path,
        targetPath: stagePath,
      })
      copiedFiles = upload.fileCount
    }

    const unitText = buildSystemdUnit(vm, service, targetPath)
    const deployRun = await this.ssh.executeCommand({
      vm,
      command: appRunnerDeployCommand(input, service, stagePath, targetPath, unitText),
      actor: 'user',
      mutating: true,
    })
    if (deployRun.status === 'failed') {
      throw new Error(deployRun.stderr || deployRun.summary)
    }

    const summary =
      typeof copiedFiles === 'number'
        ? `Uploaded ${copiedFiles} file${copiedFiles === 1 ? '' : 's'} and enabled ${service.unitName}.`
        : `Cloned ${input.source.type === 'github' ? input.source.repoUrl : 'source'} and enabled ${service.unitName}.`
    const deployedService: AppRunnerService = {
      ...service,
      updatedAt: new Date().toISOString(),
      lastDeployStatus: 'completed',
      lastDeploySummary: summary,
    }
    const status = await this.collectAppRunnerStatus(
      {
        ...vm,
        appServices: [
          ...vm.appServices.filter((item) => item.name !== service.name),
          deployedService,
        ],
      },
      deployedService,
    )

    return {
      ...status,
      lastDeploySummary: status.listening
        ? `Service enabled and listening on port ${status.port}.`
        : status.lastDeploySummary,
    }
  }

  private async resolveRemoteHome(vm: VM) {
    const run = await this.ssh.executeCommand({
      vm,
      command: remoteHomeCommand(),
      actor: 'system',
      mutating: false,
    })
    if (run.status === 'failed') {
      throw new Error(run.stderr || run.summary)
    }

    const home = (run.stdout ?? '').split(appRunnerHomeMarker)[1]?.trim().split(/\r?\n/)[0]?.trim()
    if (!home?.startsWith('/')) {
      throw new Error('Could not resolve remote home directory.')
    }

    return home.replace(/\/$/, '')
  }

  private async collectAppRunnerStatus(vm: VM, service: AppRunnerService): Promise<AppRunnerService> {
    const run = await this.ssh.executeCommand({
      vm,
      command: appRunnerStatusCommand(service),
      actor: 'system',
      mutating: false,
    })
    if (run.status === 'failed') {
      return {
        ...service,
        state: 'unknown',
        pid: undefined,
        cpuPercent: 0,
        memoryMb: 0,
        listening: false,
      }
    }

    const statusText = (run.stdout ?? '').split(appRunnerStatusMarker)[1] ?? ''
    const values = parseKeyValueOutput(statusText)
    const pid = Number(values.pid)
    const rssKb = Number(values.rss)
    return {
      ...service,
      state: appRunnerStateFromSystemd(String(values.state ?? 'unknown')),
      pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      cpuPercent: roundPercent(Number(values.cpu) || 0),
      memoryMb: Math.round((Number.isFinite(rssKb) ? rssKb : 0) / 1024),
      listening: values.listening === '1',
    }
  }

  private assertUniqueAppRunnerService(vm: VM, input: AppRunnerServiceInput, selfName?: string) {
    const duplicateName = vm.appServices.find((service) => service.name !== selfName && service.name === input.name)
    if (duplicateName) {
      throw new Error(`AppRunner service ${input.name} already exists on ${vm.name}.`)
    }

    const duplicatePort = vm.appServices.find((service) => service.name !== selfName && service.port === input.port)
    if (duplicatePort) {
      throw new Error(`Port ${input.port} is already assigned to ${duplicatePort.name}.`)
    }
  }

  private requireAppRunnerService(vm: VM, serviceName: string) {
    const service = vm.appServices.find((item) => item.name === serviceName)
    if (!service) {
      throw new Error('AppRunner service not found')
    }
    return service
  }

  private upsertAppRunnerService(vmId: string, service: AppRunnerService) {
    const vm = this.requireVm(vmId)
    const appServices = vm.appServices.some((item) => item.name === service.name)
      ? vm.appServices.map((item) => (item.name === service.name ? service : item))
      : [service, ...vm.appServices]
    this.replaceVm({ ...vm, appServices })
    this.persistAppRunnerServices()
  }

  private requireVm(vmId: string) {
    const vm = this.getVm(vmId)
    if (!vm) {
      throw new Error('VM not found')
    }
    return vm
  }

  private assertUniqueEndpoint(config: VmConfig, selfId?: string) {
    const duplicate = this.vmConfigs.find(
      (item) => item.id !== selfId && item.host === config.host && item.port === config.port,
    )
    if (duplicate) {
      throw new Error(`VM ${duplicate.name} already uses ${config.host}:${config.port}`)
    }
  }

  private markVmReachable(vmId: string) {
    const vm = this.requireVm(vmId)
    const alerts = vm.alerts.filter((alert) => alert !== 'Connection profile has not been tested yet')
    const updatedVm: VM = {
      ...vm,
      health: vm.health === 'critical' || vm.health === 'offline' ? 'healthy' : vm.health,
      lifecycle: 'running',
      alerts: alerts.length ? alerts : ['No active alerts'],
      connection: {
        ...vm.connection,
        lastConnected: nowLabel(),
        testStatus: 'passed',
      },
    }
    this.replaceVm(updatedVm)
    return updatedVm
  }

  private persistInventory() {
    if (envFlag('GROVE_USE_FIXTURES')) {
      return
    }

    saveInventory(this.vmConfigs)
  }

  private persistAppRunnerServices() {
    if (envFlag('GROVE_USE_FIXTURES')) {
      return
    }

    saveAppRunnerServices(this.vms.flatMap((vm) => vm.appServices))
  }

  private replaceVm(updatedVm: VM) {
    this.vms = this.vms.map((vm) => (vm.id === updatedVm.id ? updatedVm : vm))
    this.publish({ type: 'vm.updated', payload: updatedVm })
  }

  private addActivity(
    vmId: string,
    activity: ActivityEvent,
    actor: AuditEvent['actor'] = 'system',
    links: Pick<AuditEvent, 'commandRunId' | 'proposalId' | 'transferJobId'> = {},
  ) {
    const vm = this.requireVm(vmId)
    const updatedVm = {
      ...vm,
      activity: [activity, ...vm.activity],
    }
    this.replaceVm(updatedVm)
    this.publish({
      type: 'activity.created',
      payload: {
        ...activity,
        vmId,
        actor,
        ...links,
      },
    })
  }

  private publish(event: ServerEvent) {
    this.events.emit('event', event)
  }

  private publishCopilotProgress(
    scope: CopilotScope,
    progress: Omit<CopilotProgressEvent, 'id' | 'vmId' | 'scope' | 'timestamp'>,
  ) {
    this.publish({
      type: 'copilot.progress',
      payload: {
        id: id('copilot-progress'),
        vmId: scope,
        scope,
        timestamp: nowLabel(),
        ...progress,
      },
    })
  }
}
