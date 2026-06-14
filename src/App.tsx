import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import {
  AlertTriangle,
  FileText,
  LayoutDashboard,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  Rocket,
  Settings,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityTab } from './components/ActivityTab'
import { AppRunnerTab } from './components/AppRunnerTab'
import { CopilotPanel } from './components/CopilotPanel'
import { FilesTab } from './components/FilesTab'
import { FleetOverviewTab } from './components/FleetOverviewTab'
import { IconButton } from './components/IconButton'
import { LifecycleControls } from './components/LifecycleControls'
import { OverviewTab } from './components/OverviewTab'
import { SettingsTab } from './components/SettingsTab'
import { Sidebar } from './components/Sidebar'
import { StatusPill } from './components/StatusPill'
import { TerminalTab } from './components/TerminalTab'
import { TransferQueue } from './components/TransferQueue'
import { VmEditorDialog } from './components/VmEditorDialog'
import {
  apiDisabled,
  cancelCopilot,
  createAppRunnerService as createAppRunnerProfile,
  createEventsSocket,
  type EventsSocketHandle,
  createTransfer as createTransferJob,
  createVm as createVmProfile,
  decideCopilotProposal,
  deleteAppRunnerService as deleteAppRunnerProfile,
  deleteVm,
  getBootstrap,
  getCopilotProvider,
  getLocalDefaults,
  getSnapshot,
  isApiUnavailableError,
  listAppRunnerServices,
  listLocalFiles,
  listRemoteFiles,
  openLocalFolder as openLocalFolderInOs,
  rebootVm,
  refreshVm,
  saveCopilotProvider,
  sendCopilotMessage,
  setApiToken,
  updateAppRunnerService as updateAppRunnerProfile,
  updateVm as updateVmProfile,
} from './lib/api'
import { cx } from './lib/format'
import {
  initialMessages,
  initialProposals,
  initialTransfers,
  localFiles,
  remoteFilesByVm,
  vmActions,
  vms as fixtureVms,
} from './data/fixtures'
import type {
  AppRunnerService,
  AppRunnerServiceInput,
  ActivityEvent,
  CopilotPermissionDecision,
  CopilotPlanState,
  CopilotProviderStatus,
  CopilotProgressEvent,
  CopilotRuntimeStatus,
  CopilotScope,
  CopilotToolCall,
  FileNode,
  LocalDefaults,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
  VMAction,
  VmConnectionInput,
} from './types'
import { scopeVmId, vmScope } from './types'

const tabs: Array<{ value: TabId; label: string; icon: ReactNode }> = [
  { value: 'overview', label: 'Overview', icon: <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> },
  { value: 'files', label: 'Files', icon: <FileText className="h-4 w-4" aria-hidden="true" /> },
  { value: 'terminal', label: 'Terminal', icon: <TerminalSquare className="h-4 w-4" aria-hidden="true" /> },
  { value: 'apprunner', label: 'AppRunner', icon: <Rocket className="h-4 w-4" aria-hidden="true" /> },
  { value: 'activity', label: 'Activity', icon: <ListChecks className="h-4 w-4" aria-hidden="true" /> },
  { value: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" aria-hidden="true" /> },
]

const visibleVmActions = vmActions.filter(
  (action) => !['start', 'stop', 'suspend', 'snapshot', 'clone'].includes(action.id),
)

const DEFAULT_INFO_PANEL_PERCENT = 50
const MIN_INFO_PANEL_PERCENT = 32
const MAX_INFO_PANEL_PERCENT = 68

const fallbackLocalDefaults: LocalDefaults = {
  workspacePath: localFiles[0]?.path ?? '.',
  downloadsPath: localFiles[0]?.path ?? '.',
  localFilesPath: localFiles[0]?.path ?? '.',
  pathSeparator: '/',
}
const initialProviderStatus: CopilotProviderStatus = {
  provider: 'moonshot',
  configured: false,
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'kimi-k2.6',
}

interface ConflictState {
  file: FileNode
  remotePath: string
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function makeActivity(title: string, detail: string, severity: ActivityEvent['severity'] = 'info'): ActivityEvent {
  return {
    id: `act-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: nowLabel(),
    title,
    detail,
    severity,
  }
}

function nextTransferId() {
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function clampInfoPanelPercent(value: number) {
  return Math.min(Math.max(value, MIN_INFO_PANEL_PERCENT), MAX_INFO_PANEL_PERCENT)
}

function selectAvailableVm(current: string | undefined, availableVms: VM[]) {
  return availableVms.some((vm) => vm.id === current) ? current : availableVms[0]?.id
}

function joinRemotePath(directory: string, fileName: string) {
  return directory === '/' ? `/${fileName}` : `${directory.replace(/\/$/, '')}/${fileName}`
}

function parentRemotePath(path: string) {
  const normalized = path.replace(/\/$/, '') || '/'
  if (normalized === '/') {
    return '/'
  }

  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/'
  return parent
}

function parentLocalPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '')
  // Already at a filesystem root: "/" (POSIX) or "C:"/"C:\\" (Windows drive).
  if (normalized === '' || /^[A-Za-z]:$/.test(normalized)) {
    return path
  }

  const slashIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (slashIndex < 0) {
    return normalized
  }
  if (slashIndex === 0) {
    return '/' // POSIX top-level dir like "/Users" -> root "/"
  }

  const parent = normalized.slice(0, slashIndex)
  // Windows drive root: "C:\\Users" -> "C:\\", not the bare "C:".
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

function joinLocalPath(directory: string, fileName: string, separator: string) {
  const cleanDirectory = directory.replace(/[\\/]+$/, '')
  return cleanDirectory ? `${cleanDirectory}${separator}${fileName}` : fileName
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T) {
  return items.some((item) => item.id === nextItem.id)
    ? items.map((item) => (item.id === nextItem.id ? nextItem : item))
    : [nextItem, ...items]
}

function appendOrReplaceById<T extends { id: string }>(items: T[], nextItem: T) {
  return items.some((item) => item.id === nextItem.id)
    ? items.map((item) => (item.id === nextItem.id ? nextItem : item))
    : [...items, nextItem]
}

function upsertAppService(items: AppRunnerService[], nextItem: AppRunnerService) {
  return items.some((item) => item.name === nextItem.name)
    ? items.map((item) => (item.name === nextItem.name ? nextItem : item))
    : [nextItem, ...items]
}

function isCopilotRunStart(event: CopilotProgressEvent) {
  return event.title === 'Queued copilot request' || event.title === 'Sending request to copilot'
}

function updateCopilotProgress(current: CopilotProgressEvent[], event: CopilotProgressEvent) {
  const otherVmEvents = current.filter((item) => item.vmId !== event.vmId)
  if (isCopilotRunStart(event)) {
    return [event, ...otherVmEvents].slice(0, 18)
  }

  const currentVmEvents = current.filter((item) => item.vmId === event.vmId).slice(0, 7)
  return [event, ...currentVmEvents, ...otherVmEvents].slice(0, 18)
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

function localVmIdFromInput(input: VmConnectionInput, currentVms: VM[]) {
  const base = `vm-${slugify(cleanText(input.name) ?? input.ipAddress) || 'remote'}`
  let nextId = base
  let suffix = 2

  while (currentVms.some((vm) => vm.id === nextId)) {
    nextId = `${base}-${suffix}`
    suffix += 1
  }

  return nextId
}

function localVmFromInput(input: VmConnectionInput, currentVms: VM[], existing?: VM): VM {
  const ipAddress = input.ipAddress.trim()
  const base = existing ?? fixtureVms[0]
  const activity = makeActivity(
    existing ? 'Connection profile updated' : 'VM added',
    `${cleanText(input.user) ?? existing?.connection.user ?? 'root'}@${ipAddress}:${input.port} using ${input.pemPath.trim()}`,
    'success',
  )

  return {
    ...base,
    id: existing?.id ?? localVmIdFromInput(input, currentVms),
    name: cleanText(input.name) ?? existing?.name ?? ipAddress,
    hostname: ipAddress,
    ipAddress,
    os: cleanText(input.os) ?? existing?.os ?? 'Linux',
    provider: {
      name: existing?.provider.name ?? 'SSH',
      region: existing?.provider.region ?? 'remote',
      node: ipAddress,
    },
    health: existing?.health ?? 'warning',
    lifecycle: existing?.lifecycle ?? 'running',
    connection: {
      ...base.connection,
      host: ipAddress,
      user: cleanText(input.user) ?? existing?.connection.user ?? 'root',
      port: input.port,
      keyLabel: input.pemPath.trim(),
      keyStatus: 'present',
      lastConnected: existing?.connection.lastConnected ?? 'not connected',
      testStatus: 'idle',
    },
    metrics: existing?.metrics ?? {
      ...base.metrics,
      cpuPercent: 0,
      memoryPercent: 0,
      diskPercent: 0,
      networkInMbps: 0,
      networkOutMbps: 0,
      loadAverage: [0, 0, 0],
      uptime: 'not sampled',
      sampledAt: 'not sampled',
    },
    alerts: existing?.alerts ?? ['Connection profile has not been tested yet'],
    services: existing?.services ?? [],
    appServices: existing?.appServices ?? [],
    processes: existing?.processes ?? [],
    activity: [activity, ...(existing?.activity ?? [])],
  }
}

function localAppRunnerService(vm: VM, input: AppRunnerServiceInput, existing?: AppRunnerService): AppRunnerService {
  const timestamp = new Date().toISOString()
  const remotePath = `~/services/${input.name}`
  return {
    id: existing?.id ?? `apprunner-${vm.id}-${input.name}`,
    vmId: vm.id,
    name: input.name,
    source: input.source,
    port: input.port,
    remotePath,
    unitName: `grove-apprunner-${input.name}.service`,
    accessUrl: `http://${vm.connection.host}:${input.port}/`,
    state: 'running',
    pid: existing?.pid ?? Math.floor(4000 + Math.random() * 4000),
    cpuPercent: existing?.cpuPercent ?? 1.5,
    memoryMb: existing?.memoryMb ?? 96,
    listening: true,
    installCommand: input.installCommand,
    buildCommand: input.buildCommand,
    startCommand: input.startCommand,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastDeployStatus: 'completed',
    lastDeploySummary: `Service enabled and listening on port ${input.port}.`,
  }
}

function applyLifecycle(vm: VM, action: VMAction): VM {
  if (action.id === 'start') {
    return {
      ...vm,
      lifecycle: 'running',
      health: vm.connection.keyStatus === 'missing' ? 'warning' : 'healthy',
      connection: { ...vm.connection, testStatus: vm.connection.keyStatus === 'missing' ? 'failed' : 'passed' },
    }
  }

  if (action.id === 'stop') {
    return { ...vm, lifecycle: 'stopped', health: 'offline' }
  }

  if (action.id === 'suspend') {
    return { ...vm, lifecycle: 'suspended', health: 'offline' }
  }

  if (action.id === 'reboot') {
    return { ...vm, lifecycle: 'running', health: 'warning' }
  }

  return vm
}

function App() {
  const [vms, setVms] = useState<VM[]>(fixtureVms)
  const [selectedVmId, setSelectedVmId] = useState<string | undefined>(fixtureVms[0]?.id)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [selectedLocalId, setSelectedLocalId] = useState<string | undefined>(localFiles[1]?.id)
  const [localDefaults, setLocalDefaults] = useState<LocalDefaults>(fallbackLocalDefaults)
  const [localPath, setLocalPath] = useState(fallbackLocalDefaults.workspacePath)
  const [localFilesState, setLocalFilesState] = useState<FileNode[]>(localFiles)
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>()
  const [localRefreshTick, setLocalRefreshTick] = useState(0)
  const [selectedRemoteByVm, setSelectedRemoteByVm] = useState<Record<string, string | undefined>>({
    'vm-orchid': 'orchid-compose',
    'vm-cedar': 'cedar-backup',
    'vm-maple': 'maple-readme',
  })
  const [remoteFilesByVmState, setRemoteFilesByVmState] = useState<Record<string, FileNode[]>>(remoteFilesByVm)
  const [remotePathByVm, setRemotePathByVm] = useState<Record<string, string>>({})
  const [remoteLoadingByVm, setRemoteLoadingByVm] = useState<Record<string, boolean>>({})
  const [remoteErrorByVm, setRemoteErrorByVm] = useState<Record<string, string | undefined>>({})
  const [remoteRefreshTick, setRemoteRefreshTick] = useState(0)
  const [transfers, setTransfers] = useState<TransferJob[]>(initialTransfers)
  const [messages, setMessages] = useState(initialMessages)
  const [proposals, setProposals] = useState(initialProposals)
  const [toolCalls, setToolCalls] = useState<CopilotToolCall[]>([])
  const [plans, setPlans] = useState<CopilotPlanState[]>([])
  const [copilotScope, setCopilotScope] = useState<CopilotScope>('fleet')
  const [copilotProgress, setCopilotProgress] = useState<CopilotProgressEvent[]>([])
  const [copilotBusyByScope, setCopilotBusyByScope] = useState<Record<string, boolean>>({})
  const [copilotRuntime, setCopilotRuntime] = useState<CopilotRuntimeStatus>({ driver: 'mock', state: 'disabled' })
  const [providerStatus, setProviderStatus] = useState<CopilotProviderStatus>(initialProviderStatus)
  const deltaBufferRef = useRef<Map<string, string>>(new Map())
  const deltaFrameRef = useRef<number | null>(null)
  const [pendingAction, setPendingAction] = useState<VMAction | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [vmEditorMode, setVmEditorMode] = useState<'add' | 'edit' | null>(null)
  const [isWorkspaceCollapsed, setIsWorkspaceCollapsed] = useState(false)
  const [infoPanelPercent, setInfoPanelPercent] = useState(DEFAULT_INFO_PANEL_PERCENT)
  const [isResizingInfoPanel, setIsResizingInfoPanel] = useState(false)
  const workspaceSplitRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (apiDisabled()) {
      return undefined
    }

    let mounted = true

    // Batch streamed token deltas into one render per animation frame, not one per token.
    const flushDeltas = () => {
      deltaFrameRef.current = null
      const buffer = deltaBufferRef.current
      if (buffer.size === 0) {
        return
      }
      const pending = new Map(buffer)
      buffer.clear()
      setMessages((current) =>
        current.map((message) =>
          pending.has(message.id) ? { ...message, content: message.content + pending.get(message.id)! } : message,
        ),
      )
    }
    const queueDelta = (messageId: string, delta: string) => {
      const buffer = deltaBufferRef.current
      buffer.set(messageId, (buffer.get(messageId) ?? '') + delta)
      if (deltaFrameRef.current != null) {
        return
      }
      deltaFrameRef.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flushDeltas)
          : (setTimeout(flushDeltas, 16) as unknown as number)
    }

    const refreshBootstrap = () => {
      getBootstrap()
        .then((bootstrap) => {
          if (!mounted) {
            return
          }
          setApiToken(bootstrap.token ?? undefined)
          setCopilotRuntime(bootstrap.runtime)
        })
        .catch(() => {
          // Bootstrap (and thus the token) becomes available once the backend is online.
        })
    }
    refreshBootstrap()

    getSnapshot()
      .then((snapshot) => {
        if (!mounted) {
          return
        }

        setVms(snapshot.vms)
        setTransfers(snapshot.transfers)
        setMessages(snapshot.messages)
        setProposals(snapshot.proposals)
        setToolCalls(snapshot.toolCalls ?? [])
        setPlans(snapshot.plans ?? [])
        setCopilotRuntime(snapshot.runtime ?? { driver: 'mock', state: 'disabled' })
        setSelectedVmId((current) => selectAvailableVm(current, snapshot.vms))
      })
      .catch(() => {
        // Keep fixture state when the local backend is not running yet.
      })

    getCopilotProvider()
      .then((status) => {
        if (mounted) {
          setProviderStatus(status)
        }
      })
      .catch(() => {
        // Provider status remains available once the backend comes online.
      })

    if (typeof WebSocket === 'undefined') {
      return () => {
        mounted = false
      }
    }

    let socket: EventsSocketHandle | undefined
    try {
      // On reconnect (e.g. a backend restart) the server pushes a fresh snapshot through
      // the socket; the bootstrap re-fetch picks up the rotated per-boot UI token.
      socket = createEventsSocket((event: ServerEvent) => {
        if (event.type === 'snapshot') {
          setVms(event.payload.vms)
          setTransfers(event.payload.transfers)
          setMessages(event.payload.messages)
          setProposals(event.payload.proposals)
          setToolCalls(event.payload.toolCalls ?? [])
          setPlans(event.payload.plans ?? [])
          setCopilotRuntime(event.payload.runtime ?? { driver: 'mock', state: 'disabled' })
          setSelectedVmId((current) => selectAvailableVm(current, event.payload.vms))
          return
        }

        if (event.type === 'vm.updated') {
          setVms((current) => upsertById(current, event.payload))
          return
        }

        if (event.type === 'vm.deleted') {
          setVms((current) => {
            const remaining = current.filter((vm) => vm.id !== event.payload.vmId)
            setSelectedVmId((selected) => (selected === event.payload.vmId ? remaining[0]?.id : selected))
            return remaining
          })
          return
        }

        if (event.type === 'transfer.updated') {
          setTransfers((current) => upsertById(current, event.payload))
          return
        }

        if (event.type === 'copilot.message') {
          if (!event.payload.streaming) {
            deltaBufferRef.current.delete(event.payload.id)
          }
          setMessages((current) => appendOrReplaceById(current, event.payload))
          return
        }

        if (event.type === 'copilot.delta') {
          queueDelta(event.payload.messageId, event.payload.delta)
          return
        }

        if (event.type === 'copilot.toolcall.updated') {
          setToolCalls((current) => upsertById(current, event.payload))
          return
        }

        if (event.type === 'copilot.plan') {
          setPlans((current) => upsertById(current, event.payload))
          return
        }

        if (event.type === 'copilot.runtime') {
          setCopilotRuntime(event.payload)
          return
        }

        if (event.type === 'copilot.progress') {
          setCopilotProgress((current) => updateCopilotProgress(current, event.payload))
          const scopeKey = event.payload.scope ?? event.payload.vmId
          setCopilotBusyByScope((current) => ({
            ...current,
            [scopeKey]: event.payload.status === 'running',
          }))
          return
        }

        if (event.type === 'copilot.proposal.updated') {
          setProposals((current) => upsertById(current, event.payload))
        }
      }, { onReconnect: refreshBootstrap })
    } catch {
      socket = undefined
    }

    return () => {
      mounted = false
      socket?.close()
    }
  }, [])

  const selectedVm = useMemo(() => vms.find((vm) => vm.id === selectedVmId), [selectedVmId, vms])

  const scopeMessages = useMemo(
    () => messages.filter((message) => (message.scope ?? 'fleet') === copilotScope),
    [messages, copilotScope],
  )
  const scopeProposals = useMemo(
    () => proposals.filter((proposal) => (proposal.scope ?? vmScope(proposal.vmId)) === copilotScope),
    [proposals, copilotScope],
  )
  const scopeToolCalls = useMemo(
    () => toolCalls.filter((toolCall) => toolCall.scope === copilotScope),
    [toolCalls, copilotScope],
  )
  const scopePlans = useMemo(() => plans.filter((plan) => plan.scope === copilotScope), [plans, copilotScope])
  const scopeProgress = useMemo(
    () => copilotProgress.filter((event) => (event.scope ?? event.vmId) === copilotScope),
    [copilotProgress, copilotScope],
  )
  const scopeIsBusy = copilotBusyByScope[copilotScope] ?? false
  const copilotScopeLabel = copilotScope === 'fleet' ? 'All VMs' : selectedVm?.name ?? scopeVmId(copilotScope) ?? 'VM'
  const busyScopes = useMemo(
    () => new Set(Object.entries(copilotBusyByScope).filter(([, busy]) => busy).map(([scope]) => scope)),
    [copilotBusyByScope],
  )
  const attentionScopes = useMemo(
    () =>
      new Set(
        proposals
          .filter((proposal) => proposal.status === 'awaiting_confirmation')
          .map((proposal) => proposal.scope ?? vmScope(proposal.vmId)),
      ),
    [proposals],
  )

  function selectScope(scope: CopilotScope) {
    setCopilotScope(scope)
    const vmId = scopeVmId(scope)
    if (vmId) {
      setSelectedVmId(vmId)
    }
  }
  const currentRemotePath = selectedVm ? remotePathByVm[selectedVm.id] ?? '/root' : '/'
  const remoteFiles = selectedVm ? remoteFilesByVmState[selectedVm.id] ?? [] : []
  const selectedRemoteId = selectedVm ? selectedRemoteByVm[selectedVm.id] : undefined
  const remoteLoading = selectedVm ? remoteLoadingByVm[selectedVm.id] ?? false : false
  const remoteError = selectedVm ? remoteErrorByVm[selectedVm.id] : undefined
  const remoteVmId = selectedVm?.id
  const splitPanelStyles = {
    '--copilot-split-percent': `${100 - infoPanelPercent}%`,
    '--info-split-percent': `${infoPanelPercent}%`,
  } as CSSProperties

  const resizeInfoPanel = useCallback((clientX: number) => {
    const bounds = workspaceSplitRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0) {
      return
    }

    const nextPercent = ((bounds.right - clientX) / bounds.width) * 100
    setInfoPanelPercent(clampInfoPanelPercent(nextPercent))
  }, [])

  function beginInfoPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth < 1024 || isWorkspaceCollapsed) {
      return
    }

    event.preventDefault()
    resizeInfoPanel(event.clientX)
    setIsResizingInfoPanel(true)
  }

  function resizeInfoPanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }

    event.preventDefault()
    setInfoPanelPercent((current) =>
      clampInfoPanelPercent(current + (event.key === 'ArrowLeft' ? 3 : -3)),
    )
  }

  useEffect(() => {
    if (!isResizingInfoPanel) {
      return undefined
    }

    const originalCursor = document.body.style.cursor
    const originalUserSelect = document.body.style.userSelect

    function handlePointerMove(event: PointerEvent) {
      resizeInfoPanel(event.clientX)
    }

    function stopResize() {
      setIsResizingInfoPanel(false)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)

    return () => {
      document.body.style.cursor = originalCursor
      document.body.style.userSelect = originalUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
    }
  }, [isResizingInfoPanel, resizeInfoPanel])

  useEffect(() => {
    if (apiDisabled()) {
      return undefined
    }

    let cancelled = false

    getLocalDefaults()
      .then((defaults) => {
        if (cancelled) {
          return
        }

        setLocalDefaults(defaults)
        setLocalPath((current) => (current === fallbackLocalDefaults.workspacePath ? defaults.workspacePath : current))
      })
      .catch(() => {
        // Fixture defaults keep the UI usable when the backend is restarting.
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'apprunner' || !selectedVmId || apiDisabled()) {
      return undefined
    }

    let cancelled = false
    const vmId = selectedVmId

    listAppRunnerServices(vmId)
      .then((appServices) => {
        if (!cancelled) {
          setVms((current) =>
            current.map((vm) => (vm.id === vmId ? { ...vm, appServices } : vm)),
          )
        }
      })
      .catch(() => {
        // Keep snapshot data if the backend is unavailable while switching tabs.
      })

    return () => {
      cancelled = true
    }
  }, [activeTab, selectedVmId])

  useEffect(() => {
    if (apiDisabled()) {
      return undefined
    }

    let cancelled = false
    const path = localPath

    Promise.resolve()
      .then(() => {
        if (!cancelled) {
          setLocalLoading(true)
          setLocalError(undefined)
        }
      })
      .then(() => listLocalFiles(path))
      .then((files) => {
        if (cancelled) {
          return
        }

        setLocalFilesState(files)
        setSelectedLocalId((current) => {
          if (current && files.some((file) => file.id === current)) {
            return current
          }

          return files.find((file) => file.type === 'file')?.id ?? files[0]?.id
        })
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        setLocalFilesState([])
        setLocalError(error instanceof Error ? error.message : 'Local folder could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) {
          setLocalLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [localPath, localRefreshTick])

  useEffect(() => {
    if (!remoteVmId || apiDisabled()) {
      return undefined
    }

    let cancelled = false
    const vmId = remoteVmId
    const path = currentRemotePath

    Promise.resolve()
      .then(() => {
        if (!cancelled) {
          setRemoteLoadingByVm((current) => ({ ...current, [vmId]: true }))
          setRemoteErrorByVm((current) => ({ ...current, [vmId]: undefined }))
        }
      })
      .then(() => listRemoteFiles(vmId, path))
      .then((files) => {
        if (cancelled) {
          return
        }

        setRemoteFilesByVmState((current) => ({ ...current, [vmId]: files }))
        setSelectedRemoteByVm((current) => {
          const currentSelection = current[vmId]
          if (currentSelection && files.some((file) => file.id === currentSelection)) {
            return current
          }

          return { ...current, [vmId]: files.find((file) => file.type === 'file')?.id ?? files[0]?.id }
        })
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Remote directory could not be loaded.'
        setRemoteFilesByVmState((current) => ({ ...current, [vmId]: [] }))
        setRemoteErrorByVm((current) => ({ ...current, [vmId]: message }))
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteLoadingByVm((current) => ({ ...current, [vmId]: false }))
        }
      })

    return () => {
      cancelled = true
    }
  }, [remoteVmId, currentRemotePath, remoteRefreshTick])

  function addActivity(vmId: string, activity: ActivityEvent) {
    setVms((current) =>
      current.map((vm) => (vm.id === vmId ? { ...vm, activity: [activity, ...vm.activity] } : vm)),
    )
  }

  async function runAction(action: VMAction) {
    if (!selectedVm) {
      return
    }

    if (action.id === 'delete') {
      if (!apiDisabled()) {
        try {
          await deleteVm(selectedVm.id)
          setPendingAction(null)
          return
        } catch {
          // Fall back to local state so the UI remains usable during backend restarts.
        }
      }

      setVms((current) => current.filter((vm) => vm.id !== selectedVm.id))
      setSelectedVmId((currentSelected) => {
        const remaining = vms.filter((vm) => vm.id !== selectedVm.id)
        return currentSelected === selectedVm.id ? remaining[0]?.id : currentSelected
      })
      setPendingAction(null)
      return
    }

    if (action.id === 'reboot' && !apiDisabled()) {
      try {
        const result = await rebootVm(selectedVm.id)
        setVms((current) => upsertById(current, result.vm))
        setPendingAction(null)
        return
      } catch {
        // Fall back to local state so the UI remains usable during backend restarts.
      }
    }

    if (action.id === 'clone') {
      const clone: VM = {
        ...selectedVm,
        id: `${selectedVm.id}-copy`,
        name: `${selectedVm.name}-copy`,
        hostname: `${selectedVm.hostname}-copy`,
        health: 'offline',
        lifecycle: 'stopped',
        activity: [
          makeActivity('Clone created', `Created from ${selectedVm.name}.`, 'success'),
          ...selectedVm.activity,
        ],
      }
      setVms((current) => [...current, clone])
      addActivity(selectedVm.id, makeActivity('Clone job completed', action.mockResult, 'success'))
      setPendingAction(null)
      return
    }

    setVms((current) =>
      current.map((vm) =>
        vm.id === selectedVm.id
          ? {
              ...applyLifecycle(vm, action),
              activity: [makeActivity(`${action.label} requested`, action.mockResult, 'success'), ...vm.activity],
            }
          : vm,
      ),
    )
    setPendingAction(null)
  }

  function handleLifecycle(action: VMAction) {
    if (action.requiresConfirmation) {
      setPendingAction(action)
      return
    }

    void runAction(action)
  }

  async function createTransfer(direction: TransferJob['direction'], file: FileNode, target: string, conflictMode?: TransferJob['conflict']) {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        const transfer = await createTransferJob({
          vmId: selectedVm.id,
          direction,
          source: file.path,
          target,
          fileName: file.name,
          conflict: conflictMode,
        })
        setTransfers((current) => upsertById(current, transfer))
        if (direction === 'upload') {
          setRemoteRefreshTick((current) => current + 1)
        }
        if (direction === 'download') {
          setLocalPath(localDefaults.downloadsPath)
          setLocalRefreshTick((current) => current + 1)
        }
        return
      } catch {
        // Fall back to local transfer state if the backend is unavailable.
      }
    }

    const job: TransferJob = {
      id: nextTransferId(),
      vmId: selectedVm.id,
      direction,
      source: file.path,
      target,
      fileName: file.name,
      status: direction === 'copy' ? 'completed' : 'in_progress',
      progress: direction === 'copy' ? 100 : conflictMode ? 56 : 68,
      speed: conflictMode ? 'overwriting remote file' : direction === 'download' ? '18.2 MB/s' : '12.4 MB/s',
      conflict: conflictMode,
    }

    setTransfers((current) => [job, ...current])
    if (direction === 'upload') {
      setRemoteRefreshTick((current) => current + 1)
    }
    if (direction === 'download') {
      setLocalPath(localDefaults.downloadsPath)
      setLocalRefreshTick((current) => current + 1)
    }
    addActivity(
      selectedVm.id,
      makeActivity(
        direction === 'download' ? 'Download started' : 'Upload started',
        `${file.name} -> ${target}`,
        conflictMode ? 'warning' : 'info',
      ),
    )
  }

  function uploadSelected() {
    const file = localFilesState.find((item) => item.id === selectedLocalId)
    if (!selectedVm || !file || file.type === 'folder') {
      return
    }

    const matchingRemote = remoteFiles.find((remoteFile) => remoteFile.name === file.name)
    if (matchingRemote) {
      setConflict({ file, remotePath: matchingRemote.path })
      return
    }

    void createTransfer('upload', file, joinRemotePath(currentRemotePath, file.name))
  }

  function downloadSelected() {
    const file = remoteFiles.find((item) => item.id === selectedRemoteId)
    if (!file || file.type === 'folder') {
      return
    }

    void createTransfer('download', file, joinLocalPath(localDefaults.downloadsPath, file.name, localDefaults.pathSeparator))
  }

  function copyRemotePath() {
    const file = remoteFiles.find((item) => item.id === selectedRemoteId)
    if (!file || !selectedVm) {
      return
    }

    if (navigator.clipboard) {
      void navigator.clipboard.writeText(file.path)
    }

    addActivity(selectedVm.id, makeActivity('Remote path copied', file.path, 'info'))
  }

  function resolveConflict(mode: 'overwrite' | 'rename' | 'skip') {
    if (!conflict) {
      return
    }

    if (mode !== 'skip') {
      const target =
        mode === 'rename'
          ? conflict.remotePath.replace(/(\.[^/.]+)?$/, '.copy$1')
          : conflict.remotePath
      void createTransfer('upload', conflict.file, target, mode)
    }

    setConflict(null)
  }

  function openRemoteFolder(file: FileNode) {
    if (!selectedVm || file.type !== 'folder') {
      return
    }

    setRemotePathByVm((current) => ({ ...current, [selectedVm.id]: file.path }))
    setSelectedRemoteByVm((current) => ({ ...current, [selectedVm.id]: undefined }))
  }

  function openLocalFolder(file: FileNode) {
    if (file.type !== 'folder') {
      setSelectedLocalId(file.id)
      return
    }

    setLocalPath(file.path)
    setSelectedLocalId(undefined)
  }

  function activateRemoteFile(file: FileNode) {
    if (!selectedVm) {
      return
    }

    setSelectedRemoteByVm((current) => ({ ...current, [selectedVm.id]: file.id }))

    if (file.type === 'folder') {
      openRemoteFolder(file)
      return
    }

    void createTransfer('download', file, joinLocalPath(localDefaults.downloadsPath, file.name, localDefaults.pathSeparator))
  }

  function activateLocalFile(file: FileNode) {
    openLocalFolder(file)
  }

  function goLocalUp() {
    setLocalPath(parentLocalPath(localPath))
    setSelectedLocalId(undefined)
  }

  function refreshLocalFiles() {
    setLocalRefreshTick((current) => current + 1)
  }

  async function openCurrentLocalFolder() {
    if (apiDisabled()) {
      return
    }

    try {
      await openLocalFolderInOs(localPath)
    } catch {
      // The folder remains visible in the pane if the OS shell cannot be launched.
    }
  }

  function goRemoteUp() {
    if (!selectedVm) {
      return
    }

    setRemotePathByVm((current) => ({ ...current, [selectedVm.id]: parentRemotePath(currentRemotePath) }))
    setSelectedRemoteByVm((current) => ({ ...current, [selectedVm.id]: undefined }))
  }

  function refreshRemoteFiles() {
    setRemoteRefreshTick((current) => current + 1)
  }

  async function createAppService(input: AppRunnerServiceInput) {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        const service = await createAppRunnerProfile(selectedVm.id, input)
        setVms((current) =>
          current.map((vm) =>
            vm.id === selectedVm.id ? { ...vm, appServices: upsertAppService(vm.appServices, service) } : vm,
          ),
        )
        return
      } catch (error) {
        if (!isApiUnavailableError(error)) {
          throw error
        }
      }
    }

    const duplicateName = selectedVm.appServices.some((service) => service.name === input.name)
    if (duplicateName) {
      throw new Error(`AppRunner service ${input.name} already exists on ${selectedVm.name}.`)
    }
    const duplicatePort = selectedVm.appServices.find((service) => service.port === input.port)
    if (duplicatePort) {
      throw new Error(`Port ${input.port} is already assigned to ${duplicatePort.name}.`)
    }

    const service = localAppRunnerService(selectedVm, input)
    setVms((current) =>
      current.map((vm) =>
        vm.id === selectedVm.id
          ? {
              ...vm,
              appServices: upsertAppService(vm.appServices, service),
              activity: [makeActivity('AppRunner service created', `${service.name} listening on port ${service.port}.`, 'success'), ...vm.activity],
            }
          : vm,
      ),
    )
  }

  async function updateAppService(serviceName: string, input: AppRunnerServiceInput) {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        const service = await updateAppRunnerProfile(selectedVm.id, serviceName, input)
        setVms((current) =>
          current.map((vm) =>
            vm.id === selectedVm.id ? { ...vm, appServices: upsertAppService(vm.appServices, service) } : vm,
          ),
        )
        return
      } catch (error) {
        if (!isApiUnavailableError(error)) {
          throw error
        }
      }
    }

    const existing = selectedVm.appServices.find((service) => service.name === serviceName)
    if (!existing) {
      throw new Error('AppRunner service not found.')
    }
    const duplicatePort = selectedVm.appServices.find((service) => service.name !== serviceName && service.port === input.port)
    if (duplicatePort) {
      throw new Error(`Port ${input.port} is already assigned to ${duplicatePort.name}.`)
    }

    const service = localAppRunnerService(selectedVm, input, existing)
    setVms((current) =>
      current.map((vm) =>
        vm.id === selectedVm.id
          ? {
              ...vm,
              appServices: upsertAppService(vm.appServices, service),
              activity: [makeActivity('AppRunner service updated', `${service.name} restarted on port ${service.port}.`, 'success'), ...vm.activity],
            }
          : vm,
      ),
    )
  }

  async function removeAppService(serviceName: string) {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        await deleteAppRunnerProfile(selectedVm.id, serviceName)
        setVms((current) =>
          current.map((vm) =>
            vm.id === selectedVm.id
              ? { ...vm, appServices: vm.appServices.filter((service) => service.name !== serviceName) }
              : vm,
          ),
        )
        return
      } catch (error) {
        if (!isApiUnavailableError(error)) {
          throw error
        }
      }
    }

    setVms((current) =>
      current.map((vm) =>
        vm.id === selectedVm.id
          ? {
              ...vm,
              appServices: vm.appServices.filter((service) => service.name !== serviceName),
              activity: [makeActivity('AppRunner service removed', `${serviceName} and ~/services/${serviceName} purged.`, 'success'), ...vm.activity],
            }
          : vm,
      ),
    )
  }

  async function testConnection() {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        const vm = await refreshVm(selectedVm.id)
        setVms((current) => upsertById(current, vm))
        return
      } catch {
        // Fall back to local state when the backend is restarting.
      }
    }

    const nextStatus = selectedVm.connection.keyStatus === 'missing' ? 'failed' : 'passed'
    setVms((current) =>
      current.map((vm) =>
        vm.id === selectedVm.id
          ? {
              ...vm,
              health: nextStatus === 'passed' ? 'healthy' : 'critical',
              lifecycle: nextStatus === 'passed' ? 'running' : vm.lifecycle,
              alerts: nextStatus === 'passed' ? ['No active alerts'] : ['Connection profile is incomplete or unreachable'],
              connection: { ...vm.connection, testStatus: nextStatus },
              activity: [
                makeActivity(
                  nextStatus === 'passed' ? 'SSH test passed' : 'SSH test failed',
                  nextStatus === 'passed'
                    ? `Connected to ${vm.connection.user}@${vm.connection.host}:${vm.connection.port}.`
                    : 'Connection profile is incomplete or the VM is not reachable.',
                  nextStatus === 'passed' ? 'success' : 'critical',
                ),
                ...vm.activity,
              ],
            }
          : vm,
      ),
    )
  }

  async function sendMessage(content: string, options?: { referenceHistory?: boolean }) {
    const scope = copilotScope
    setCopilotBusyByScope((current) => ({ ...current, [scope]: true }))

    if (!apiDisabled()) {
      try {
        // The user and streamed assistant messages arrive over the events socket; the POST
        // resolves when the turn completes and is only a fallback for the final state.
        const response = await sendCopilotMessage({ scope, message: content, referenceHistory: options?.referenceHistory })
        setMessages((current) => response.messages.reduce((items, message) => appendOrReplaceById(items, message), current))
        setProposals((current) => response.proposals.reduce((items, proposal) => upsertById(items, proposal), current))
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Copilot request failed.'
        setCopilotBusyByScope((current) => ({ ...current, [scope]: false }))
        setMessages((current) => [
          ...current,
          { id: `msg-${Date.now()}-assistant`, role: 'assistant', content: message, timestamp: nowLabel(), scope },
        ])
        return
      }
    }

    setMessages((current) => [
      ...current,
      { id: `msg-${Date.now()}-user`, role: 'user', content, timestamp: nowLabel(), scope },
      {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: 'The local backend is offline. Start it with `npm run dev` to use the kimi copilot.',
        timestamp: nowLabel(),
        scope,
      },
    ])
    setCopilotBusyByScope((current) => ({ ...current, [scope]: false }))
  }

  async function cancelCopilotRun() {
    const scope = copilotScope
    if (!apiDisabled()) {
      try {
        await cancelCopilot(scope)
      } catch {
        // The run may have already finished; clearing busy below is enough.
      }
    }
    setCopilotBusyByScope((current) => ({ ...current, [scope]: false }))
  }

  function openWorkspaceTarget(target: { vmId?: string; tab?: TabId }) {
    const targetVmId = target.vmId ?? scopeVmId(copilotScope) ?? selectedVmId
    if (targetVmId) {
      selectScope(vmScope(targetVmId))
      setIsWorkspaceCollapsed(false)
    }
    if (target.tab) {
      setActiveTab(target.tab)
      setIsWorkspaceCollapsed(false)
    }
  }

  async function saveProvider(input: { apiKey: string; baseUrl: string; model: string }) {
    if (apiDisabled()) {
      setProviderStatus({ provider: 'moonshot', configured: true, baseUrl: input.baseUrl, model: input.model })
      return
    }

    const status = await saveCopilotProvider(input)
    setProviderStatus(status)
  }

  async function saveVmProfile(input: VmConnectionInput) {
    if (vmEditorMode === 'edit') {
      if (!selectedVm) {
        throw new Error('No VM selected.')
      }

      if (!apiDisabled()) {
        try {
          const vm = await updateVmProfile(selectedVm.id, input)
          setVms((current) => upsertById(current, vm))
          // Route through selectScope so the panel leaves the fleet dashboard for the VM.
          selectScope(vmScope(vm.id))
          return
        } catch (error) {
          if (!isApiUnavailableError(error)) {
            throw error
          }
        }
      }

      setVms((current) =>
        current.map((vm) => (vm.id === selectedVm.id ? localVmFromInput(input, current, vm) : vm)),
      )
      return
    }

    if (!apiDisabled()) {
      try {
        const vm = await createVmProfile(input)
        setVms((current) => upsertById(current, vm))
        selectScope(vmScope(vm.id))
        return
      } catch (error) {
        if (!isApiUnavailableError(error)) {
          throw error
        }
      }
    }

    const vm = localVmFromInput(input, vms)
    setVms((current) => [vm, ...current])
    selectScope(vmScope(vm.id))
  }

  async function decideProposal(proposalId: string, decision: CopilotPermissionDecision) {
    const proposal = proposals.find((item) => item.id === proposalId)
    if (!proposal) {
      return
    }

    // Acknowledge the click immediately: the card swaps its buttons for an "executing"
    // state while the backend runs the command (the executed/dismissed update can take as
    // long as the SSH command itself).
    setProposals((current) => current.map((item) => (item.id === proposalId ? { ...item, decision } : item)))

    if (!apiDisabled()) {
      try {
        const result = await decideCopilotProposal(proposalId, decision)
        // The executed/dismissed event can race ahead of this response over the socket
        // (a fast command finishes before the HTTP response flushes). The response is a
        // decision-time snapshot, so never let it regress a proposal that already settled.
        setProposals((current) =>
          current.map((item) => {
            if (item.id !== proposalId) {
              return item
            }
            const stillAwaiting = item.status === 'awaiting_confirmation' || item.status === 'pending_confirmation'
            return stillAwaiting ? result.proposal : item
          }),
        )
        return
      } catch {
        // Fall back to local state if the backend is unavailable.
      }
    }

    setProposals((current) =>
      current.map((item) =>
        item.id === proposalId
          ? {
              ...item,
              decision,
              status: decision === 'deny' ? 'dismissed' : 'executed',
              result: decision === 'deny' ? 'Dismissed by user.' : 'Mock command completed and logged to activity.',
            }
          : item,
      ),
    )
    if (decision !== 'deny') {
      addActivity(proposal.vmId, makeActivity(proposal.title, 'Copilot action executed from confirmed proposal.', 'success'))
    }
  }

  return (
    <div className="flex h-svh flex-col overflow-auto bg-slate-50 text-slate-900 lg:flex-row lg:overflow-hidden">
      <Sidebar
        vms={vms}
        activeScope={copilotScope}
        onSelectScope={selectScope}
        busyScopes={busyScopes}
        attentionScopes={attentionScopes}
        onAddVm={() => setVmEditorMode('add')}
      />

      <div
        ref={workspaceSplitRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row"
        style={splitPanelStyles}
      >
        <div
          className={cx(
            'flex min-w-0 flex-col',
            isWorkspaceCollapsed ? 'lg:flex-1' : 'lg:w-[var(--copilot-split-percent)] lg:flex-none',
          )}
        >
          <CopilotPanel
            scope={copilotScope}
            scopeLabel={copilotScopeLabel}
            runtime={copilotRuntime}
            messages={scopeMessages}
            toolCalls={scopeToolCalls}
            plans={scopePlans}
            progress={scopeProgress}
            proposals={scopeProposals}
            isBusy={scopeIsBusy}
            onSendMessage={sendMessage}
            onOpenWorkspaceTarget={openWorkspaceTarget}
            onDecideProposal={decideProposal}
            onCancel={cancelCopilotRun}
          />
        </div>

        {!isWorkspaceCollapsed ? (
          <div
            role="separator"
            aria-label="Resize copilot and information panels"
            aria-orientation="vertical"
            aria-valuemin={MIN_INFO_PANEL_PERCENT}
            aria-valuemax={MAX_INFO_PANEL_PERCENT}
            aria-valuenow={Math.round(infoPanelPercent)}
            tabIndex={0}
            onPointerDown={beginInfoPanelResize}
            onKeyDown={resizeInfoPanelWithKeyboard}
            className="group relative z-10 hidden w-3 shrink-0 cursor-col-resize items-center justify-center bg-slate-50 outline-none lg:flex"
          >
            <span className="h-12 w-0.5 rounded bg-slate-300 opacity-60 transition group-hover:opacity-100 group-focus:opacity-100" />
          </div>
        ) : null}

        <main
          className={cx(
            'flex min-h-[520px] min-w-0 flex-col border-l border-slate-200 bg-slate-50 transition-[width] duration-200 lg:min-h-0 lg:flex-none',
            isWorkspaceCollapsed ? 'lg:w-16' : 'lg:w-[var(--info-split-percent)]',
          )}
        >
        {isWorkspaceCollapsed ? (
          <section className="hidden h-full flex-col items-center gap-2 bg-white px-2 py-3 lg:flex">
            <IconButton label="Expand VM workspace" onClick={() => setIsWorkspaceCollapsed(false)}>
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            {copilotScope !== 'fleet' ? (
              <div className="mt-2 flex flex-col gap-1" aria-label="VM sections">
                {tabs.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    aria-label={`Open ${tab.label}`}
                    onClick={() => {
                      setActiveTab(tab.value)
                      setIsWorkspaceCollapsed(false)
                    }}
                    className={cx(
                      'inline-flex h-9 w-9 items-center justify-center rounded border text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900',
                      activeTab === tab.value ? 'border-slate-300 bg-slate-50 text-slate-950' : 'border-transparent',
                    )}
                  >
                    {tab.icon}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        <div className={cx('flex min-h-0 flex-1 flex-col', isWorkspaceCollapsed && 'lg:hidden')}>
        {copilotScope === 'fleet' ? (
          <FleetOverviewTab
            vms={vms}
            onSelectVm={(vmId) => selectScope(vmScope(vmId))}
            onCollapse={() => setIsWorkspaceCollapsed(true)}
          />
        ) : selectedVm ? (
          <>
            <header className="border-b border-slate-200 bg-white px-4 py-3">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold tracking-normal text-slate-950">{selectedVm.name}</h2>
                    <StatusPill status={selectedVm.health} />
                  </div>
                  <p className="truncate text-sm text-slate-500">
                    {selectedVm.hostname} / {selectedVm.ipAddress} / {selectedVm.os}
                  </p>
                </div>
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <LifecycleControls lifecycle={selectedVm.lifecycle} actions={visibleVmActions} onAction={handleLifecycle} />
                  <IconButton
                    label="Collapse VM workspace"
                    onClick={() => setIsWorkspaceCollapsed(true)}
                    className="hidden lg:inline-flex"
                  >
                    <PanelRightClose className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>

              <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)}>
                <Tabs.List className="flex gap-1 overflow-x-auto" aria-label="VM sections">
                  {tabs.map((tab) => (
                    <Tabs.Trigger
                      key={tab.value}
                      value={tab.value}
                      className="inline-flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent px-2 text-sm font-medium text-slate-500 transition hover:text-slate-900 data-[state=active]:border-slate-950 data-[state=active]:text-slate-950"
                    >
                      {tab.icon}
                      {tab.label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
            </header>

            <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)} className="min-h-0 flex-1">
              <div className="h-full overflow-auto bg-slate-50 p-4">
                <Tabs.Content value="overview" className="outline-none">
                  <OverviewTab vm={selectedVm} />
                </Tabs.Content>
                <Tabs.Content value="files" className="space-y-3 outline-none">
                  <FilesTab
                    vm={selectedVm}
                    localFiles={localFilesState}
                    remoteFiles={remoteFiles}
                    localPath={localPath}
                    remotePath={currentRemotePath}
                    localLoading={localLoading}
                    localError={localError}
                    remoteLoading={remoteLoading}
                    remoteError={remoteError}
                    selectedLocalId={selectedLocalId}
                    selectedRemoteId={selectedRemoteId}
                    onSelectLocal={setSelectedLocalId}
                    onSelectRemote={(fileId) =>
                      setSelectedRemoteByVm((current) => ({ ...current, [selectedVm.id]: fileId }))
                    }
                    onActivateLocal={activateLocalFile}
                    onActivateRemote={activateRemoteFile}
                    onLocalUp={goLocalUp}
                    onRefreshLocal={refreshLocalFiles}
                    onOpenLocalFolder={openCurrentLocalFolder}
                    onOpenRemoteFolder={openRemoteFolder}
                    onRemoteUp={goRemoteUp}
                    onRefreshRemote={refreshRemoteFiles}
                    onUpload={uploadSelected}
                    onDownload={downloadSelected}
                    onCopyRemotePath={copyRemotePath}
                  />
                  <TransferQueue transfers={transfers} vms={vms} />
                </Tabs.Content>
                <Tabs.Content value="terminal" className="h-full outline-none">
                  <TerminalTab
                    key={selectedVm.id}
                    vm={selectedVm}
                    onCommand={(command, output) =>
                      addActivity(selectedVm.id, makeActivity(`Command ran: ${command}`, output.split('\n')[0], 'info'))
                    }
                  />
                </Tabs.Content>
                <Tabs.Content value="apprunner" className="outline-none">
                  <AppRunnerTab
                    vm={selectedVm}
                    defaultLocalPath={localDefaults.workspacePath}
                    onCreateService={createAppService}
                    onUpdateService={updateAppService}
                    onRemoveService={removeAppService}
                  />
                </Tabs.Content>
                <Tabs.Content value="activity" className="outline-none">
                  <ActivityTab vm={selectedVm} transfers={transfers} />
                </Tabs.Content>
                <Tabs.Content value="settings" className="outline-none">
                  <SettingsTab
                    key={`${providerStatus.configured}-${providerStatus.baseUrl}-${providerStatus.model}`}
                    vm={selectedVm}
                    providerStatus={providerStatus}
                    onTestConnection={testConnection}
                    onEditVm={() => setVmEditorMode('edit')}
                    onSaveProvider={saveProvider}
                  />
                </Tabs.Content>
              </div>
            </Tabs.Root>

          </>
        ) : (
          <section className="m-4 rounded border border-slate-200 bg-white p-6 text-center">
            <h2 className="text-lg font-semibold text-slate-950">No VM selected</h2>
            <p className="mt-1 text-sm text-slate-500">The inventory is empty or the selected VM was removed.</p>
          </section>
        )}
        </div>
        </main>
      </div>

      <VmEditorDialog
        key={`${vmEditorMode ?? 'closed'}-${selectedVm?.id ?? 'none'}`}
        open={vmEditorMode !== null}
        mode={vmEditorMode ?? 'add'}
        vm={selectedVm}
        onOpenChange={(open) => {
          if (!open) {
            setVmEditorMode(null)
          }
        }}
        onSave={saveVmProfile}
      />

      <Dialog.Root open={Boolean(pendingAction)} onOpenChange={(open) => !open && setPendingAction(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold text-slate-950">
                  Confirm {pendingAction?.label}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-slate-500">{pendingAction?.detail}</Dialog.Description>
              </div>
              <IconButton label="Close confirmation" onClick={() => setPendingAction(null)}>
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
            <div className="mb-4 flex gap-2 rounded border border-amber-200 bg-white p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              This action runs through the local backend when available and records an activity entry.
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="h-8 rounded border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => pendingAction && runAction(pendingAction)}
                className="h-8 rounded border border-slate-900 bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800"
              >
                Confirm action
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(conflict)} onOpenChange={(open) => !open && setConflict(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-xl">
            <Dialog.Title className="text-base font-semibold text-slate-950">File conflict</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-slate-500">
              {conflict?.file.name} already exists at {conflict?.remotePath}. Choose how the transfer should proceed.
            </Dialog.Description>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => resolveConflict('overwrite')}
                className="h-9 rounded border border-amber-200 bg-white px-3 text-xs font-medium text-amber-800 hover:bg-amber-50"
              >
                Overwrite
              </button>
              <button
                type="button"
                onClick={() => resolveConflict('rename')}
                className="h-9 rounded border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => resolveConflict('skip')}
                className="h-9 rounded border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Skip
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export default App
