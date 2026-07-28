import { AlertTriangle, Boxes, Cloud, Cpu, HardDrive, MemoryStick, Network, RefreshCw, ServerCog } from 'lucide-react'
import { cx } from '../lib/format'
import { formatSampleTime, rateLabel, telemetrySourceLabel, telemetryValues } from '../lib/vmTelemetry'
import type { GroveApplication, ServiceInfo, VM, VmOverviewTelemetry } from '../types'
import { MetricTile } from './MetricTile'

interface OverviewTabProps {
  vm: VM
  telemetry: VmOverviewTelemetry
  applications?: GroveApplication[]
  loading?: boolean
  onRefresh?: () => void
}

function statusTone(status: string) {
  if (status === 'running') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'pending' || status === 'rebooting') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'stopped' || status === 'stopping') return 'border-slate-300 bg-slate-100 text-slate-600'
  return 'border-rose-200 bg-rose-50 text-rose-700'
}

function Detail({ label, value }: { label: string; value?: string | number }) {
  return <div><dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt><dd className="mt-0.5 break-all text-sm font-medium text-slate-700">{value ?? '—'}</dd></div>
}

function serviceSummary(services: ServiceInfo[]) {
  const running = services.filter((service) => service.state === 'running').length
  const attention = services.length - running
  return `${running} running${attention ? ` · ${attention} need attention` : ''}`
}

function versionLabel(application: GroveApplication, versionId?: string) {
  if (!versionId) return 'No version'
  const version = application.versions.find((candidate) => candidate.id === versionId)
  return version ? `v${version.sequence}` : versionId
}

export function OverviewTab({ vm, telemetry, applications = [], loading = false, onRefresh }: OverviewTabProps) {
  const currentVm = telemetry.vm ?? vm
  const values = telemetryValues(telemetry)
  const machineStatus = telemetry.cloudMachine?.state ?? currentVm.lifecycle
  const deployedApplications = applications.flatMap((application) => {
    const instance = application.instances.find((candidate) => candidate.vmId === vm.id)
    return instance ? [{ application, instance }] : []
  })
  const alerts = currentVm.alerts.filter((alert) => alert !== 'No active alerts')

  return (
    <div className="space-y-4" data-testid="overview-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Cloud className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-950">Machine status</h2>
              <p className="truncate text-xs text-slate-500">{loading ? 'Refreshing provider and host status…' : telemetrySourceLabel(telemetry)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx('rounded border px-2 py-1 text-xs font-semibold capitalize', statusTone(machineStatus))}>{machineStatus}</span>
            {onRefresh ? <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />Refresh</button> : null}
          </div>
        </header>
        <dl className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4">
          <Detail label="Provider" value={telemetry.source === 'host' ? 'Host managed' : telemetry.cloudMachine?.provider.toUpperCase()} />
          <Detail label="Location" value={telemetry.cloudMachine ? `${telemetry.cloudMachine.location}${telemetry.cloudMachine.zone ? ` / ${telemetry.cloudMachine.zone}` : ''}` : `${currentVm.provider.region} / ${currentVm.provider.node}`} />
          <Detail label="Machine type" value={telemetry.cloudMachine?.machineType || `${currentVm.resources.cpuCores} vCPU / ${currentVm.resources.memoryGb} GB`} />
          <Detail label="Last sample" value={formatSampleTime(telemetry.sampledAt)} />
        </dl>
        {telemetry.warnings.length ? <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{telemetry.warnings.join(' ')}</span></div> : null}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="CPU" value={`${values.cpuPercent}%`} detail={telemetry.source === 'host' ? `${currentVm.resources.cpuCores} cores · SSH` : telemetry.source === 'aws' ? 'CloudWatch' : telemetry.source === 'azure' ? 'Azure Monitor' : 'CloudMonitor'} percent={values.cpuPercent} icon={<Cpu className="h-4 w-4" aria-hidden="true" />} />
        <MetricTile label="Memory" value={`${currentVm.metrics.memoryPercent}%`} detail={`${currentVm.resources.memoryGb} GB · SSH`} percent={currentVm.metrics.memoryPercent} tone={currentVm.metrics.memoryPercent >= currentVm.metrics.thresholds.memoryWarning ? 'warning' : 'normal'} icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />} />
        <MetricTile label="Disk" value={`${currentVm.metrics.diskPercent}%`} detail={`${currentVm.resources.diskGb} GB · SSH`} percent={currentVm.metrics.diskPercent} tone={currentVm.metrics.diskPercent >= currentVm.metrics.thresholds.diskWarning ? 'warning' : 'normal'} icon={<HardDrive className="h-4 w-4" aria-hidden="true" />} />
        <MetricTile label="Traffic now" value={`${rateLabel(values.networkInMbps)} / ${rateLabel(values.networkOutMbps)}`} detail="in / out · details in Monitoring" icon={<Network className="h-4 w-4" aria-hidden="true" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded border border-slate-200 bg-white" data-testid="overview-applications">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div className="flex items-center gap-2"><Boxes className="h-4 w-4 text-slate-500" aria-hidden="true" /><div><h2 className="text-sm font-semibold text-slate-950">Applications</h2><p className="text-xs text-slate-500">Workloads deployed to this VM</p></div></div><span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{deployedApplications.length} deployed</span></header>
          {deployedApplications.length ? <div className="divide-y divide-slate-100">{deployedApplications.slice(0, 5).map(({ application, instance }) => <div key={application.id} className="flex items-center justify-between gap-3 px-3 py-2.5"><div className="min-w-0"><strong className="block truncate text-sm text-slate-800">{application.name}</strong><span className="block truncate text-xs text-slate-500">{versionLabel(application, instance.versionId)} · {instance.remotePath}</span></div><span className="rounded border border-slate-200 px-2 py-1 text-xs capitalize text-slate-600">{instance.status}</span></div>)}</div> : <p className="px-3 py-4 text-sm text-slate-500">No Grove applications are deployed to this VM.</p>}
        </section>

        <section className="rounded border border-slate-200 bg-white">
          <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2"><ServerCog className="h-4 w-4 text-slate-500" aria-hidden="true" /><div><h2 className="text-sm font-semibold text-slate-950">Operational summary</h2><p className="text-xs text-slate-500">Attention and host services</p></div></header>
          <div className="grid gap-3 p-3 sm:grid-cols-2">
            <div className="rounded border border-slate-200 p-3"><div className="text-[11px] font-medium uppercase text-slate-400">Services</div><div className="mt-1 text-sm font-semibold text-slate-800">{serviceSummary(currentVm.services)}</div><div className="mt-1 text-xs text-slate-500">{currentVm.services.length} sampled over SSH</div></div>
            <div className={cx('rounded border p-3', alerts.length ? 'border-amber-200 bg-amber-50' : 'border-slate-200')}><div className="text-[11px] font-medium uppercase text-slate-400">Alerts</div><div className="mt-1 text-sm font-semibold text-slate-800">{alerts.length ? `${alerts.length} active` : 'No active alerts'}</div><div className="mt-1 line-clamp-2 text-xs text-slate-500">{alerts[0] ?? 'Machine and connection checks are healthy.'}</div></div>
          </div>
        </section>
      </div>
    </div>
  )
}
