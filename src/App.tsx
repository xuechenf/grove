import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { AlertTriangle, FileText, LayoutDashboard, ListChecks, Rocket, Settings, TerminalSquare, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ActivityTab } from './components/ActivityTab'
import { AppRunnerTab } from './components/AppRunnerTab'
import { CopilotPanel } from './components/CopilotPanel'
import { FilesTab } from './components/FilesTab'
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
  confirmCopilotProposal,
  createAppRunnerService as createAppRunnerProfile,
  createCopilotProposal,
  createEventsSocket,
  createTransfer as createTransferJob,
  createVm as createVmProfile,
  deleteAppRunnerService as deleteAppRunnerProfile,
  deleteVm,
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
  updateAppRunnerService as updateAppRunnerProfile,
  updateVm as updateVmProfile,
} from './lib/api'
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
  ActionProposal,
  AppRunnerService,
  AppRunnerServiceInput,
  ActivityEvent,
  CopilotProviderStatus,
  CopilotProgressEvent,
  FileNode,
  LocalDefaults,
  ServerEvent,
  TabId,
  TransferJob,
  VM,
  VMAction,
  VmConnectionInput,
} from './types'

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
  const normalized = path.replace(/\\$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (slashIndex <= 2) {
    return normalized
  }

  return normalized.slice(0, slashIndex)
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
    tags: existing?.tags.length ? existing.tags : ['ssh'],
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

function proposalFor(type: ActionProposal['actionType'], vm: VM, activeTab: TabId): ActionProposal {
  const base = {
    id: `proposal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    vmId: vm.id,
    status: 'pending_confirmation' as const,
  }

  if (type === 'inspect_logs') {
    return {
      ...base,
      title: `Inspect logs on ${vm.name}`,
      description: `Collect recent service and system logs for the current ${activeTab} context.`,
      command: 'sudo journalctl -p warning..alert -n 120 --no-pager',
      actionType: type,
      risk: 'low',
    }
  }

  if (type === 'restart_service') {
    return {
      ...base,
      title: `Restart degraded service`,
      description: 'Prepare a service restart with a status check before and after execution.',
      command: 'sudo systemctl status wal-archive && sudo systemctl restart wal-archive && sudo systemctl status wal-archive',
      actionType: type,
      risk: 'medium',
    }
  }

  if (type === 'snapshot') {
    return {
      ...base,
      title: `Create safety snapshot`,
      description: 'Capture the VM before lifecycle changes or command execution.',
      command: `vmctl snapshot create ${vm.name} --label copilot-${new Date().toISOString().slice(0, 10)}`,
      actionType: type,
      risk: 'low',
    }
  }

  if (type === 'transfer_file') {
    return {
      ...base,
      title: `Stage file transfer`,
      description: 'Plan an upload/download job and flag overwrite conflicts before transfer.',
      command: `sftp -P ${vm.connection.port} ${vm.connection.user}@${vm.connection.host}`,
      actionType: type,
      risk: 'low',
    }
  }

  if (type === 'patch_vms') {
    return {
      ...base,
      title: 'Patch all running VMs',
      description: 'Run an OS package update plan across every running Linux VM after confirmation.',
      command: [
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
      ].join('\n'),
      actionType: type,
      risk: 'high',
    }
  }

  return {
    ...base,
    title: `Explain ${vm.name} metrics`,
    description: 'Summarize resource pressure and recommend next checks.',
    command: 'uptime && free -h && df -h && ps aux --sort=-%mem | head',
    actionType: type,
    risk: 'low',
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
  const [copilotProgress, setCopilotProgress] = useState<CopilotProgressEvent[]>([])
  const [copilotBusyByVm, setCopilotBusyByVm] = useState<Record<string, boolean>>({})
  const [providerStatus, setProviderStatus] = useState<CopilotProviderStatus>(initialProviderStatus)
  const [pendingAction, setPendingAction] = useState<VMAction | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [vmEditorMode, setVmEditorMode] = useState<'add' | 'edit' | null>(null)

  useEffect(() => {
    if (apiDisabled()) {
      return undefined
    }

    let mounted = true

    getSnapshot()
      .then((snapshot) => {
        if (!mounted) {
          return
        }

        setVms(snapshot.vms)
        setTransfers(snapshot.transfers)
        setMessages(snapshot.messages)
        setProposals(snapshot.proposals)
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

    let socket: WebSocket | undefined
    try {
      socket = createEventsSocket((event: ServerEvent) => {
        if (event.type === 'snapshot') {
          setVms(event.payload.vms)
          setTransfers(event.payload.transfers)
          setMessages(event.payload.messages)
          setProposals(event.payload.proposals)
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
          setMessages((current) => appendOrReplaceById(current, event.payload))
          return
        }

        if (event.type === 'copilot.progress') {
          setCopilotProgress((current) => updateCopilotProgress(current, event.payload))
          setCopilotBusyByVm((current) => ({
            ...current,
            [event.payload.vmId]: event.payload.status === 'running',
          }))
          return
        }

        if (event.type === 'copilot.proposal.updated') {
          setProposals((current) => upsertById(current, event.payload))
        }
      })
    } catch {
      socket = undefined
    }

    return () => {
      mounted = false
      socket?.close()
    }
  }, [])

  const selectedVm = useMemo(() => vms.find((vm) => vm.id === selectedVmId), [selectedVmId, vms])
  const currentRemotePath = selectedVm ? remotePathByVm[selectedVm.id] ?? '/root' : '/'
  const remoteFiles = selectedVm ? remoteFilesByVmState[selectedVm.id] ?? [] : []
  const selectedRemoteId = selectedVm ? selectedRemoteByVm[selectedVm.id] : undefined
  const remoteLoading = selectedVm ? remoteLoadingByVm[selectedVm.id] ?? false : false
  const remoteError = selectedVm ? remoteErrorByVm[selectedVm.id] : undefined
  const remoteVmId = selectedVm?.id

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

  async function sendMessage(content: string) {
    if (!selectedVm) {
      return
    }

    setCopilotBusyByVm((current) => ({ ...current, [selectedVm.id]: true }))
    setCopilotProgress((current) =>
      updateCopilotProgress(current, {
        id: `copilot-progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        vmId: selectedVm.id,
        title: 'Sending request to copilot',
        detail: content,
        status: 'running' as const,
        timestamp: nowLabel(),
      }),
    )

    if (!apiDisabled()) {
      try {
        const response = await sendCopilotMessage({
          vmId: selectedVm.id,
          activeTab,
          message: content,
        })
        setMessages((current) => response.messages.reduce((items, message) => appendOrReplaceById(items, message), current))
        setProposals((current) => response.proposals.reduce((items, proposal) => upsertById(items, proposal), current))
        setCopilotBusyByVm((current) => ({ ...current, [selectedVm.id]: false }))
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Copilot request failed.'
        setCopilotBusyByVm((current) => ({ ...current, [selectedVm.id]: false }))
        setCopilotProgress((current) =>
          updateCopilotProgress(current, {
            id: `copilot-progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            vmId: selectedVm.id,
            title: 'Copilot request failed',
            detail: message,
            status: 'failed' as const,
            timestamp: nowLabel(),
          }),
        )
        setMessages((current) => [
          ...current,
          {
            id: `msg-${Date.now()}-assistant`,
            role: 'assistant',
            content: message,
            timestamp: nowLabel(),
            contextVmId: selectedVm.id,
            contextTab: activeTab,
          },
        ])
        return
      }
    }

    setMessages((current) => [
      ...current,
      {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: 'The local backend is unavailable, so copilot cannot contact Moonshot/Kimi.',
        timestamp: nowLabel(),
        contextVmId: selectedVm.id,
        contextTab: activeTab,
      },
    ])
    setCopilotBusyByVm((current) => ({ ...current, [selectedVm.id]: false }))
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
          setSelectedVmId(vm.id)
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
        setSelectedVmId(vm.id)
        return
      } catch (error) {
        if (!isApiUnavailableError(error)) {
          throw error
        }
      }
    }

    const vm = localVmFromInput(input, vms)
    setVms((current) => [vm, ...current])
    setSelectedVmId(vm.id)
  }

  async function createProposal(type: ActionProposal['actionType']) {
    if (!selectedVm) {
      return
    }

    if (!apiDisabled()) {
      try {
        const proposal = await createCopilotProposal({
          vmId: selectedVm.id,
          activeTab,
          actionType: type,
        })
        setProposals((current) => upsertById(current, proposal))
        return
      } catch {
        // Fall back to local proposal state if the backend is unavailable.
      }
    }

    setProposals((current) => [proposalFor(type, selectedVm, activeTab), ...current])
  }

  async function confirmProposal(proposalId: string) {
    const proposal = proposals.find((item) => item.id === proposalId)
    if (!proposal) {
      return
    }

    if (!apiDisabled()) {
      try {
        const result = await confirmCopilotProposal(proposalId)
        setProposals((current) => upsertById(current, result.proposal))
        return
      } catch {
        // Fall back to local confirmation state if the backend is unavailable.
      }
    }

    setProposals((current) =>
      current.map((item) =>
        item.id === proposalId
          ? { ...item, status: 'executed', result: 'Mock command completed and logged to activity.' }
          : item,
      ),
    )
    addActivity(proposal.vmId, makeActivity(proposal.title, 'Copilot action executed from confirmed proposal.', 'success'))
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-slate-100 text-slate-900 lg:flex-row">
      <Sidebar
        vms={vms}
        selectedVmId={selectedVmId}
        onSelect={setSelectedVmId}
        onAddVm={() => setVmEditorMode('add')}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedVm ? (
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
                <LifecycleControls lifecycle={selectedVm.lifecycle} actions={visibleVmActions} onAction={handleLifecycle} />
              </div>

              <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)}>
                <Tabs.List className="flex gap-1 overflow-x-auto" aria-label="VM sections">
                  {tabs.map((tab) => (
                    <Tabs.Trigger
                      key={tab.value}
                      value={tab.value}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded border border-transparent px-3 text-sm font-medium text-slate-600 transition data-[state=active]:border-slate-300 data-[state=active]:bg-slate-100 data-[state=active]:text-slate-950"
                    >
                      {tab.icon}
                      {tab.label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
            </header>

            <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)} className="min-h-0 flex-1">
              <div className="h-full overflow-auto p-4">
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
          <section className="m-4 rounded border border-slate-200 bg-white p-6 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">No VM selected</h2>
            <p className="mt-1 text-sm text-slate-500">The inventory is empty or the selected VM was removed.</p>
          </section>
        )}
      </main>

      <CopilotPanel
        vm={selectedVm}
        activeTab={activeTab}
        messages={messages}
        progress={selectedVm ? copilotProgress.filter((event) => event.vmId === selectedVm.id) : []}
        proposals={selectedVm ? proposals.filter((proposal) => proposal.vmId === selectedVm.id) : []}
        isBusy={selectedVm ? copilotBusyByVm[selectedVm.id] ?? false : false}
        onSendMessage={sendMessage}
        onCreateProposal={createProposal}
        onConfirmProposal={confirmProposal}
      />

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
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-2xl">
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
            <div className="mb-4 flex gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              This action runs through the local backend when available and records an activity entry.
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="h-8 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
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
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-slate-950">File conflict</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-slate-500">
              {conflict?.file.name} already exists at {conflict?.remotePath}. Choose how the transfer should proceed.
            </Dialog.Description>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => resolveConflict('overwrite')}
                className="h-9 rounded border border-amber-300 bg-amber-50 px-3 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                Overwrite
              </button>
              <button
                type="button"
                onClick={() => resolveConflict('rename')}
                className="h-9 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => resolveConflict('skip')}
                className="h-9 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
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
