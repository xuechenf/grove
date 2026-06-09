import { CheckCircle2, KeyRound, PenLine, PlugZap, Save, ServerCog, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { CopilotProviderStatus, VM } from '../types'
import { StatusPill } from './StatusPill'

interface SettingsTabProps {
  vm: VM
  providerStatus: CopilotProviderStatus
  onTestConnection: () => void
  onEditVm: () => void
  onSaveProvider: (input: { apiKey: string; baseUrl: string; model: string }) => Promise<void>
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase text-slate-500">{label}</div>
      <div className="truncate text-sm font-semibold text-slate-800">{value}</div>
    </div>
  )
}

export function SettingsTab({ vm, providerStatus, onTestConnection, onEditVm, onSaveProvider }: SettingsTabProps) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(providerStatus.baseUrl)
  const [model, setModel] = useState(providerStatus.model)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | undefined>()

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
        apiKey: trimmedKey,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      })
      setApiKey('')
      setSaveMessage('Moonshot provider saved.')
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Provider save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]" data-testid="settings-tab">
      <section className="rounded border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Connection profile</h2>
            <p className="text-xs text-slate-500">SSH metadata only; the PEM path is stored without key material.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEditVm}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              Modify VM
            </button>
            <button
              type="button"
              onClick={onTestConnection}
              className="inline-flex h-8 items-center gap-2 rounded border border-cyan-300 bg-cyan-50 px-2.5 text-xs font-medium text-cyan-800 transition hover:bg-cyan-100"
            >
              <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
              Test connection
            </button>
          </div>
        </header>
        <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Host" value={vm.connection.host} />
          <Field label="User" value={vm.connection.user} />
          <Field label="Port" value={vm.connection.port} />
          <Field label="PEM file" value={vm.connection.keyLabel} />
          <Field label="Key status" value={vm.connection.keyStatus} />
          <Field label="Last connected" value={vm.connection.lastConnected} />
          <Field label="Fingerprint" value={vm.connection.fingerprint ?? 'not available'} />
          <Field label="Test status" value={vm.connection.testStatus} />
          <Field label="Remote OS" value={vm.os} />
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-950">VM metadata</h2>
          <p className="text-xs text-slate-500">Provider and inventory labels</p>
        </header>
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50 p-3">
            <ServerCog className="h-5 w-5 text-slate-500" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-800">{vm.provider.name}</div>
              <div className="truncate text-xs text-slate-500">{vm.provider.region} / {vm.provider.node}</div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 p-3">
            <span className="text-sm font-medium text-slate-700">Health</span>
            <StatusPill status={vm.health} />
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
              <KeyRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
              Tags
            </div>
            <div className="flex flex-wrap gap-1.5">
              {vm.tags.map((tag) => (
                <span key={tag} className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
                  {tag}
                </span>
              ))}
            </div>
          </div>
          {vm.connection.keyStatus === 'missing' ? (
            <div className="flex gap-2 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Key reference is missing locally. Add a key before attempting SSH operations.
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white shadow-sm xl:col-span-2">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Copilot provider</h2>
            <p className="text-xs text-slate-500">Moonshot / Kimi</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
            <CheckCircle2 className={`h-3.5 w-3.5 ${providerStatus.configured ? 'text-emerald-600' : 'text-slate-400'}`} aria-hidden="true" />
            {providerStatus.configured ? 'Configured' : 'Not configured'}
          </div>
        </header>
        <div className="grid gap-3 p-3 lg:grid-cols-[1.5fr_1fr_1fr_auto]">
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            API key
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder={providerStatus.configured ? 'Saved; enter a new key to replace' : 'sk-...'}
              className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-cyan-400"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Base URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-cyan-400"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Model
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-cyan-400"
            />
          </label>
          <div className="flex items-end">
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
          {saveMessage ? <div className="text-xs text-slate-500 lg:col-span-4">{saveMessage}</div> : null}
        </div>
      </section>
    </div>
  )
}
