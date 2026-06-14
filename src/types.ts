export type TabId = 'overview' | 'files' | 'terminal' | 'apprunner' | 'activity' | 'settings'

export type VMHealth = 'healthy' | 'warning' | 'critical' | 'offline'

export type LifecycleState = 'running' | 'stopped' | 'suspended' | 'provisioning'

export type KeyStatus = 'present' | 'missing' | 'unknown'

export type ConnectionTestStatus = 'passed' | 'warning' | 'failed' | 'idle'

export type DangerLevel = 'safe' | 'caution' | 'destructive'

export type TransferDirection = 'upload' | 'download' | 'copy'

export type TransferStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'conflict'


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

/**
 * Copilot context scope. `fleet` enables all-VM context; `vm:<id>` focuses one machine.
 * The string form is used directly as a key across events, journals, and UI state.
 */
export type CopilotScope = 'fleet' | `vm:${string}`

export function vmScope(vmId: string): CopilotScope {
  return `vm:${vmId}`
}

export function scopeVmId(scope: CopilotScope): string | undefined {
  return scope.startsWith('vm:') ? scope.slice(3) : undefined
}

export interface CopilotMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  openUi?: {
    type: 'openui'
    content: string
  }
  timestamp: string
  scope?: CopilotScope
  /** Epoch ms for stable timeline ordering across messages, tool calls, and proposals. */
  createdAt?: number
  /** True while assistant text is still streaming in via copilot.delta events. */
  streaming?: boolean
  contextVmId?: string
  contextTab?: TabId
}

export type CopilotToolCallStatus = 'pending' | 'running' | 'completed' | 'failed'

export type CopilotToolCallKind = 'read' | 'edit' | 'execute' | 'fetch' | 'think' | 'other'

export interface CopilotToolCall {
  id: string
  scope: CopilotScope
  title: string
  kind: CopilotToolCallKind
  status: CopilotToolCallStatus
  /**
   * Where the step was observed: 'grove' steps are executed by the Grove backend
   * (authoritative command + output); 'agent' steps are kimi's own tool executions
   * (built-in shell/file/web tools and uninstrumented MCP reads) streamed by the driver.
   * Thought blocks stream as 'agent' steps with kind 'think'.
   */
  origin?: 'grove' | 'agent'
  /** Target VM for VM-scoped tool calls. */
  vmId?: string
  /** Concrete command or argument detail, when meaningful. */
  detail?: string
  /** Truncated tool output for the timeline card. */
  output?: string
  createdAt: number
  updatedAt: number
}

export type CopilotPlanEntryStatus = 'pending' | 'in_progress' | 'completed'

export interface CopilotPlanEntry {
  title: string
  status: CopilotPlanEntryStatus
}

/**
 * The agent's live task checklist for one turn (ACP plan updates). One plan per turn,
 * updated in place as entries tick off; it stays in the timeline as a record of the run.
 */
export interface CopilotPlanState {
  id: string
  scope: CopilotScope
  entries: CopilotPlanEntry[]
  createdAt: number
  updatedAt: number
}

export type CopilotPermissionDecision = 'allow_once' | 'always_allow' | 'deny'

export interface CopilotProviderStatus {
  provider: 'moonshot'
  configured: boolean
  baseUrl: string
  model: string
}

export type CopilotRuntimeState = 'starting' | 'ready' | 'error' | 'disabled'

export interface CopilotRuntimeStatus {
  driver: 'acp' | 'print' | 'mock'
  state: CopilotRuntimeState
  detail?: string
  model?: string
}

export interface CopilotProgressEvent {
  id: string
  /** Holds the scope string ('fleet' | 'vm:<id>'). Named vmId for back-compat. */
  vmId: string
  scope?: CopilotScope
  title: string
  detail?: string
  status: 'running' | 'completed' | 'failed'
  timestamp: string
}

export interface ActionProposal {
  id: string
  vmId: string
  scope?: CopilotScope
  /** Frozen set of target VMs for fleet operations; defaults to [vmId]. */
  targetVmIds?: string[]
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
  status: 'draft' | 'pending_confirmation' | 'awaiting_confirmation' | 'executed' | 'dismissed'
  /** Links a proposal back to the ACP tool call awaiting a permission decision. */
  toolCallId?: string
  decision?: CopilotPermissionDecision
  createdAt?: number
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
  toolCalls: CopilotToolCall[]
  plans: CopilotPlanState[]
  runtime: CopilotRuntimeStatus
}

export interface CopilotDeltaEvent {
  scope: CopilotScope
  messageId: string
  delta: string
}

export type ServerEvent =
  | { type: 'snapshot'; payload: AppSnapshot }
  | { type: 'vm.updated'; payload: VM }
  | { type: 'vm.deleted'; payload: { vmId: string } }
  | { type: 'transfer.updated'; payload: TransferJob }
  | { type: 'copilot.message'; payload: CopilotMessage }
  | { type: 'copilot.delta'; payload: CopilotDeltaEvent }
  | { type: 'copilot.toolcall.updated'; payload: CopilotToolCall }
  | { type: 'copilot.plan'; payload: CopilotPlanState }
  | { type: 'copilot.progress'; payload: CopilotProgressEvent }
  | { type: 'copilot.proposal.updated'; payload: ActionProposal }
  | { type: 'copilot.runtime'; payload: CopilotRuntimeStatus }
  | { type: 'activity.created'; payload: AuditEvent }
  | { type: 'terminal.output'; payload: { sessionId: string; vmId: string; command?: string; output: string } }
  | { type: 'terminal.data'; payload: { sessionId: string; vmId: string; data: string } }
  | { type: 'terminal.status'; payload: TerminalSession }
