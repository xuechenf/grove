import * as Dialog from '@radix-ui/react-dialog'
import {
  CheckCircle2,
  Copy,
  Database,
  Folder,
  FileUp,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { azureIamCommands } from '../lib/azureIam'
import { cx } from '../lib/format'
import type {
  AlicloudCredentialCsvImport,
  CopilotProvider,
  CopilotProviderStatus,
  CredentialProfile,
  CredentialProfileInput,
  CredentialProfileKind,
  GroveSettings,
  GroveStorageStatus,
  AwsCredentialCsvImport,
} from '../types'
import { IconButton } from './IconButton'

export type AppTheme = 'system' | 'light' | 'dark'

interface ProviderOption {
  value: CopilotProvider
  label: string
  detail: string
  baseUrl: string
  model: string
}

const providerOptions: ProviderOption[] = [
  {
    value: 'moonshot',
    label: 'Moonshot',
    detail: 'Kimi API',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
  },
  {
    value: 'glm-cn',
    label: 'GLM-CN',
    detail: 'Z.AI coding API',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.2',
  },
]

const themeOptions: Array<{ value: AppTheme; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

const credentialKinds: Array<{ value: CredentialProfileKind; label: string }> = [
  { value: 'ssh', label: 'SSH' },
  { value: 'aws', label: 'AWS' },
  { value: 'azure', label: 'Azure' },
  { value: 'alicloud', label: 'Alibaba Cloud' },
  { value: 'name.com', label: 'Name.com' },
]

const credentialFields: Record<
  CredentialProfileKind,
  Array<{ key: string; label: string; secret?: boolean; placeholder?: string }>
> = {
  ssh: [
    { key: 'username', label: 'Default SSH user', placeholder: 'ubuntu' },
    { key: 'keyPath', label: 'Private key path', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' },
    { key: 'publicKeyPath', label: 'Public key path', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519.pub' },
    { key: 'passphrase', label: 'Key passphrase', secret: true },
  ],
  aws: [
    { key: 'accessKeyId', label: 'Access key ID' },
    { key: 'region', label: 'Default region', placeholder: 'us-east-1 or cn-north-1' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
    { key: 'sessionToken', label: 'Session token', secret: true },
  ],
  azure: [
    { key: 'tenantId', label: 'Tenant ID' },
    { key: 'clientId', label: 'Client ID' },
    { key: 'subscriptionId', label: 'Subscription ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
  ],
  alicloud: [
    { key: 'accessKeyId', label: 'AccessKey ID' },
    { key: 'region', label: 'Default region', placeholder: 'cn-hangzhou' },
    { key: 'accessKeySecret', label: 'AccessKey secret', secret: true },
    { key: 'securityToken', label: 'Security token', secret: true },
  ],
  'name.com': [
    { key: 'username', label: 'Name.com username' },
    { key: 'apiBaseUrl', label: 'API base URL', placeholder: 'https://api.name.com/v4' },
    { key: 'apiToken', label: 'API token', secret: true },
  ],
}

function newCredentialInput(kind: CredentialProfileKind = 'ssh'): CredentialProfileInput {
  return { kind, name: '', isDefault: false, configuration: {}, secrets: {} }
}

interface GeneralSettingsPanelProps {
  open: boolean
  settings: GroveSettings
  storage: GroveStorageStatus
  providerStatus: CopilotProviderStatus
  theme: AppTheme
  onOpenChange: (open: boolean) => void
  onThemeChange: (theme: AppTheme) => void
  onRelocateWorkspace: (workspacePath: string) => Promise<void>
  onSaveCredential: (input: CredentialProfileInput, profileId?: string) => Promise<void>
  onTestCredential: (profileId: string) => Promise<string>
  onDeleteCredential: (profileId: string) => Promise<void>
  onImportAwsCredential: (input: AwsCredentialCsvImport) => Promise<string>
  onImportAlicloudCredential: (input: AlicloudCredentialCsvImport) => Promise<string>
  onSaveProvider: (input: {
    provider: CopilotProvider
    apiKey: string
    baseUrl: string
    model: string
  }) => Promise<void>
}

function optionFor(provider: CopilotProvider) {
  return providerOptions.find((option) => option.value === provider) ?? providerOptions[0]
}

export function GeneralSettingsPanel({
  open,
  settings,
  storage,
  providerStatus,
  theme,
  onOpenChange,
  onThemeChange,
  onRelocateWorkspace,
  onSaveCredential,
  onTestCredential,
  onDeleteCredential,
  onImportAwsCredential,
  onImportAlicloudCredential,
  onSaveProvider,
}: GeneralSettingsPanelProps) {
  const [provider, setProvider] = useState<CopilotProvider>(providerStatus.provider)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(providerStatus.baseUrl)
  const [model, setModel] = useState(providerStatus.model)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | undefined>()
  const [workspacePath, setWorkspacePath] = useState(settings.workspacePath)
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceMessage, setWorkspaceMessage] = useState<string>()
  const [editingCredentialId, setEditingCredentialId] = useState<string>()
  const [credentialInput, setCredentialInput] = useState<CredentialProfileInput>(() => newCredentialInput())
  const [credentialSaving, setCredentialSaving] = useState(false)
  const [credentialTestingId, setCredentialTestingId] = useState<string>()
  const [credentialDeletingId, setCredentialDeletingId] = useState<string>()
  const [credentialMessage, setCredentialMessage] = useState<string>()
  const [credentialImporting, setCredentialImporting] = useState(false)
  const [azureSetupSuffix] = useState(() => Math.random().toString(36).slice(2, 10).padEnd(8, '0'))
  const [azureCopyMessage, setAzureCopyMessage] = useState<string>()
  const awsCsvInputRef = useRef<HTMLInputElement>(null)
  const alicloudCsvInputRef = useRef<HTMLInputElement>(null)

  function selectProvider(nextProvider: CopilotProvider) {
    const defaults = optionFor(nextProvider)
    setProvider(nextProvider)
    setBaseUrl(defaults.baseUrl)
    setModel(defaults.model)
    setSaveMessage(undefined)
  }

  async function saveProvider() {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      setSaveMessage('Enter an API key before saving.')
      return
    }

    setSaving(true)
    setSaveMessage(undefined)
    try {
      await onSaveProvider({
        provider,
        apiKey: trimmedKey,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      })
      setApiKey('')
      setSaveMessage(`${optionFor(provider).label} provider saved.`)
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Provider save failed.')
    } finally {
      setSaving(false)
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      setProvider(providerStatus.provider)
      setBaseUrl(providerStatus.baseUrl)
      setModel(providerStatus.model)
      setSaveMessage(undefined)
      setWorkspacePath(settings.workspacePath)
      setWorkspaceMessage(undefined)
      setEditingCredentialId(undefined)
      setCredentialInput(newCredentialInput())
      setCredentialMessage(undefined)
    }
    onOpenChange(nextOpen)
  }

  async function saveWorkspace() {
    const nextPath = workspacePath.trim()
    if (!nextPath) {
      setWorkspaceMessage('Enter a workspace folder.')
      return
    }
    setWorkspaceSaving(true)
    setWorkspaceMessage(undefined)
    try {
      await onRelocateWorkspace(nextPath)
      setWorkspaceMessage('Workspace location saved.')
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : 'Workspace relocation failed.')
    } finally {
      setWorkspaceSaving(false)
    }
  }

  function editCredential(profile?: CredentialProfile) {
    if (!profile) {
      setEditingCredentialId('new')
      setCredentialInput(newCredentialInput())
      setCredentialMessage(undefined)
      return
    }
    setEditingCredentialId(profile.id)
    setCredentialInput({
      kind: profile.kind,
      name: profile.name,
      isDefault: profile.isDefault,
      configuration: { ...profile.configuration },
      secrets: {},
    })
    setCredentialMessage(undefined)
  }

  function updateCredentialField(key: string, value: string, secret: boolean) {
    setCredentialInput((current) => ({
      ...current,
      [secret ? 'secrets' : 'configuration']: {
        ...(secret ? current.secrets : current.configuration),
        [key]: value,
      },
    }))
  }

  async function copyAzureSetup() {
    try {
      await navigator.clipboard.writeText(azureIamCommands(credentialInput.configuration.subscriptionId ?? '', azureSetupSuffix))
      setAzureCopyMessage('Commands copied.')
    } catch {
      setAzureCopyMessage('Copy failed. Select the commands manually.')
    }
  }

  async function saveCredential() {
    setCredentialSaving(true)
    setCredentialMessage(undefined)
    try {
      await onSaveCredential(credentialInput, editingCredentialId === 'new' ? undefined : editingCredentialId)
      setCredentialMessage('Credential profile saved.')
      setEditingCredentialId(undefined)
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : 'Credential profile save failed.')
    } finally {
      setCredentialSaving(false)
    }
  }

  async function testCredential(profileId: string) {
    setCredentialTestingId(profileId)
    setCredentialMessage(undefined)
    try {
      setCredentialMessage(await onTestCredential(profileId))
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : 'Credential test failed.')
    } finally {
      setCredentialTestingId(undefined)
    }
  }

  async function removeCredential(profileId: string) {
    setCredentialMessage(undefined)
    try {
      await onDeleteCredential(profileId)
      setCredentialMessage('Credential profile removed. No provider resources were changed.')
      setCredentialDeletingId(undefined)
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : 'Credential profile removal failed.')
    }
  }

  async function importAwsCsv(file: File | undefined) {
    if (!file) return
    setCredentialImporting(true)
    setCredentialMessage(undefined)
    try {
      if (file.size > 64 * 1024) throw new Error('AWS credential CSV must be smaller than 64 KB.')
      const detail = await onImportAwsCredential({
        name: file.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim() || 'AWS account',
        region: 'us-east-1',
        isDefault: true,
        csvText: await file.text(),
      })
      setCredentialMessage(detail)
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : 'AWS credential import failed.')
    } finally {
      setCredentialImporting(false)
      if (awsCsvInputRef.current) awsCsvInputRef.current.value = ''
    }
  }

  async function importAlicloudCsv(file: File | undefined) {
    if (!file) return
    setCredentialImporting(true)
    setCredentialMessage(undefined)
    try {
      if (file.size > 64 * 1024) throw new Error('Alibaba Cloud credential CSV must be smaller than 64 KB.')
      const detail = await onImportAlicloudCredential({
        name: file.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim() || 'Alibaba Cloud account',
        region: 'cn-beijing',
        isDefault: true,
        csvText: await file.text(),
      })
      setCredentialMessage(detail)
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : 'Alibaba Cloud credential import failed.')
    } finally {
      setCredentialImporting(false)
      if (alicloudCsvInputRef.current) alicloudCsvInputRef.current.value = ''
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
      <Dialog.Portal>
        <Dialog.Content className="fixed bottom-3 left-3 z-50 max-h-[calc(100svh-24px)] w-[min(480px,calc(100vw-24px))] overflow-auto rounded border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 focus:outline-none">
          <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <Dialog.Title className="text-sm font-semibold text-slate-950">Grove settings</Dialog.Title>
              <Dialog.Description className="text-xs text-slate-500">Workspace, credentials, Copilot, and appearance</Dialog.Description>
            </div>
            <IconButton label="Close Grove settings" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="grid gap-4 p-4">
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Folder className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase text-slate-500">Local workspace</h2>
                <span className="ml-auto rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium capitalize text-emerald-700">
                  {settings.workspaceStatus}
                </span>
              </div>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Workspace folder
                <input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  className="h-9 rounded border border-slate-300 bg-white px-3 font-mono text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
                <input
                  ref={alicloudCsvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  aria-label="Alibaba Cloud credential CSV"
                  onChange={(event) => void importAlicloudCsv(event.currentTarget.files?.[0])}
                />
                <span className="font-normal text-slate-500">Each application and all immutable build versions live below this folder.</span>
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-h-4 text-xs text-slate-500">{workspaceMessage}</div>
                <button
                  type="button"
                  onClick={saveWorkspace}
                  disabled={workspaceSaving || workspacePath.trim() === settings.workspacePath}
                  className="inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {workspaceSaving ? 'Moving' : 'Save location'}
                </button>
              </div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-4">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase text-slate-500">Local database</h2>
                <span className="ml-auto rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  {storage.integrity}
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                <dt className="text-slate-500">Engine</dt>
                <dd className="font-medium text-slate-800">{storage.engine === 'sqlite' ? 'SQLite' : 'In-memory fixtures'}</dd>
                <dt className="text-slate-500">Schema</dt>
                <dd className="font-medium text-slate-800">v{storage.schemaVersion}</dd>
                {storage.journalMode ? (
                  <>
                    <dt className="text-slate-500">Journal</dt>
                    <dd className="font-medium uppercase text-slate-800">{storage.journalMode}</dd>
                  </>
                ) : null}
                {storage.databasePath ? (
                  <>
                    <dt className="text-slate-500">File</dt>
                    <dd className="break-all font-mono text-slate-700">{storage.databasePath}</dd>
                  </>
                ) : null}
              </dl>
              <p className="text-xs leading-5 text-slate-500">
                Structured Grove state is stored in SQLite. Credential secrets, private keys, source code, artifacts, logs, and Terraform state remain outside the database.
              </p>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-4">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase text-slate-500">Credential profiles</h2>
                <input
                  ref={awsCsvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  aria-label="AWS credential CSV"
                  onChange={(event) => void importAwsCsv(event.currentTarget.files?.[0])}
                />
                <button
                  type="button"
                  disabled={credentialImporting}
                  onClick={() => awsCsvInputRef.current?.click()}
                  className="ml-auto inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {credentialImporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
                  Import AWS CSV
                </button>
                <button
                  type="button"
                  disabled={credentialImporting}
                  onClick={() => alicloudCsvInputRef.current?.click()}
                  className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {credentialImporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
                  Import Alibaba CSV
                </button>
                <button
                  type="button"
                  onClick={() => editCredential()}
                  className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add profile
                </button>
              </div>
              <p className="text-xs leading-5 text-slate-500">
                SSH, AWS, Azure, Alibaba Cloud, and Name.com access is stored as named profiles. Secret values are never returned to the UI.
              </p>
              {editingCredentialId ? (
                <div className="grid gap-3 rounded border border-slate-300 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-sm text-slate-900">
                      {editingCredentialId === 'new' ? 'New credential profile' : 'Edit credential profile'}
                    </strong>
                    <IconButton label="Cancel credential editing" onClick={() => setEditingCredentialId(undefined)}>
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </IconButton>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="Credential provider">
                    {credentialKinds.map((kind) => (
                      <button
                        key={kind.value}
                        type="button"
                        disabled={editingCredentialId !== 'new'}
                        aria-pressed={credentialInput.kind === kind.value}
                        onClick={() => setCredentialInput(newCredentialInput(kind.value))}
                        className={cx(
                          'h-8 rounded border px-2 text-xs font-medium transition disabled:cursor-not-allowed',
                          credentialInput.kind === kind.value
                            ? 'border-slate-950 bg-slate-950 text-white'
                            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
                        )}
                      >
                        {kind.label}
                      </button>
                    ))}
                  </div>
                  <label className="grid gap-1 text-xs font-medium text-slate-600">
                    Profile name
                    <input
                      value={credentialInput.name}
                      onChange={(event) => setCredentialInput((current) => ({ ...current, name: event.target.value }))}
                      placeholder={`My ${credentialKinds.find((kind) => kind.value === credentialInput.kind)?.label}`}
                      className="field-control"
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {credentialFields[credentialInput.kind].map((field) => (
                      <label key={field.key} className="grid gap-1 text-xs font-medium text-slate-600">
                        {field.label}
                        <input
                          type={field.secret ? 'password' : 'text'}
                          autoComplete="off"
                          value={field.secret ? credentialInput.secrets?.[field.key] ?? '' : credentialInput.configuration[field.key] ?? ''}
                          onChange={(event) => updateCredentialField(field.key, event.target.value, Boolean(field.secret))}
                          placeholder={
                            field.secret && editingCredentialId !== 'new'
                              ? 'Saved; enter to replace'
                              : field.placeholder
                          }
                          className="field-control"
                        />
                      </label>
                    ))}
                  </div>
                  {credentialInput.kind === 'azure' ? (
                    <section className="grid gap-2 rounded border border-blue-200 bg-blue-50 p-3" aria-label="Azure IAM setup">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <strong className="text-xs font-semibold text-blue-950">Azure service principal setup</strong>
                          <p className="mt-1 text-xs leading-5 text-blue-800">Run these commands yourself in PowerShell. Grove never creates identities or role assignments.</p>
                        </div>
                        <button type="button" onClick={() => void copyAzureSetup()} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-blue-300 bg-white px-2.5 text-xs font-medium text-blue-800 hover:bg-blue-100"><Copy className="h-3.5 w-3.5" />Copy</button>
                      </div>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">{azureIamCommands(credentialInput.configuration.subscriptionId ?? '', azureSetupSuffix)}</pre>
                      <div className="grid gap-1 text-xs leading-5 text-blue-900">
                        <span><strong>Monitoring Reader</strong> reads VM configuration and Azure Monitor metrics.</span>
                        <span><strong>Virtual Machine Contributor</strong> starts, restarts, and deallocates VMs.</span>
                        <span><strong>Network Contributor</strong> manages NSG ingress rules. Do not grant Owner.</span>
                        <span>Map <code>$sp.tenant</code>, <code>$sp.appId</code>, and <code>$sp.password</code> to Tenant ID, Client ID, and Client secret. The secret is shown only once.</span>
                        <span>Azure role propagation can take a minute. Retry a failed role assignment or credential test after 30–60 seconds.</span>
                        <span>Client secrets are convenient for local use; use certificate or federated credentials for production automation.</span>
                      </div>
                      {azureCopyMessage ? <p className="text-xs font-medium text-blue-800" role="status">{azureCopyMessage}</p> : null}
                    </section>
                  ) : null}
                  <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={credentialInput.isDefault ?? false}
                      onChange={(event) => setCredentialInput((current) => ({ ...current, isDefault: event.target.checked }))}
                    />
                    Use as the default {credentialKinds.find((kind) => kind.value === credentialInput.kind)?.label} profile
                  </label>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={credentialSaving}
                      onClick={saveCredential}
                      className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {credentialSaving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {credentialSaving ? 'Saving' : 'Save profile'}
                    </button>
                  </div>
                </div>
              ) : null}
              {settings.credentialProfiles.length ? (
                <div className="divide-y divide-slate-200 rounded border border-slate-200">
                  {settings.credentialProfiles.map((profile) => (
                    <div key={profile.id} className="grid gap-2 px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm text-slate-900">{profile.name}</strong>
                          <span className="block text-xs capitalize text-slate-500">
                            {profile.kind}{profile.isDefault ? ' · default' : ''}
                            {profile.lastTestStatus ? ` · ${profile.lastTestStatus}` : ''}
                          </span>
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${profile.secretConfigured ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                          {profile.secretConfigured ? 'Configured' : 'Needs secret'}
                        </span>
                      </div>
                      {credentialDeletingId === profile.id ? (
                        <div className="flex items-center justify-between gap-2 rounded bg-rose-50 px-2 py-1.5 text-xs text-rose-700">
                          <span>Remove this local profile? Provider resources are not changed.</span>
                          <span className="flex gap-1">
                            <button type="button" onClick={() => setCredentialDeletingId(undefined)} className="rounded px-2 py-1 font-medium hover:bg-white">Cancel</button>
                            <button type="button" onClick={() => removeCredential(profile.id)} className="rounded bg-rose-700 px-2 py-1 font-medium text-white">Remove</button>
                          </span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <button type="button" disabled={Boolean(credentialTestingId)} onClick={() => testCredential(profile.id)} className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                            <RefreshCw className={cx('h-3.5 w-3.5', credentialTestingId === profile.id && 'animate-spin')} /> Test
                          </button>
                          <button type="button" onClick={() => editCredential(profile)} className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </button>
                          <button type="button" onClick={() => setCredentialDeletingId(profile.id)} className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-rose-600 hover:bg-rose-50">
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">
                  No credential profiles yet. Existing VM SSH keys remain attached to their current inventory records.
                </div>
              )}
              <div className="min-h-4 text-xs text-slate-500">{credentialMessage}</div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xs font-semibold uppercase text-slate-500">Copilot provider</h2>
                <div className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
                  <CheckCircle2
                    className={cx(
                      'h-3.5 w-3.5',
                      providerStatus.configured ? 'text-emerald-600' : 'text-slate-400',
                    )}
                    aria-hidden="true"
                  />
                  {providerStatus.configured ? 'Configured' : 'Not configured'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Copilot provider">
                {providerOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={provider === option.value}
                    onClick={() => selectProvider(option.value)}
                    className={cx(
                      'rounded border p-3 text-left transition',
                      provider === option.value
                        ? 'border-slate-900 bg-slate-950 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className={cx('block text-xs', provider === option.value ? 'text-slate-200' : 'text-slate-500')}>
                      {option.detail}
                    </span>
                  </button>
                ))}
              </div>

              <label className="grid gap-1 text-xs font-medium text-slate-600">
                API key
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder={providerStatus.configured ? 'Saved; enter a new key to replace' : 'sk-...'}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Base URL
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Model
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-h-4 text-xs text-slate-500">{saveMessage}</div>
                <button
                  type="button"
                  onClick={saveProvider}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {saving ? 'Saving' : 'Save'}
                </button>
              </div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-4">
              <h2 className="text-xs font-semibold uppercase text-slate-500">Theme</h2>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Theme">
                {themeOptions.map((option) => {
                  const Icon = option.icon
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={theme === option.value}
                      onClick={() => onThemeChange(option.value)}
                      className={cx(
                        'inline-flex h-9 items-center justify-center gap-2 rounded border px-2 text-xs font-medium transition',
                        theme === option.value
                          ? 'border-slate-900 bg-slate-950 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
