import type {
  ActionProposal,
  AppSnapshot,
  AppRunnerService,
  AppRunnerServiceInput,
  CommandRun,
  CopilotPermissionDecision,
  CopilotProviderStatus,
  CopilotRuntimeStatus,
  CopilotScope,
  FileNode,
  LocalDefaults,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
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
  const explicit = import.meta.env.VITE_API_WS_URL
  if (explicit) {
    return `${explicit}${path}`
  }

  const url = new URL(path, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
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

export function getBootstrap() {
  return requestJson<{ token: string | null; runtime: CopilotRuntimeStatus }>('/api/bootstrap')
}

export function getSnapshot() {
  return requestJson<AppSnapshot>('/api/snapshot')
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

export function listAppRunnerServices(vmId: string) {
  return requestJson<AppRunnerService[]>(`/api/vms/${vmId}/app-services`)
}

export function createAppRunnerService(vmId: string, input: AppRunnerServiceInput) {
  return requestJson<AppRunnerService>(`/api/vms/${vmId}/app-services`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateAppRunnerService(vmId: string, serviceName: string, input: AppRunnerServiceInput) {
  return requestJson<AppRunnerService>(`/api/vms/${vmId}/app-services/${encodeURIComponent(serviceName)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function deleteAppRunnerService(vmId: string, serviceName: string) {
  return requestJson<{ serviceName: string }>(`/api/vms/${vmId}/app-services/${encodeURIComponent(serviceName)}`, {
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

export function sendCopilotMessage(input: { scope: CopilotScope; message: string }) {
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

export function getCopilotProvider() {
  return requestJson<CopilotProviderStatus>('/api/copilot/provider')
}

export function saveCopilotProvider(input: { apiKey: string; baseUrl: string; model: string }) {
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
 * reconnection an open tab silently goes deaf and every mutating call starts failing. On
 * each (re)connection the server pushes a fresh `snapshot` event, so state resyncs itself;
 * `onReconnect` lets the caller refresh the bootstrap token as well.
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
      const wasReconnect = attempts > 0
      attempts = 0
      if (wasReconnect) {
        options.onReconnect?.()
      }
    })
    socket.addEventListener('message', (event) => {
      onEvent(JSON.parse(String(event.data)) as ServerEvent)
    })
    socket.addEventListener('close', () => {
      if (closed) {
        return
      }
      attempts += 1
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
