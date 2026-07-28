export type TabId = 'overview' | 'monitoring' | 'applications' | 'files' | 'terminal' | 'activity' | 'settings'

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
  /** PEM key file path; may be empty when the VM authenticates via ssh-agent or keyless. */
  pemPath: string
  /** Explicit auth-mode declaration: true = ssh-agent, false = no key material. */
  useAgent?: boolean
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

export type ApplicationSource =
  | {
      type: 'local'
      /** Original folder selected by the user. Grove copies it into the managed workspace. */
      path: string
    }
  | {
      type: 'git'
      repoUrl: string
      ref?: string
    }

export interface ApplicationConfiguration {
  installCommand?: string
  buildCommand?: string
  /** Build output relative to the frozen source snapshot. Defaults to `dist`. */
  artifactPath: string
  startCommand: string
  port: number
  healthCheckPath: string
  healthCheckTimeoutSeconds: number
  /** Non-secret runtime values. Secret values are referenced through credential profiles. */
  environment: Record<string, string>
}

export interface GroveApplicationInput {
  name: string
  description?: string
  source: ApplicationSource
  configuration: ApplicationConfiguration
}

export type ApplicationVersionStatus = 'building' | 'succeeded' | 'failed'

export interface ApplicationVersion {
  id: string
  label: string
  sequence: number
  status: ApplicationVersionStatus
  createdAt: string
  completedAt?: string
  sourceRevision?: string
  artifactRelativePath?: string
  artifactDigest?: string
  artifactSizeBytes?: number
  buildLogRelativePath: string
  failure?: string
}

export type ApplicationInstanceStatus =
  | 'unknown'
  | 'uploading'
  | 'deploying'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'stopped'

export interface ApplicationInstance {
  vmId: string
  versionId?: string
  desiredVersionId?: string
  status: ApplicationInstanceStatus
  remotePath: string
  unitName: string
  updatedAt: string
  healthDetail?: string
  lastDeploymentId?: string
}

export type ApplicationDeploymentStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'
export type ApplicationDeploymentTargetStatus =
  | 'queued'
  | 'uploading'
  | 'activating'
  | 'healthy'
  | 'rolled_back'
  | 'failed'

export interface ApplicationDeploymentTarget {
  vmId: string
  status: ApplicationDeploymentTargetStatus
  startedAt?: string
  completedAt?: string
  detail?: string
  previousVersionId?: string
}

export interface ApplicationDeployment {
  id: string
  applicationId: string
  versionId: string
  environment: string
  strategy: 'rolling'
  status: ApplicationDeploymentStatus
  createdAt: string
  completedAt?: string
  targetVmIds: string[]
  targets: ApplicationDeploymentTarget[]
}

export type InfrastructureProvider = 'aws' | 'azure' | 'alicloud'

export interface InfrastructureIngressRule {
  description: string
  protocol: 'tcp' | 'udp'
  fromPort: number
  toPort: number
  cidrs: string[]
}

export interface ApplicationEnvironmentInput {
  name: string
  provider: InfrastructureProvider
  region: string
  providerCredentialProfileId: string
  sshCredentialProfileId: string
  vmName: string
  instanceType: string
  imageId: string
  systemUser: string
  diskSizeGb: number
  assignPublicIp: boolean
  ingressRules: InfrastructureIngressRule[]
  /** Optional Name.com profile and hostname are reconciled only after Terraform returns an IP. */
  nameComCredentialProfileId?: string
  hostname?: string
}

export type InfrastructureOperationKind = 'plan' | 'apply' | 'destroy-plan' | 'destroy-apply'
export type InfrastructureOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface TerraformChangeSummary {
  add: number
  change: number
  destroy: number
}

export interface InfrastructureOperation {
  id: string
  kind: InfrastructureOperationKind
  status: InfrastructureOperationStatus
  createdAt: string
  completedAt?: string
  planDigest?: string
  planRelativePath?: string
  logRelativePath: string
  changes?: TerraformChangeSummary
  failure?: string
}

export interface TerraformRuntimeStatus {
  available: boolean
  executable?: string
  version?: string
  detail: string
}

export type ApplicationEnvironmentStatus =
  | 'draft'
  | 'planned'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'destroy_planned'

export interface ApplicationEnvironment {
  id: string
  slug: string
  name: string
  provider: InfrastructureProvider
  region: string
  providerCredentialProfileId: string
  sshCredentialProfileId: string
  vmName: string
  instanceType: string
  imageId: string
  systemUser: string
  diskSizeGb: number
  assignPublicIp: boolean
  ingressRules: InfrastructureIngressRule[]
  nameComCredentialProfileId?: string
  hostname?: string
  dnsStatus: 'not_configured' | 'pending' | 'ready' | 'failed'
  dnsRecordId?: string
  dnsDetail?: string
  status: ApplicationEnvironmentStatus
  vmIds: string[]
  publicIp?: string
  privateIp?: string
  createdAt: string
  updatedAt: string
  operations: InfrastructureOperation[]
}

export interface ApplicationDomainInput {
  /** Fully-qualified hostname managed through Name.com, for example api.example.com. */
  hostname: string
  nameComCredentialProfileId: string
  /** An existing VM where this application has been deployed. */
  vmId: string
}

export interface ApplicationDomain extends ApplicationDomainInput {
  dnsStatus: 'pending' | 'ready' | 'failed'
  /** Exact Name.com record ID created by Grove; used to prevent deleting unrelated records. */
  dnsRecordId?: string
  dnsDetail?: string
  updatedAt: string
}

export type ApplicationHealth = 'healthy' | 'degraded' | 'failed' | 'unknown' | 'not_deployed'

export interface GroveApplication {
  id: string
  slug: string
  name: string
  description?: string
  source: ApplicationSource
  /** Absolute path to Grove's managed source copy. */
  managedSourcePath: string
  configuration: ApplicationConfiguration
  health: ApplicationHealth
  activeVersionId?: string
  createdAt: string
  updatedAt: string
  versions: ApplicationVersion[]
  deployments: ApplicationDeployment[]
  instances: ApplicationInstance[]
  environments: ApplicationEnvironment[]
  domain?: ApplicationDomain
}

export type CredentialProfileKind = 'ssh' | 'aws' | 'azure' | 'alicloud' | 'name.com'

export interface CredentialProfile {
  id: string
  kind: CredentialProfileKind
  name: string
  isDefault: boolean
  secretConfigured: boolean
  /** Safe-to-render provider metadata only; secret values never appear in snapshots. */
  configuration: Record<string, string>
  createdAt: string
  updatedAt: string
  lastTestAt?: string
  lastTestStatus?: 'passed' | 'failed'
  lastTestDetail?: string
}

export interface CredentialProfileInput {
  kind: CredentialProfileKind
  name: string
  isDefault?: boolean
  /** Provider identifiers and paths that are safe to display. */
  configuration: Record<string, string>
  /** Write-only values. The backend stores these in the credential vault and never echoes them. */
  secrets?: Record<string, string>
}

export interface CredentialProfileTestResult {
  profile: CredentialProfile
  status: 'passed' | 'failed'
  detail: string
  identity?: Record<string, string>
}

export interface AwsCredentialCsvImport {
  name: string
  region?: string
  isDefault?: boolean
  /** Raw CSV contents are write-only and must never be persisted outside the credential vault. */
  csvText: string
}

export interface AlicloudCredentialCsvImport {
  name: string
  region?: string
  isDefault?: boolean
  /** Raw CSV contents are write-only and must never be persisted outside the credential vault. */
  csvText: string
}

export type CloudMachineState = 'pending' | 'running' | 'stopping' | 'stopped' | 'rebooting' | 'unknown'
export type CloudMachinePowerAction = 'start' | 'stop' | 'reboot'

export interface CloudFirewallSummary {
  id: string
  name: string
}

/** Provider-neutral existing VM metadata returned by Grove's cloud control plane. */
export interface CloudMachine {
  id: string
  /** Provider-native instance identifier, such as an EC2 instance ID or ECS instance ID. */
  nativeId?: string
  provider: 'aws' | 'azure' | 'alicloud'
  credentialProfileId: string
  credentialProfileName: string
  name: string
  location: string
  zone?: string
  state: CloudMachineState
  publicIp?: string
  privateIp?: string
  machineType?: string
  imageId?: string
  launchedAt?: string
  monitoring?: string
  vpcId?: string
  subnetId?: string
  networkType?: string
  maxBandwidthInMbps?: number
  maxBandwidthOutMbps?: number
  firewalls: CloudFirewallSummary[]
}

export interface CloudInventory {
  machines: CloudMachine[]
  scannedAt: string
  warnings: string[]
}

export interface CloudFirewallRule {
  id: string
  firewallId: string
  firewallName: string
  direction: 'ingress' | 'egress'
  protocol: string
  fromPort?: number
  toPort?: number
  source: string
  description?: string
  /** Whether Grove can safely remove this provider rule. */
  removable: boolean
  /** Human-readable explanation shown when a provider rule is read-only. */
  readOnlyReason?: string
}

export interface CloudFirewallRuleInput {
  firewallId: string
  protocol: 'tcp' | 'udp'
  fromPort: number
  toPort: number
  cidr: string
  description?: string
}

export interface CloudMetricPoint {
  timestamp: string
  value: number
}

export interface CloudMetricSeries {
  key: 'cpuPercent' | 'networkInBytes' | 'networkOutBytes' | 'statusCheckFailed'
  label: string
  unit: string
  points: CloudMetricPoint[]
}

export interface CloudMachineMetrics {
  machineId: string
  periodSeconds: number
  startTime: string
  endTime: string
  series: CloudMetricSeries[]
}

export type VmTelemetrySource = 'aws' | 'azure' | 'alicloud' | 'host'

/** One VM Overview response, using provider APIs when Grove can match the VM by IP. */
export interface VmOverviewTelemetry {
  vm: VM
  source: VmTelemetrySource
  sourceLabel: string
  sampledAt: string
  cloudMachine?: CloudMachine
  cloudMetrics?: CloudMachineMetrics
  warnings: string[]
}

export interface GroveSettings {
  schemaVersion: 2
  workspacePath: string
  workspaceStatus: 'healthy' | 'missing' | 'unwritable' | 'migrating'
  credentialProfiles: CredentialProfile[]
  legacyAppRunnerMigrationCompletedAt?: string
}

export interface GroveStorageStatus {
  engine: 'sqlite' | 'memory'
  databasePath?: string
  schemaVersion: number
  integrity: 'ok' | 'error'
  journalMode?: string
  migratedAt?: string
  backupDirectory?: string
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
  /**
   * Full SSH console dump for steps that ran a command (the command line, raw stdout/stderr,
   * and exit status), shown on demand behind the step's "console log" toggle. Bounded but much
   * larger than `output`, which stays a compact preview.
   */
  consoleLog?: string
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

export type CopilotProvider = 'moonshot' | 'glm-cn'

export interface CopilotProviderStatus {
  provider: CopilotProvider
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
  /**
   * Whether the kimi-code CLI is present on the machine. `false` means the copilot can't run
   * until it's installed and drives the install prompt in the copilot panel. `undefined` for the
   * mock driver, which needs no CLI.
   */
  kimiInstalled?: boolean
}

export type CopilotInstallStatus = 'idle' | 'running' | 'done' | 'error'

/** Progress of an in-app `uv tool install kimi-cli` run, streamed to the copilot panel. */
export interface CopilotInstallState {
  status: CopilotInstallStatus
  /** Accumulated stdout/stderr from the install steps, shown in a console block. */
  log: string
  /** One-line outcome or error summary. */
  detail?: string
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
  homePath: string
  downloadsPath: string
  localFilesPath: string
  pathSeparator: string
}

export interface AppSnapshot {
  vms: VM[]
  applications: GroveApplication[]
  settings: GroveSettings
  transfers: TransferJob[]
  messages: CopilotMessage[]
  proposals: ActionProposal[]
  toolCalls: CopilotToolCall[]
  plans: CopilotPlanState[]
  runtime: CopilotRuntimeStatus
  /** Current kimi-code install progress, so it survives a WS reconnect and reaches new clients. */
  install: CopilotInstallState
  storage?: GroveStorageStatus
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
  | { type: 'application.updated'; payload: GroveApplication }
  | { type: 'application.deleted'; payload: { applicationId: string } }
  | { type: 'deployment.updated'; payload: ApplicationDeployment }
  | { type: 'settings.updated'; payload: GroveSettings }
  | { type: 'transfer.updated'; payload: TransferJob }
  | { type: 'copilot.message'; payload: CopilotMessage }
  | { type: 'copilot.delta'; payload: CopilotDeltaEvent }
  | { type: 'copilot.toolcall.updated'; payload: CopilotToolCall }
  | { type: 'copilot.plan'; payload: CopilotPlanState }
  | { type: 'copilot.progress'; payload: CopilotProgressEvent }
  | { type: 'copilot.proposal.updated'; payload: ActionProposal }
  | { type: 'copilot.runtime'; payload: CopilotRuntimeStatus }
  | { type: 'copilot.install'; payload: CopilotInstallState }
  | { type: 'activity.created'; payload: AuditEvent }
  | { type: 'terminal.output'; payload: { sessionId: string; vmId: string; command?: string; output: string } }
  | { type: 'terminal.data'; payload: { sessionId: string; vmId: string; data: string } }
  | { type: 'terminal.status'; payload: TerminalSession }
