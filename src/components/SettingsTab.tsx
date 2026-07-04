import { PenLine, PlugZap, ServerCog, ShieldAlert } from 'lucide-react'
import type { VM } from '../types'
import { StatusPill } from './StatusPill'

interface SettingsTabProps {
  vm: VM
  onTestConnection: () => void
  onEditVm: () => void
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-medium uppercase text-slate-500">{label}</div>
      <div className="truncate text-sm font-semibold text-slate-800">{value}</div>
    </div>
  )
}

export function SettingsTab({ vm, onTestConnection, onEditVm }: SettingsTabProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]" data-testid="settings-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Connection profile</h2>
            <p className="text-xs text-slate-500">SSH metadata only; the PEM path is stored without key material.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEditVm}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              Modify VM
            </button>
            <button
              type="button"
              onClick={onTestConnection}
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-2.5 text-xs font-medium text-white transition hover:bg-slate-800"
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

      <section className="rounded border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-950">VM metadata</h2>
          <p className="text-xs text-slate-500">Provider and health</p>
        </header>
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-3 rounded border border-slate-200 bg-white p-3">
            <ServerCog className="h-5 w-5 text-slate-500" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-800">{vm.provider.name}</div>
              <div className="truncate text-xs text-slate-500">{vm.provider.region} / {vm.provider.node}</div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-white p-3">
            <span className="text-sm font-medium text-slate-700">Health</span>
            <StatusPill status={vm.health} />
          </div>
          {vm.connection.keyStatus === 'missing' ? (
            <div className="flex gap-2 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Key reference is missing locally. Add a key before attempting SSH operations.
            </div>
          ) : null}
        </div>
      </section>

    </div>
  )
}
