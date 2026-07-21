import type {
  ActionProposal,
  AlicloudCredentialCsvImport,
  AppSnapshot,
  ApplicationEnvironment,
  ApplicationEnvironmentInput,
  ApplicationDeployment,
  ApplicationVersion,
  AwsCredentialCsvImport,
  CloudFirewallRule,
  CloudFirewallRuleInput,
  CloudInventory,
  CloudMachine,
  CloudMachineMetrics,
  CloudMachinePowerAction,
  CommandRun,
  CopilotInstallState,
  CopilotPermissionDecision,
  CopilotProvider,
  CopilotProviderStatus,
  CopilotRuntimeStatus,
  CopilotScope,
  CredentialProfile,
  CredentialProfileInput,
  CredentialProfileTestResult,
  FileNode,
  GroveApplication,
  GroveApplicationInput,
  GroveSettings,
  InfrastructureOperation,
  TerraformRuntimeStatus,
  LocalDefaults,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
  VmOverviewTelemetry,
  VmConnectionInput,
} from '../types'

export function apiDisabled() {
  return import.meta.env.MODE === 'test' || import.meta.env.VITE_DISABLE_API === 'true'
}

const apiBase = import.meta.env.VITE_API_BASE_URL ?? ''

let apiToken: string | undefined

/** Store the per-boot UI token; attached to mutating requests so the backend accepts them. */
export function setApiToken(token: string | undefined) {
  apiToken = token ?? undefined
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isApiUnavailableError(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && [502, 503, 504].includes(error.status))
  )
}

function apiUrl(path: string) {
  return `${apiBase}${path}`
}

function websocketUrl(path: string) {
  // Browsers cannot set x-grove-token on a WebSocket, so the per-boot token travels as a
  // query parameter; the backend validates it during the upgrade (see server/start.ts).
  const explicit = import.meta.env.VITE_API_WS_URL
  const url = explicit ? new URL(path, explicit) : new URL(path, window.location.origin)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  }
  if (apiToken) {
    url.searchParams.set('token', apiToken)
  }
  return url.toString()
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { 'x-grove-token': apiToken } : {}),
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => ({ error: response.statusText }))
      : { error: await response.text().catch(() => response.statusText) }
    const message = typeof body.error === 'string' && body.error.trim() ? body.error : response.statusText
    throw new ApiError(message, response.status)
  }

  return response.json() as Promise<T>
}

export async function getBootstrap() {
  const bootstrap = await requestJson<{ runtime: CopilotRuntimeStatus }>('/api/bootstrap')
  const token = await resolveUiToken()
  return { token, runtime: bootstrap.runtime }
}

/**
 * The per-boot UI token never travels the backend API (see server/apiToken.ts). The desktop
 * shell hands it over through its IPC bridge; the Vite dev server serves the local token
 * file at /__grove-dev-token. Elsewhere (tests, preview builds) there is no token and
 * mutating calls stay 401-gated, exactly as when bootstrap used to fail.
 */
async function resolveUiToken(): Promise<string | null> {
  const desktop = window.groveDesktop?.getUiToken
  if (desktop) {
    return desktop()
  }
  try {
    const response = await fetch(apiUrl('/__grove-dev-token'))
    if (!response.ok) {
      return null
    }
    const body = (await response.json()) as { token?: string | null }
    return body.token ?? null
  } catch {
    return null
  }
}

export function getSnapshot() {
  return requestJson<AppSnapshot>('/api/snapshot')
}

export function getGroveSettings() {
  return requestJson<GroveSettings>('/api/settings')
}

export function relocateWorkspace(workspacePath: string) {
  return requestJson<GroveSettings>('/api/settings/workspace', {
    method: 'PATCH',
    body: JSON.stringify({ workspacePath }),
  })
}

export function createCredentialProfile(input: CredentialProfileInput) {
  return requestJson<CredentialProfile>('/api/settings/credentials', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateCredentialProfile(profileId: string, input: CredentialProfileInput) {
  return requestJson<CredentialProfile>(`/api/settings/credentials/${profileId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function testCredentialProfile(profileId: string) {
  return requestJson<CredentialProfileTestResult>(`/api/settings/credentials/${profileId}/test`, {
    method: 'POST',
  })
}

export function deleteCredentialProfile(profileId: string) {
  return requestJson<{ profileId: string }>(`/api/settings/credentials/${profileId}`, { method: 'DELETE' })
}

export function importAwsCredentialCsv(input: AwsCredentialCsvImport) {
  return requestJson<CredentialProfileTestResult>('/api/settings/credentials/import/aws-csv', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function importAlicloudCredentialCsv(input: AlicloudCredentialCsvImport) {
  return requestJson<CredentialProfileTestResult>('/api/settings/credentials/import/alicloud-csv', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getVmOverview(vmId: string, hours = 1) {
  return requestJson<VmOverviewTelemetry>(
    `/api/vms/${encodeURIComponent(vmId)}/overview?hours=${encodeURIComponent(hours)}`,
  )
}

export function listCloudMachines(profileId?: string) {
  const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
  return requestJson<CloudInventory>(`/api/cloud/machines${query}`)
}

export function listCloudFirewallRules(machineId: string) {
  return requestJson<CloudFirewallRule[]>(`/api/cloud/machines/${encodeURIComponent(machineId)}/firewall-rules`)
}

export function addCloudFirewallRule(machineId: string, input: CloudFirewallRuleInput) {
  return requestJson<CloudFirewallRule[]>(`/api/cloud/machines/${encodeURIComponent(machineId)}/firewall-rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function removeCloudFirewallRule(machineId: string, ruleId: string) {
  return requestJson<CloudFirewallRule[]>(
    `/api/cloud/machines/${encodeURIComponent(machineId)}/firewall-rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  )
}

export function getCloudMachineMetrics(machineId: string, hours = 1) {
  return requestJson<CloudMachineMetrics>(
    `/api/cloud/machines/${encodeURIComponent(machineId)}/metrics?hours=${encodeURIComponent(hours)}`,
  )
}

export function changeCloudMachinePower(machineId: string, action: CloudMachinePowerAction) {
  return requestJson<CloudMachine>(`/api/cloud/machines/${encodeURIComponent(machineId)}/power`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

export function listApplications() {
  return requestJson<GroveApplication[]>('/api/applications')
}

export function createApplication(input: GroveApplicationInput) {
  return requestJson<GroveApplication>('/api/applications', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateApplication(applicationId: string, input: GroveApplicationInput) {
  return requestJson<GroveApplication>(`/api/applications/${applicationId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function syncApplicationSource(applicationId: string) {
  return requestJson<GroveApplication>(`/api/applications/${applicationId}/source/sync`, {
    method: 'POST',
  })
}

export function buildApplication(applicationId: string) {
  return requestJson<ApplicationVersion>(`/api/applications/${applicationId}/builds`, {
    method: 'POST',
  })
}

export function deployApplication(applicationId: string, input: { versionId: string; vmIds: string[]; environment?: string }) {
  return requestJson<{ application: GroveApplication; deployment: ApplicationDeployment }>(
    `/api/applications/${applicationId}/deployments`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function getApplicationLogs(applicationId: string, vmId: string, lines = 200) {
  return requestJson<{ vmId: string; lines: string[] }>(
    `/api/applications/${applicationId}/logs?vmId=${encodeURIComponent(vmId)}&lines=${lines}`,
  )
}

export function getTerraformStatus() {
  return requestJson<TerraformRuntimeStatus>('/api/infrastructure/terraform/status')
}

export function installTerraform() {
  return requestJson<TerraformRuntimeStatus>('/api/infrastructure/terraform/install', { method: 'POST' })
}

export function createApplicationEnvironment(applicationId: string, input: ApplicationEnvironmentInput) {
  return requestJson<ApplicationEnvironment>(`/api/applications/${applicationId}/environments`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function planApplicationEnvironment(applicationId: string, environmentId: string, destroy = false) {
  return requestJson<{ application: GroveApplication; environment: ApplicationEnvironment; operation: InfrastructureOperation }>(
    `/api/applications/${applicationId}/environments/${environmentId}/plan`,
    { method: 'POST', body: JSON.stringify({ destroy }) },
  )
}

export function applyApplicationEnvironment(applicationId: string, environmentId: string, planOperationId: string) {
  return requestJson<{ application: GroveApplication; environment: ApplicationEnvironment; operation: InfrastructureOperation }>(
    `/api/applications/${applicationId}/environments/${environmentId}/apply`,
    { method: 'POST', body: JSON.stringify({ planOperationId }) },
  )
}

export function rebootVm(vmId: string) {
  return requestJson<{ vm: VM; commandRun: CommandRun }>(`/api/vms/${vmId}/actions/reboot`, {
    method: 'POST',
  })
}

export function createVm(input: VmConnectionInput) {
  return requestJson<VM>('/api/vms', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateVm(vmId: string, input: VmConnectionInput) {
  return requestJson<VM>(`/api/vms/${vmId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function refreshVm(vmId: string) {
  return requestJson<VM>(`/api/vms/${vmId}`)
}

export function deleteVm(vmId: string) {
  return requestJson<{ vmId: string }>(`/api/vms/${vmId}`, {
    method: 'DELETE',
  })
}

export function listRemoteFiles(vmId: string, path = '/') {
  return requestJson<FileNode[]>(`/api/vms/${vmId}/files?path=${encodeURIComponent(path)}`)
}

export function listLocalFiles(path: string) {
  return requestJson<FileNode[]>(`/api/local/files?path=${encodeURIComponent(path)}`)
}

export function getLocalDefaults() {
  return requestJson<LocalDefaults>('/api/local/defaults')
}

export function openLocalFolder(path: string) {
  return requestJson<{ path: string; name: string }>('/api/local/open-folder', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export function createTransfer(input: {
  vmId: string
  direction: TransferJob['direction']
  source: string
  target: string
  fileName: string
  conflict?: TransferJob['conflict']
}) {
  return requestJson<TransferJob>('/api/transfers', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function sendCopilotMessage(input: { scope: CopilotScope; message: string; referenceHistory?: boolean }) {
  return requestJson<{ messages: AppSnapshot['messages']; proposals: ActionProposal[] }>('/api/copilot/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function cancelCopilot(scope: CopilotScope) {
  return requestJson<{ scope: CopilotScope }>('/api/copilot/cancel', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  })
}

export function getCopilotRuntime() {
  return requestJson<CopilotRuntimeStatus>('/api/copilot/runtime')
}

/**
 * Download and install the kimi-code CLI (uv tool install kimi-cli). Long-running; progress
 * streams via `copilot.install` events while this awaits the final state.
 */
export function installKimiCli() {
  return requestJson<{ install: CopilotInstallState; runtime: CopilotRuntimeStatus }>('/api/copilot/install', {
    method: 'POST',
  })
}

export function getCopilotProvider() {
  return requestJson<CopilotProviderStatus>('/api/copilot/provider')
}

export function saveCopilotProvider(input: { provider: CopilotProvider; apiKey: string; baseUrl: string; model: string }) {
  return requestJson<CopilotProviderStatus>('/api/copilot/provider', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createCopilotProposal(input: {
  vmId: string
  activeTab: TabId
  actionType: ActionProposal['actionType']
}) {
  return requestJson<ActionProposal>('/api/copilot/proposals', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function decideCopilotProposal(proposalId: string, decision: CopilotPermissionDecision) {
  return requestJson<{ proposal: ActionProposal }>(`/api/copilot/proposals/${proposalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  })
}

export function runTerminalCommand(vmId: string, command: string) {
  return requestJson<CommandRun>(`/api/vms/${vmId}/commands`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  })
}

export interface EventsSocketHandle {
  close(): void
}

/**
 * Events stream with automatic reconnection. The dev backend restarts on every server-file
 * save (tsx watch), which kills the socket and rotates the per-boot UI token; without
 * reconnection an open tab silently goes deaf and every mutating call starts failing. A
 * rejected upgrade (e.g. rotated token) surfaces as a plain close, so `onReconnect` fires
 * on every close — BEFORE the next attempt — to re-fetch the bootstrap token in time; on
 * each successful (re)connection the server pushes a `snapshot` event, resyncing state.
 */
export function createEventsSocket(
  onEvent: (event: ServerEvent) => void,
  options: { onReconnect?: () => void } = {},
): EventsSocketHandle {
  let socket: WebSocket | undefined
  let closed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    socket = new WebSocket(websocketUrl('/api/events'))
    socket.addEventListener('open', () => {
      attempts = 0
    })
    socket.addEventListener('message', (event) => {
      onEvent(JSON.parse(String(event.data)) as ServerEvent)
    })
    socket.addEventListener('close', () => {
      if (closed) {
        return
      }
      attempts += 1
      options.onReconnect?.()
      const delay = Math.min(8000, 500 * 2 ** Math.min(attempts - 1, 4)) + Math.floor(Math.random() * 250)
      timer = setTimeout(connect, delay)
    })
  }

  connect()
  return {
    close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
      }
      socket?.close()
    },
  }
}

export function createTerminalSocket(
  vmId: string,
  onEvent: (event: ServerEvent | { type: string; payload: unknown }) => void,
  options?: { cols?: number; rows?: number },
) {
  const query = new URLSearchParams()
  if (options?.cols) {
    query.set('cols', String(options.cols))
  }
  if (options?.rows) {
    query.set('rows', String(options.rows))
  }
  const queryText = query.toString()
  const suffix = queryText ? `?${queryText}` : ''
  const socket = new WebSocket(websocketUrl(`/api/vms/${vmId}/terminal${suffix}`))
  socket.addEventListener('message', (event) => {
    onEvent(JSON.parse(String(event.data)) as ServerEvent | { type: string; payload: unknown })
  })
  return socket
}
