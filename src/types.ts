export type TabId = 'overview' | 'files' | 'terminal' | 'apprunner' | 'activity' | 'settings'

export type VMHealth = 'healthy' | 'warning' | 'critical' | 'offline'

export type LifecycleState = 'running' | 'stopped' | 'suspended' | 'provisioning'

export type KeyStatus = 'present' | 'missing' | 'unknown'

export type ConnectionTestStatus = 'passed' | 'warning' | 'failed' | 'idle'

export type DangerLevel = 'safe' | 'caution' | 'destructive'

export type TransferDirection = 'upload' | 'download' | 'copy'

export type TransferStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'conflict'

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'failed'

export type CommandStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type TerminalStatus = 'opening' | 'open' | 'closed' | 'failed'

export interface VmConfig {
  id: string
  name: string
  host: string
  user: string
  port: number
  keyPath?: string
  useAgent?: boolean
  os?: string
  labels?: string[]
  provider?: {
    name?: string
    region?: string
    node?: string
  }
}

export interface VmConnectionInput {
  name?: string
  ipAddress: string
  user?: string
  port: number
  pemPath: string
  os?: string
  labels?: string[]
}

export interface VmRuntimeState {
  vmId: string
  health: VMHealth
  lifecycle: LifecycleState
  connectionStatus: ConnectionStatus
  lastSeen: string
  metrics: VMMetrics
  alerts: string[]
}

export interface VMMetrics {
  cpuPercent: number
  memoryPercent: number
  diskPercent: number
  networkInMbps: number
  networkOutMbps: number
  loadAverage: [number, number, number]
  uptime: string
  sampledAt: string
  thresholds: {
    cpuWarning: number
    memoryWarning: number
    diskWarning: number
  }
}

export interface ServiceInfo {
  name: string
  state: 'running' | 'degraded' | 'stopped'
  port?: number
  cpuPercent: number
  memoryMb: number
}

export type AppRunnerServiceState = 'running' | 'degraded' | 'stopped' | 'unknown'

export type AppRunnerDeployStatus = 'pending' | 'completed' | 'failed'

export type AppRunnerSource =
  | {
      type: 'local'
      path: string
    }
  | {
      type: 'github'
      repoUrl: string
      ref?: string
    }

export interface AppRunnerServiceInput {
  name: string
  source: AppRunnerSource
  port: number
  installCommand?: string
  buildCommand?: string
  startCommand: string
}

export interface AppRunnerService {
  id: string
  vmId: string
  name: string
  source: AppRunnerSource
  port: number
  remotePath: string
  unitName: string
  accessUrl: string
  state: AppRunnerServiceState
  pid?: number
  cpuPercent: number
  memoryMb: number
  listening: boolean
  installCommand?: string
  buildCommand?: string
  startCommand: string
  createdAt: string
  updatedAt: string
  lastDeployStatus: AppRunnerDeployStatus
  lastDeploySummary: string
}

export interface ProcessInfo {
  pid: number
  command: string
  user: string
  cpuPercent: number
  memoryMb: number
}

export interface ActivityEvent {
  id: string
  timestamp: string
  title: string
  detail: string
  severity: 'info' | 'success' | 'warning' | 'critical'
}

export interface ConnectionProfile {
  host: string
  user: string
  port: number
  keyLabel: string
  keyStatus: KeyStatus
  fingerprint?: string
  lastConnected: string
  testStatus: ConnectionTestStatus
}

export interface VM {
  id: string
  name: string
  hostname: string
  ipAddress: string
  os: string
  provider: {
    name: string
    region: string
    node: string
  }
  tags: string[]
  health: VMHealth
  lifecycle: LifecycleState
  connection: ConnectionProfile
  resources: {
    cpuCores: number
    memoryGb: number
    diskGb: number
  }
  metrics: VMMetrics
  alerts: string[]
  services: ServiceInfo[]
  appServices: AppRunnerService[]
  processes: ProcessInfo[]
  activity: ActivityEvent[]
}

export interface VMAction {
  id: 'start' | 'stop' | 'suspend' | 'reboot' | 'snapshot' | 'clone' | 'delete'
  label: string
  detail: string
  danger: DangerLevel
  requiresConfirmation: boolean
  mockResult: string
}

export interface FileNode {
  id: string
  scope: 'local' | 'remote'
  type: 'file' | 'folder'
  name: string
  path: string
  size: number
  modified: string
  permissions?: string
  owner?: string
}

export interface TransferJob {
  id: string
  vmId: string
  direction: TransferDirection
  source: string
  target: string
  fileName: string
  status: TransferStatus
  progress: number
  speed: string
  conflict?: 'overwrite' | 'rename' | 'skip'
}

export interface CommandRun {
  id: string
  vmId: string
  actor: 'user' | 'copilot' | 'system'
  command: string
  status: CommandStatus
  startedAt: string
  completedAt?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  summary: string
  mutating: boolean
}

export interface TerminalSession {
  id: string
  vmId: string
  status: TerminalStatus
  createdAt: string
  lastActivityAt: string
}

export interface CopilotMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  contextVmId?: string
  contextTab?: TabId
}

export interface CopilotProviderStatus {
  provider: 'moonshot'
  configured: boolean
  baseUrl: string
  model: string
}

export interface CopilotProgressEvent {
  id: string
  vmId: string
  title: string
  detail?: string
  status: 'running' | 'completed' | 'failed'
  timestamp: string
}

export interface ActionProposal {
  id: string
  vmId: string
  title: string
  description: string
  command: string
  actionType:
    | 'inspect_logs'
    | 'restart_service'
    | 'snapshot'
    | 'transfer_file'
    | 'explain_metrics'
    | 'patch_vms'
    | 'custom_command'
  risk: 'low' | 'medium' | 'high'
  status: 'draft' | 'pending_confirmation' | 'executed' | 'dismissed'
  result?: string
}

export interface CopilotActionProposal extends ActionProposal {
  affectedVmId: string
  affectedPath?: string
  expectedResult: string
  requiresConfirmation: boolean
  mutating: boolean
}

export interface AuditEvent extends ActivityEvent {
  vmId: string
  actor: 'user' | 'copilot' | 'system'
  commandRunId?: string
  transferJobId?: string
  proposalId?: string
}

export interface LocalDefaults {
  workspacePath: string
  downloadsPath: string
  localFilesPath: string
  pathSeparator: string
}

export interface AppSnapshot {
  vms: VM[]
  transfers: TransferJob[]
  messages: CopilotMessage[]
  proposals: ActionProposal[]
}

export type ServerEvent =
  | { type: 'snapshot'; payload: AppSnapshot }
  | { type: 'vm.updated'; payload: VM }
  | { type: 'vm.deleted'; payload: { vmId: string } }
  | { type: 'transfer.updated'; payload: TransferJob }
  | { type: 'copilot.message'; payload: CopilotMessage }
  | { type: 'copilot.progress'; payload: CopilotProgressEvent }
  | { type: 'copilot.proposal.updated'; payload: ActionProposal }
  | { type: 'activity.created'; payload: AuditEvent }
  | { type: 'terminal.output'; payload: { sessionId: string; vmId: string; command?: string; output: string } }
  | { type: 'terminal.data'; payload: { sessionId: string; vmId: string; data: string } }
  | { type: 'terminal.status'; payload: TerminalSession }
