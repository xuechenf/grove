import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, Pencil, Plus, RefreshCw, Rocket, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { cx } from '../lib/format'
import type { AppRunnerService, AppRunnerServiceInput, AppRunnerServiceState, AppRunnerSource, VM } from '../types'
import { IconButton } from './IconButton'

interface AppRunnerTabProps {
  vm: VM
  defaultLocalPath: string
  onCreateService: (input: AppRunnerServiceInput) => Promise<void>
  onUpdateService: (serviceName: string, input: AppRunnerServiceInput) => Promise<void>
  onRemoveService: (serviceName: string) => Promise<void>
}

interface FormState {
  name: string
  sourceType: AppRunnerSource['type']
  localPath: string
  repoUrl: string
  ref: string
  port: string
  installCommand: string
  buildCommand: string
  startCommand: string
}

function emptyForm(defaultLocalPath: string): FormState {
  return {
    name: '',
    sourceType: 'local',
    localPath: defaultLocalPath,
    repoUrl: 'https://github.com/',
    ref: '',
    port: '3000',
    installCommand: 'npm ci',
    buildCommand: '',
    startCommand: 'npm start',
  }
}

function formFromService(service: AppRunnerService | undefined, defaultLocalPath: string): FormState {
  const fallback = emptyForm(defaultLocalPath)
  if (!service) {
    return fallback
  }

  return {
    name: service.name,
    sourceType: service.source.type,
    localPath: service.source.type === 'local' ? service.source.path : fallback.localPath,
    repoUrl: service.source.type === 'github' ? service.source.repoUrl : fallback.repoUrl,
    ref: service.source.type === 'github' ? service.source.ref ?? '' : '',
    port: String(service.port),
    installCommand: service.installCommand ?? '',
    buildCommand: service.buildCommand ?? '',
    startCommand: service.startCommand,
  }
}

function stateTone(state: AppRunnerServiceState) {
  if (state === 'running') {
    return 'bg-emerald-500'
  }

  if (state === 'degraded') {
    return 'bg-amber-500'
  }

  if (state === 'stopped') {
    return 'bg-slate-400'
  }

  return 'bg-slate-300'
}

function sourceLabel(source: AppRunnerSource) {
  if (source.type === 'local') {
    return source.path
  }

  return source.ref ? `${source.repoUrl}#${source.ref}` : source.repoUrl
}

function makeInput(form: FormState): AppRunnerServiceInput {
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Enter a port from 1 to 65535.')
  }

  const source: AppRunnerSource =
    form.sourceType === 'github'
      ? {
          type: 'github',
          repoUrl: form.repoUrl.trim(),
          ref: form.ref.trim() || undefined,
        }
      : {
          type: 'local',
          path: form.localPath.trim(),
        }

  return {
    name: form.name.trim(),
    source,
    port,
    installCommand: form.installCommand.trim() || undefined,
    buildCommand: form.buildCommand.trim() || undefined,
    startCommand: form.startCommand.trim(),
  }
}

function AppRunnerDialog({
  mode,
  service,
  defaultLocalPath,
  open,
  onOpenChange,
  onSubmit,
}: {
  mode: 'create' | 'update'
  service?: AppRunnerService
  defaultLocalPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: AppRunnerServiceInput) => Promise<void>
}) {
  const [form, setForm] = useState<FormState>(() => formFromService(service, defaultLocalPath))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    setError(undefined)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      await onSubmit(makeInput(form))
      onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'AppRunner operation failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-32px)] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded border border-slate-200 bg-white p-4 shadow-2xl">
          <form onSubmit={handleSubmit}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold text-slate-950">
                  {mode === 'create' ? 'Create service' : 'Update service'}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-slate-500">
                  {mode === 'create' ? 'Deploy into ~/services and enable systemd.' : service?.unitName}
                </Dialog.Description>
              </div>
              <IconButton label="Close AppRunner dialog" onClick={() => onOpenChange(false)} type="button">
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-slate-700">Service name</span>
                <input
                  className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                  value={form.name}
                  disabled={mode === 'update'}
                  pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
                  onChange={(event) => updateField('name', event.target.value)}
                  required
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-slate-700">Port</span>
                <input
                  className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                  value={form.port}
                  inputMode="numeric"
                  onChange={(event) => updateField('port', event.target.value)}
                  required
                />
              </label>
            </div>

            <div className="mt-3 grid gap-3">
              <div className="inline-flex w-fit rounded border border-slate-300 bg-slate-50 p-1">
                {(['local', 'github'] as const).map((sourceType) => (
                  <button
                    key={sourceType}
                    type="button"
                    onClick={() => updateField('sourceType', sourceType)}
                    className={cx(
                      'h-8 rounded px-3 text-xs font-medium capitalize',
                      form.sourceType === sourceType
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-white hover:text-slate-950',
                    )}
                  >
                    {sourceType}
                  </button>
                ))}
              </div>

              {form.sourceType === 'local' ? (
                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-slate-700">Local folder</span>
                  <input
                    className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                    value={form.localPath}
                    onChange={(event) => updateField('localPath', event.target.value)}
                    required
                  />
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">GitHub URL</span>
                    <input
                      className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                      value={form.repoUrl}
                      onChange={(event) => updateField('repoUrl', event.target.value)}
                      required
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Ref</span>
                    <input
                      className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                      value={form.ref}
                      onChange={(event) => updateField('ref', event.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="mt-3 grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-slate-700">Install command</span>
                <input
                  className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                  value={form.installCommand}
                  onChange={(event) => updateField('installCommand', event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-slate-700">Build command</span>
                <input
                  className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                  value={form.buildCommand}
                  onChange={(event) => updateField('buildCommand', event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-slate-700">Start command</span>
                <input
                  className="h-9 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-500"
                  value={form.startCommand}
                  onChange={(event) => updateField('startCommand', event.target.value)}
                  required
                />
              </label>
            </div>

            {error ? (
              <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
                {saving ? 'Deploying' : mode === 'create' ? 'Create service' : 'Update service'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function AppRunnerTab({ vm, defaultLocalPath, onCreateService, onUpdateService, onRemoveService }: AppRunnerTabProps) {
  const [dialogMode, setDialogMode] = useState<'create' | 'update' | null>(null)
  const [editingService, setEditingService] = useState<AppRunnerService | undefined>()
  const [removingService, setRemovingService] = useState<AppRunnerService | undefined>()
  const [operationError, setOperationError] = useState<string | undefined>()

  function openCreateDialog() {
    setEditingService(undefined)
    setDialogMode('create')
    setOperationError(undefined)
  }

  function openUpdateDialog(service: AppRunnerService) {
    setEditingService(service)
    setDialogMode('update')
    setOperationError(undefined)
  }

  async function removeService() {
    if (!removingService) {
      return
    }

    setOperationError(undefined)
    try {
      await onRemoveService(removingService.name)
      setRemovingService(undefined)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Remove service failed.')
    }
  }

  return (
    <div className="space-y-3" data-testid="apprunner-tab">
      <section className="rounded border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">AppRunner</h2>
            <p className="text-xs text-slate-500">{vm.connection.user}@{vm.connection.host}</p>
          </div>
          <button
            type="button"
            onClick={openCreateDialog}
            className="inline-flex h-9 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create service
          </button>
        </header>

        {operationError ? (
          <div className="m-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{operationError}</div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Port</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Remote path</th>
                <th className="px-3 py-2 font-medium">Access</th>
                <th className="px-3 py-2 font-medium">Last deploy</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {vm.appServices.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-sm text-slate-500" colSpan={8}>
                    No AppRunner services yet.
                  </td>
                </tr>
              ) : (
                vm.appServices.map((service) => (
                  <tr key={service.name}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{service.name}</div>
                      <div className="text-xs text-slate-500">{service.unitName}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600">
                        <span className={cx('h-2 w-2 rounded-full', stateTone(service.state))} />
                        {service.state}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{service.port}</td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-slate-500">{sourceLabel(service.source)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{service.remotePath}</td>
                    <td className="px-3 py-2">
                      <a
                        className="inline-flex items-center gap-1 text-sm font-medium text-cyan-700 hover:text-cyan-900"
                        href={service.accessUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </td>
                    <td className="max-w-[240px] px-3 py-2">
                      <div className={cx('text-xs font-medium', service.lastDeployStatus === 'failed' ? 'text-rose-600' : 'text-slate-700')}>
                        {service.lastDeployStatus}
                      </div>
                      <div className="truncate text-xs text-slate-500">{service.lastDeploySummary}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <IconButton label={`Update ${service.name}`} onClick={() => openUpdateDialog(service)}>
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                        <IconButton label={`Remove ${service.name}`} onClick={() => setRemovingService(service)}>
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dialogMode ? (
        <AppRunnerDialog
          key={`${dialogMode}-${editingService?.name ?? 'new'}`}
          mode={dialogMode}
          service={editingService}
          defaultLocalPath={defaultLocalPath}
          open
          onOpenChange={(open) => {
            if (!open) {
              setDialogMode(null)
              setEditingService(undefined)
            }
          }}
          onSubmit={(input) =>
            dialogMode === 'create'
              ? onCreateService(input)
              : onUpdateService(editingService?.name ?? input.name, input)
          }
        />
      ) : null}

      <Dialog.Root open={Boolean(removingService)} onOpenChange={(open) => !open && setRemovingService(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold text-slate-950">Remove service</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-slate-500">
                  {removingService?.name} and {removingService?.remotePath}
                </Dialog.Description>
              </div>
              <IconButton label="Close remove service dialog" onClick={() => setRemovingService(undefined)}>
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemovingService(undefined)}
                className="h-8 rounded border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void removeService()}
                className="h-8 rounded border border-rose-700 bg-rose-700 px-3 text-xs font-medium text-white hover:bg-rose-800"
              >
                Remove service
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
