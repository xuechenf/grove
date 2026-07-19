import * as Dialog from '@radix-ui/react-dialog'
import { FolderGit2, Save, X } from 'lucide-react'
import { useState } from 'react'
import type { GroveApplication, GroveApplicationInput } from '../types'
import { IconButton } from './IconButton'

interface ApplicationEditorDialogProps {
  open: boolean
  mode: 'add' | 'edit'
  application?: GroveApplication
  defaultLocalPath: string
  onOpenChange: (open: boolean) => void
  onSave: (input: GroveApplicationInput) => Promise<void>
}

function initialInput(application: GroveApplication | undefined, defaultLocalPath: string): GroveApplicationInput {
  return application
    ? {
        name: application.name,
        description: application.description,
        source: application.source,
        configuration: {
          ...application.configuration,
          environment: { ...application.configuration.environment },
        },
      }
    : {
        name: '',
        description: '',
        source: { type: 'local', path: defaultLocalPath },
        configuration: {
          installCommand: '',
          buildCommand: '',
          artifactPath: 'dist',
          startCommand: 'npm start',
          port: 3000,
          healthCheckPath: '/',
          healthCheckTimeoutSeconds: 30,
          environment: {},
        },
      }
}

function parseEnvironment(value: string) {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=')
        return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1)]
      }),
  )
}

export function ApplicationEditorDialog({
  open,
  mode,
  application,
  defaultLocalPath,
  onOpenChange,
  onSave,
}: ApplicationEditorDialogProps) {
  const [input, setInput] = useState(() => initialInput(application, defaultLocalPath))
  const [environment, setEnvironment] = useState(() =>
    Object.entries(initialInput(application, defaultLocalPath).configuration.environment)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function submit() {
    if (!input.name.trim()) {
      setError('Application name is required.')
      return
    }
    if (input.source.type === 'local' && !input.source.path.trim()) {
      setError('Choose a local source folder.')
      return
    }
    if (input.source.type === 'git' && !input.source.repoUrl.trim()) {
      setError('Enter a Git repository URL.')
      return
    }
    if (!input.configuration.startCommand.trim()) {
      setError('A start command is required.')
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await onSave({
        ...input,
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
        configuration: {
          ...input.configuration,
          installCommand: input.configuration.installCommand?.trim() || undefined,
          buildCommand: input.configuration.buildCommand?.trim() || undefined,
          artifactPath: input.configuration.artifactPath.trim() || '.',
          startCommand: input.configuration.startCommand.trim(),
          healthCheckPath: input.configuration.healthCheckPath.trim() || '/',
          environment: parseEnvironment(environment),
        },
      })
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the application.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-32px)] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded border border-slate-200 bg-white shadow-2xl focus:outline-none">
          <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-slate-950">
                {mode === 'add' ? 'New application' : 'Application configuration'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">
                Source is copied into Grove; every build creates an immutable local version.
              </Dialog.Description>
            </div>
            <IconButton label="Close application editor" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="grid gap-5 p-5">
            <section className="grid gap-3">
              <SectionHeading title="Identity" detail="How the application appears in Grove." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <input
                    value={input.name}
                    onChange={(event) => setInput((current) => ({ ...current, name: event.target.value }))}
                    placeholder="example-api"
                    className="field-control"
                  />
                </Field>
                <Field label="Description">
                  <input
                    value={input.description ?? ''}
                    onChange={(event) => setInput((current) => ({ ...current, description: event.target.value }))}
                    placeholder="Optional"
                    className="field-control"
                  />
                </Field>
              </div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-5">
              <SectionHeading title="Source" detail="A local folder or Git repository copied into the managed workspace." />
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Source type">
                <SourceButton
                  active={input.source.type === 'local'}
                  label="Local folder"
                  onClick={() => setInput((current) => ({ ...current, source: { type: 'local', path: defaultLocalPath } }))}
                />
                <SourceButton
                  active={input.source.type === 'git'}
                  label="Git repository"
                  onClick={() => setInput((current) => ({ ...current, source: { type: 'git', repoUrl: '', ref: 'main' } }))}
                />
              </div>
              {input.source.type === 'local' ? (
                <Field label="Source folder">
                  <input
                    value={input.source.path}
                    onChange={(event) =>
                      setInput((current) => ({ ...current, source: { type: 'local', path: event.target.value } }))
                    }
                    className="field-control font-mono"
                  />
                </Field>
              ) : (
                <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                  <Field label="Repository URL">
                    <input
                      value={input.source.repoUrl}
                      onChange={(event) =>
                        setInput((current) => ({
                          ...current,
                          source: { ...current.source, type: 'git', repoUrl: event.target.value },
                        }))
                      }
                      placeholder="https://github.com/org/repo.git"
                      className="field-control"
                    />
                  </Field>
                  <Field label="Branch, tag, or SHA">
                    <input
                      value={input.source.ref ?? ''}
                      onChange={(event) =>
                        setInput((current) => ({
                          ...current,
                          source: {
                            type: 'git',
                            ref: event.target.value,
                            repoUrl: current.source.type === 'git' ? current.source.repoUrl : '',
                          },
                        }))
                      }
                      placeholder="main"
                      className="field-control"
                    />
                  </Field>
                </div>
              )}
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-5">
              <SectionHeading title="Build" detail="Commands run locally against a frozen source snapshot." />
              <div className="grid gap-3 sm:grid-cols-2">
                <CommandField
                  label="Install command"
                  value={input.configuration.installCommand ?? ''}
                  placeholder="npm ci"
                  onChange={(value) => setInput((current) => ({ ...current, configuration: { ...current.configuration, installCommand: value } }))}
                />
                <CommandField
                  label="Build command"
                  value={input.configuration.buildCommand ?? ''}
                  placeholder="npm run build"
                  onChange={(value) => setInput((current) => ({ ...current, configuration: { ...current.configuration, buildCommand: value } }))}
                />
                <Field label="Artifact path">
                  <input
                    value={input.configuration.artifactPath}
                    onChange={(event) => setInput((current) => ({ ...current, configuration: { ...current.configuration, artifactPath: event.target.value } }))}
                    placeholder="dist"
                    className="field-control font-mono"
                  />
                </Field>
              </div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-5">
              <SectionHeading title="Runtime" detail="Grove installs and controls a systemd service on each VM." />
              <CommandField
                label="Start command"
                value={input.configuration.startCommand}
                placeholder="npm start"
                onChange={(value) => setInput((current) => ({ ...current, configuration: { ...current.configuration, startCommand: value } }))}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Port">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={input.configuration.port}
                    onChange={(event) => setInput((current) => ({ ...current, configuration: { ...current.configuration, port: Number(event.target.value) } }))}
                    className="field-control"
                  />
                </Field>
                <Field label="Health path">
                  <input
                    value={input.configuration.healthCheckPath}
                    onChange={(event) => setInput((current) => ({ ...current, configuration: { ...current.configuration, healthCheckPath: event.target.value } }))}
                    className="field-control font-mono"
                  />
                </Field>
                <Field label="Health timeout (seconds)">
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={input.configuration.healthCheckTimeoutSeconds}
                    onChange={(event) => setInput((current) => ({ ...current, configuration: { ...current.configuration, healthCheckTimeoutSeconds: Number(event.target.value) } }))}
                    className="field-control"
                  />
                </Field>
              </div>
              <Field label="Environment" detail="One KEY=value per line. Do not put secrets here; credential profiles are managed globally.">
                <textarea
                  rows={4}
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                  placeholder={'NODE_ENV=production\nLOG_LEVEL=info'}
                  className="field-control h-auto resize-y py-2 font-mono"
                />
              </Field>
            </section>
          </div>

          <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-4">
            <p className="min-h-5 text-sm text-rose-700">{error}</p>
            <button
              type="button"
              disabled={saving}
              onClick={submit}
              className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {saving ? 'Saving' : mode === 'add' ? 'Create application' : 'Save configuration'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
    </div>
  )
}

function Field({ label, detail, children }: { label: string; detail?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
      {detail ? <span className="font-normal text-slate-500">{detail}</span> : null}
    </label>
  )
}

function CommandField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="field-control font-mono" />
    </Field>
  )
}

function SourceButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-10 items-center justify-center gap-2 rounded border text-sm font-medium transition ${
        active ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
      }`}
    >
      <FolderGit2 className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  )
}
