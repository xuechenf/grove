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
  CopilotMessage,
  CopilotProgressEvent,
  ProcessInfo,
  ServiceInfo,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
  VmConfig,
  VmConnectionInput,
} from '../src/types'
import { loadAppRunnerServices, saveAppRunnerServices } from './appRunnerMetadata'
import { classifyCommand } from './commandProfiles'
import {
  CopilotAgent,
  DEFAULT_MOONSHOT_BASE_URL,
  DEFAULT_MOONSHOT_MODEL,
  SHADOWSOCKS_INSTALLED_DIAGNOSTIC_COMMAND,
  SHADOWSOCKS_RUNNING_DIAGNOSTIC_COMMAND,
  isAgentReadOnlyCommand,
  moonshotConfigFromEnv,
  toolResultFromCommandRun,
  toolResultFromFiles,
  type CopilotAgentInput,
  type CopilotAgentResult,
  type CustomSshProposalInput,
  type MoonshotConfig,
  type SftpTransferPlanInput,
} from './copilotAgent'
import { envFlag, envValue, saveMoonshotLocalEnv } from './env'
import { loadInventory, saveInventory, vmFromConfig } from './inventory'
import type { SshSessionManager } from './sshSessionManager'
import { MockSshSessionManager, RealSshSessionManager } from './sshSessionManager'

interface CopilotResponder {
  respond(input: CopilotAgentInput): Promise<CopilotAgentResult>
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

function normalizedLabels(labels: string[] | undefined, fallback: string[] | undefined) {
  const cleaned = labels?.map((label) => label.trim()).filter(Boolean)
  if (cleaned?.length) {
    return cleaned
  }

  return fallback?.length ? fallback : ['ssh']
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
    labels: normalizedLabels(input.labels, existing?.labels),
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

export class GroveStore {
  private readonly events = new EventEmitter()
  private readonly ssh: SshSessionManager
  private copilot: CopilotResponder
  private vmConfigs: VmConfig[]
  private vms: VM[]
  private transfers: TransferJob[]
  private messages: CopilotMessage[]
  private proposals: ActionProposal[]
  private refreshedOnce = false

  constructor(
    ssh: SshSessionManager = envFlag('GROVE_USE_FIXTURES') ? new MockSshSessionManager() : new RealSshSessionManager(),
    copilot: CopilotResponder = new CopilotAgent(),
  ) {
    const useFixtures = envFlag('GROVE_USE_FIXTURES')
    this.ssh = ssh
    this.copilot = copilot
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
    this.messages = [...initialMessages]
    this.proposals = useFixtures ? [...initialProposals] : []
  }

  copilotProviderStatus() {
    return {
      provider: 'moonshot' as const,
      configured: Boolean(moonshotConfigFromEnv()),
      baseUrl: envValue('GROVE_MOONSHOT_BASE_URL') ?? DEFAULT_MOONSHOT_BASE_URL,
      model: envValue('GROVE_MOONSHOT_MODEL') ?? DEFAULT_MOONSHOT_MODEL,
    }
  }

  configureCopilotProvider(input: MoonshotConfig) {
    saveMoonshotLocalEnv(input)
    this.copilot = new CopilotAgent(input)
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

  async refreshVmInfo(vmId: string) {
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
        connection: {
          ...vm.connection,
          testStatus: 'failed',
        },
      }
      this.replaceVm(failedVm)
      return failedVm
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

    const updatedVm: VM = {
      ...vm,
      hostname: values.HOSTNAME || vm.hostname,
      os: values.OS || vm.os,
      health: diskPercent >= vm.metrics.thresholds.diskWarning ? 'warning' : 'healthy',
      lifecycle: 'running',
      resources: {
        cpuCores: Number(values.CPUS) || vm.resources.cpuCores,
        memoryGb: Math.max(1, Math.round(memoryTotalMb / 1024)),
        diskGb: Math.max(1, Math.round(diskTotalKb / 1024 / 1024)),
      },
      metrics: {
        ...vm.metrics,
        cpuPercent: 0,
        memoryPercent: Math.round((memoryUsedMb / memoryTotalMb) * 100),
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
    return updatedVm
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

  async sendCopilotMessage(input: { vmId: string; activeTab: TabId; message: string }) {
    const vm = this.requireVm(input.vmId)
    const userMessage: CopilotMessage = {
      id: id('msg-user'),
      role: 'user',
      content: input.message,
      timestamp: nowLabel(),
      contextVmId: input.vmId,
      contextTab: input.activeTab,
    }
    this.messages = [...this.messages, userMessage]
    this.publish({ type: 'copilot.message', payload: userMessage })
    this.publishCopilotProgress(input.vmId, {
      title: 'Queued copilot request',
      detail: `${vm.name} / ${input.activeTab}`,
      status: 'running',
    })
    const proposals: ActionProposal[] = []
    const commandRuns: CommandRun[] = []
    const history = this.messages.filter((message) => !message.contextVmId || message.contextVmId === input.vmId)
    let agentResult
    try {
      agentResult = await this.copilot.respond({
        vm,
        vms: this.vms,
        activeTab: input.activeTab,
        message: input.message,
        transfers: this.transfers,
        history,
        onProgress: (progress) => this.publishCopilotProgress(input.vmId, progress),
        runtime: {
          inspectSystem: async (check) => {
            const command =
              check === 'shadowsocks_installed'
                ? SHADOWSOCKS_INSTALLED_DIAGNOSTIC_COMMAND
                : SHADOWSOCKS_RUNNING_DIAGNOSTIC_COMMAND
            const run = await this.ssh.executeCommand({
              vm,
              command,
              actor: 'copilot',
              mutating: false,
            })
            commandRuns.push(run)
            return toolResultFromCommandRun(run)
          },
          executeReadOnlySsh: async (command, reason) => {
            if (!isAgentReadOnlyCommand(command)) {
              return {
                ok: false,
                summary: 'Command requires a confirmation proposal before it can run.',
                error: `Rejected non-read-only copilot command: ${command}`,
              }
            }

            const run = await this.ssh.executeCommand({
              vm,
              command,
              actor: 'copilot',
              mutating: false,
            })
            commandRuns.push(run)
            const result = toolResultFromCommandRun(run)
            return {
              ...result,
              summary: `${reason} ${result.summary}`.trim(),
            }
          },
          listRemoteFiles: async (path) => {
            const files = await this.ssh.listFiles(vm, path)
            return toolResultFromFiles(path, files)
          },
          createKnownProposal: (type) => {
            const proposal = proposalFor(type, vm, input.activeTab, this.vms)
            proposals.push(proposal)
            return {
              ok: true,
              summary: `Created proposal "${proposal.title}".`,
              data: proposal,
            }
          },
          createSshProposal: (proposalInput: CustomSshProposalInput) => {
            const proposal = this.customCommandProposal(vm, proposalInput)
            proposals.push(proposal)
            return {
              ok: true,
              summary: `Created proposal "${proposal.title}".`,
              data: proposal,
            }
          },
          planSftpTransfer: (transferPlan: SftpTransferPlanInput) => {
            const proposal = this.sftpTransferProposal(vm, transferPlan)
            proposals.push(proposal)
            return {
              ok: true,
              summary: `Created SFTP proposal "${proposal.title}".`,
              data: proposal,
            }
          },
        },
      })
    } catch (error) {
      this.publishCopilotProgress(input.vmId, {
        title: 'Copilot request failed',
        detail: error instanceof Error ? error.message : 'Unknown copilot error',
        status: 'failed',
      })
      throw error
    }
    const assistantMessage: CopilotMessage = {
      id: id('msg-assistant'),
      role: 'assistant',
      content: agentResult.content,
      timestamp: nowLabel(),
      contextVmId: input.vmId,
      contextTab: input.activeTab,
    }
    this.messages = [...this.messages, assistantMessage]
    if (proposals.length) {
      this.proposals = [...proposals, ...this.proposals]
    }
    this.publish({ type: 'copilot.message', payload: assistantMessage })
    for (const proposal of proposals) {
      this.publish({ type: 'copilot.proposal.updated', payload: proposal })
    }
    for (const run of commandRuns) {
      this.addActivity(
        run.vmId,
        makeActivity('Copilot SSH inspection', run.summary, run.status === 'failed' ? 'critical' : 'info'),
        'copilot',
        { commandRunId: run.id },
      )
    }
    this.publishCopilotProgress(input.vmId, {
      title: 'Copilot response ready',
      detail: proposals.length ? `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} prepared` : undefined,
      status: 'completed',
    })
    return { messages: [userMessage, assistantMessage], proposals }
  }

  createCopilotProposal(input: { vmId: string; activeTab: TabId; actionType: ActionProposal['actionType'] }) {
    const vm = this.requireVm(input.vmId)
    const proposal = proposalFor(input.actionType, vm, input.activeTab, this.vms)
    this.proposals = [proposal, ...this.proposals]
    this.publish({ type: 'copilot.proposal.updated', payload: proposal })
    return proposal
  }

  async confirmCopilotProposal(proposalId: string) {
    const proposal = this.proposals.find((item) => item.id === proposalId)
    if (!proposal) {
      throw new Error('Proposal not found')
    }

    const vm = this.requireVm(proposal.vmId)
    if (proposal.actionType === 'patch_vms') {
      const commandRuns: CommandRun[] = []
      const targets = runningVms(this.vms)

      for (const targetVm of targets) {
        const run = await this.ssh.executeCommand({
          vm: targetVm,
          command: proposal.command,
          actor: 'copilot',
          mutating: true,
        })
        commandRuns.push(run)
        this.addActivity(
          targetVm.id,
          makeActivity(
            `Fleet patch ${run.status}`,
            run.summary,
            run.status === 'failed' ? 'critical' : 'success',
          ),
          'copilot',
          {
            commandRunId: run.id,
            proposalId: proposal.id,
          },
        )
      }

      const completed = commandRuns.filter((run) => run.status === 'completed').length
      const result = commandRuns.length
        ? [
            `Fleet patch attempted on ${commandRuns.length} VM${commandRuns.length === 1 ? '' : 's'}; ${completed} succeeded.`,
            ...commandRuns.map((run) => {
              const targetVm = this.getVm(run.vmId)
              return `${targetVm?.name ?? run.vmId}: ${run.status} - ${run.summary}`
            }),
          ].join('\n')
        : 'No running VMs were available for patching.'
      const updatedProposal: ActionProposal = {
        ...proposal,
        status: commandRuns.length ? 'executed' : 'dismissed',
        result,
      }

      this.proposals = this.proposals.map((item) => (item.id === proposalId ? updatedProposal : item))
      this.publish({ type: 'copilot.proposal.updated', payload: updatedProposal })

      return { proposal: updatedProposal, commandRun: commandRuns[0], commandRuns }
    }

    const classification = classifyCommand(proposal.command)
    const run = await this.ssh.executeCommand({
      vm,
      command: proposal.command,
      actor: 'copilot',
      mutating: classification.mutating,
    })
    const updatedProposal: ActionProposal = {
      ...proposal,
      status: run.status === 'completed' ? 'executed' : 'dismissed',
      result:
        proposal.actionType === 'custom_command' || proposal.command.trim() === 'ls'
          ? run.stdout || run.stderr || run.summary
          : run.summary,
    }

    this.proposals = this.proposals.map((item) => (item.id === proposalId ? updatedProposal : item))
    this.publish({ type: 'copilot.proposal.updated', payload: updatedProposal })
    this.addActivity(vm.id, makeActivity(proposal.title, run.summary, run.status === 'failed' ? 'critical' : 'success'), 'copilot', {
      commandRunId: run.id,
      proposalId: proposal.id,
    })

    return { proposal: updatedProposal, commandRun: run }
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

  private customCommandProposal(vm: VM, input: CustomSshProposalInput): ActionProposal {
    const classification = classifyCommand(input.command)
    return {
      id: id('proposal'),
      vmId: vm.id,
      title: input.title,
      description: input.description,
      command: input.command,
      actionType: 'custom_command',
      risk: classification.mutating ? input.risk : 'low',
      status: 'pending_confirmation',
    }
  }

  private sftpTransferProposal(vm: VM, input: SftpTransferPlanInput): ActionProposal {
    return {
      id: id('proposal'),
      vmId: vm.id,
      title: `Plan ${input.direction} transfer for ${vm.name}`,
      description: `${input.description} ${input.source} -> ${input.target}`,
      command: `sftp -P ${vm.connection.port} ${vm.connection.user}@${vm.connection.host}`,
      actionType: 'transfer_file',
      risk: 'low',
      status: 'pending_confirmation',
    }
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
    vmId: string,
    progress: Omit<CopilotProgressEvent, 'id' | 'vmId' | 'timestamp'>,
  ) {
    this.publish({
      type: 'copilot.progress',
      payload: {
        id: id('copilot-progress'),
        vmId,
        timestamp: nowLabel(),
        ...progress,
      },
    })
  }
}
