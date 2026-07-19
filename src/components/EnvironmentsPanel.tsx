import { AlertTriangle, CheckCircle2, Cloud, LoaderCircle, Server, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cx } from '../lib/format'
import type {
  ApplicationEnvironment,
  ApplicationEnvironmentInput,
  CredentialProfile,
  GroveApplication,
  TerraformRuntimeStatus,
} from '../types'

interface EnvironmentsPanelProps {
  application: GroveApplication
  credentialProfiles: CredentialProfile[]
  terraform: TerraformRuntimeStatus
  onInstallTerraform: () => Promise<void>
  onCreate: (input: ApplicationEnvironmentInput) => Promise<void>
  onPlan: (environmentId: string, destroy: boolean) => Promise<void>
  onApply: (environmentId: string, planOperationId: string) => Promise<void>
  onOpenVm: (vmId: string) => void
}

export function EnvironmentsPanel({
  application,
  terraform,
  onInstallTerraform,
  onPlan,
  onApply,
  onOpenVm,
}: EnvironmentsPanelProps) {
  const [busyEnvironmentId, setBusyEnvironmentId] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [installingTerraform, setInstallingTerraform] = useState(false)

  async function installRuntime() {
    setInstallingTerraform(true)
    setMessage(undefined)
    try {
      await onInstallTerraform()
      setMessage('Terraform was installed and is ready.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Terraform installation failed.')
    } finally {
      setInstallingTerraform(false)
    }
  }

  async function run(environmentId: string, operation: () => Promise<void>, success: string) {
    setBusyEnvironmentId(environmentId)
    setMessage(undefined)
    try {
      await operation()
      setMessage(success)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Infrastructure operation failed.')
    } finally {
      setBusyEnvironmentId(undefined)
    }
  }

  return (
    <div className="grid gap-4">
      <section className={cx('flex flex-wrap items-center gap-3 rounded border p-3', terraform.available ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
        {terraform.available ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : <AlertTriangle className="h-4 w-4 text-amber-700" />}
        <span className="min-w-0 flex-1 text-xs text-slate-700">{terraform.detail}</span>
        {!terraform.available ? (
          <button
            type="button"
            disabled={installingTerraform}
            onClick={installRuntime}
            className="inline-flex h-9 items-center gap-2 rounded border border-amber-300 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            {installingTerraform ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {installingTerraform ? 'Installing…' : 'Install Terraform'}
          </button>
        ) : null}
        <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
          Existing resources only · creation disabled
        </span>
      </section>
      {message ? <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">{message}</div> : null}

      {application.environments.length ? (
        <div className="grid gap-4">
          {application.environments.map((environment) => (
            <EnvironmentCard
              key={environment.id}
              environment={environment}
              busy={busyEnvironmentId === environment.id}
              onDestroyPlan={() => run(environment.id, () => onPlan(environment.id, true), 'Destroy plan is ready for review.')}
              onApply={(planId) => run(environment.id, () => onApply(environment.id, planId), 'Managed resources were destroyed.')}
              onOpenVm={onOpenVm}
            />
          ))}
        </div>
      ) : (
        <section className="rounded border border-dashed border-slate-300 bg-white p-8 text-center">
          <Cloud className="mx-auto h-6 w-6 text-slate-400" />
          <h3 className="mt-3 text-sm font-semibold text-slate-900">No managed Terraform environments</h3>
          <p className="mt-1 text-xs text-slate-500">Grove discovers and operates existing cloud VMs from the Fleet view. It does not create cloud resources.</p>
        </section>
      )}
    </div>
  )
}

function EnvironmentCard({
  environment,
  busy,
  onDestroyPlan,
  onApply,
  onOpenVm,
}: {
  environment: ApplicationEnvironment
  busy: boolean
  onDestroyPlan: () => void
  onApply: (planOperationId: string) => void
  onOpenVm: (vmId: string) => void
}) {
  const plan = environment.operations.find(
    (operation) => operation.status === 'succeeded' && operation.kind === 'destroy-plan',
  )
  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-950">{environment.name}</h3>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium uppercase text-slate-600">{environment.provider}</span>
            <span className={cx('rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize', environment.status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : environment.status === 'failed' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-700')}>{environment.status.replace('_', ' ')}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">{environment.region} · {environment.instanceType} · {environment.vmName}</p>
        </div>
        {environment.vmIds.length ? (
          <button type="button" disabled={busy} onClick={onDestroyPlan} className="inline-flex h-8 items-center gap-1.5 rounded border border-rose-200 px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-45">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Plan destroy
          </button>
        ) : null}
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <dl className="grid gap-2 text-xs">
          <Detail label="Image" value={environment.imageId} mono />
          <Detail label="Disk" value={`${environment.diskSizeGb} GB`} />
          <Detail label="Public IP" value={environment.publicIp || 'Not recorded'} mono />
          {environment.hostname ? <Detail label="Public hostname" value={`${environment.hostname} · ${environment.dnsStatus.replace('_', ' ')}`} mono /> : null}
        </dl>
        <div className="md:col-span-2">
          {plan?.changes ? (
            <div className="rounded border border-rose-200 bg-rose-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-900">Reviewed destroy plan</div>
                  <div className="mt-1 text-xs text-slate-500">{plan.changes.add} add · {plan.changes.change} change · {plan.changes.destroy} destroy</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onApply(plan.id)}
                  className="inline-flex h-8 items-center gap-2 rounded bg-rose-700 px-3 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-45"
                >
                  {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Destroy reviewed resources
                </button>
              </div>
            </div>
          ) : <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500">No reviewed destroy plan. Grove cannot create or apply new infrastructure.</div>}
          {environment.vmIds.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {environment.vmIds.map((vmId) => <button key={vmId} type="button" onClick={() => onOpenVm(vmId)} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Server className="h-3.5 w-3.5" /> Open VM</button>)}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={cx('mt-0.5 break-all text-slate-700', mono && 'font-mono')}>{value}</dd>
    </div>
  )
}
