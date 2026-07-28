import { Cpu, HardDrive, MemoryStick, Network, RefreshCw, Timer } from 'lucide-react'
import { cx } from '../lib/format'
import { formatSampleTime, latestMetric, rateLabel, seriesFor, telemetrySourceLabel, telemetryValues } from '../lib/vmTelemetry'
import type { CloudMetricSeries, ServiceInfo, VM, VmOverviewTelemetry } from '../types'

interface MonitoringTabProps {
  vm: VM
  telemetry: VmOverviewTelemetry
  loading?: boolean
  onRefresh?: () => void
}

function Sparkline({ series, className = 'text-blue-600' }: { series?: CloudMetricSeries; className?: string }) {
  const points = series?.points ?? []
  if (points.length < 2) return <div className="flex h-14 items-center justify-center rounded bg-slate-50 text-xs text-slate-400">Waiting for samples</div>
  const values = points.map((point) => point.value)
  const minimum = Math.min(...values)
  const span = Math.max(Math.max(...values) - minimum, 0.0001)
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${((index / (points.length - 1)) * 100).toFixed(2)} ${(36 - ((point.value - minimum) / span) * 32).toFixed(2)}`).join(' ')
  return <svg viewBox="0 0 100 40" className={cx('h-14 w-full overflow-visible', className)} preserveAspectRatio="none" aria-hidden="true"><path d="M 0 36 L 100 36" fill="none" stroke="currentColor" strokeOpacity="0.12" vectorEffect="non-scaling-stroke" /><path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
}

function serviceTone(service: ServiceInfo) {
  return service.state === 'running' ? 'bg-emerald-400' : service.state === 'degraded' ? 'bg-amber-500' : 'bg-slate-400'
}

function MetricCard({ label, value, source, icon, series, tone }: { label: string; value: string; source: string; icon: React.ReactNode; series?: CloudMetricSeries; tone?: string }) {
  return <div className="rounded border border-slate-200 bg-white p-3"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">{icon}{label}</span><span className="text-[10px] uppercase text-slate-400">{source}</span></div><div className="mt-2 text-lg font-semibold text-slate-900">{value}</div>{series ? <Sparkline series={series} className={tone} /> : <div className="mt-2 h-14 rounded bg-slate-50" />}</div>
}

export function MonitoringTab({ vm, telemetry, loading = false, onRefresh }: MonitoringTabProps) {
  const currentVm = telemetry.vm ?? vm
  const values = telemetryValues(telemetry)
  const statusCheckFailed = latestMetric(seriesFor(telemetry, 'statusCheckFailed'))
  const cloudSource = telemetry.source === 'aws' ? 'CloudWatch' : telemetry.source === 'azure' ? 'Azure Monitor' : telemetry.source === 'alicloud' ? 'CloudMonitor' : 'SSH'

  return (
    <div className="space-y-4" data-testid="monitoring-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div><h2 className="text-sm font-semibold text-slate-950">Resource monitoring</h2><p className="text-xs text-slate-500">{telemetrySourceLabel(telemetry)} · sampled {formatSampleTime(telemetry.sampledAt)}</p></div>{onRefresh ? <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</button> : null}</header>
        <div className="grid gap-3 p-3 sm:grid-cols-2 2xl:grid-cols-5">
          <MetricCard label="CPU" value={`${values.cpuPercent}%`} source={cloudSource} icon={<Cpu className="h-3.5 w-3.5" />} series={values.cpuSeries} />
          <MetricCard label="Memory" value={`${currentVm.metrics.memoryPercent}%`} source="SSH" icon={<MemoryStick className="h-3.5 w-3.5" />} />
          <MetricCard label="Disk" value={`${currentVm.metrics.diskPercent}%`} source="SSH" icon={<HardDrive className="h-3.5 w-3.5" />} />
          <MetricCard label="Network in" value={rateLabel(values.networkInMbps)} source={cloudSource} icon={<Network className="h-3.5 w-3.5" />} series={values.networkInSeries} tone="text-emerald-600" />
          <MetricCard label="Network out" value={rateLabel(values.networkOutMbps)} source={cloudSource} icon={<Network className="h-3.5 w-3.5" />} series={values.networkOutSeries} tone="text-violet-600" />
        </div>
        {telemetry.source === 'aws' ? <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">EC2 status check: <strong className={statusCheckFailed === undefined ? 'text-slate-500' : statusCheckFailed > 0 ? 'text-rose-700' : 'text-emerald-700'}>{statusCheckFailed === undefined ? 'no data' : statusCheckFailed > 0 ? 'failed' : 'passing'}</strong></div> : null}
      </section>

      <div className="grid gap-4 2xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded border border-slate-200 bg-white">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div><h2 className="text-sm font-semibold text-slate-950">Services</h2><p className="text-xs text-slate-500">Primary daemons and resource use</p></div><span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{currentVm.services.length} sampled</span></header>
          <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm"><thead className="border-b border-slate-100 text-[11px] uppercase text-slate-500"><tr><th className="px-3 py-2 font-medium">Service</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 font-medium">Port</th><th className="px-3 py-2 font-medium">CPU</th><th className="px-3 py-2 font-medium">Memory</th></tr></thead><tbody className="divide-y divide-slate-100">{currentVm.services.length ? currentVm.services.map((service) => <tr key={service.name}><td className="px-3 py-2 font-medium text-slate-800">{service.name}</td><td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600"><span className={cx('h-2 w-2 rounded-full', serviceTone(service))} />{service.state}</span></td><td className="px-3 py-2 text-slate-500">{service.port ?? '—'}</td><td className="px-3 py-2 text-slate-500">{service.cpuPercent}%</td><td className="px-3 py-2 text-slate-500">{service.memoryMb} MB</td></tr>) : <tr><td className="px-3 py-3 text-slate-500" colSpan={5}>No service data returned by this VM.</td></tr>}</tbody></table></div>
        </section>

        <section className="rounded border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-3 py-2"><h2 className="text-sm font-semibold text-slate-950">Runtime</h2><p className="text-xs text-slate-500">Uptime and top processes</p></header>
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3"><Timer className="h-4 w-4 text-slate-500" /><div><div className="text-sm font-semibold text-slate-800">{currentVm.metrics.uptime}</div><div className="text-xs capitalize text-slate-500">{currentVm.lifecycle}</div></div></div>
          <div className="divide-y divide-slate-100">{currentVm.processes.length ? currentVm.processes.map((process) => <div key={process.pid} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-sm"><div className="min-w-0"><div className="truncate font-medium text-slate-700">{process.command}</div><div className="truncate text-xs text-slate-500">pid {process.pid} · {process.user} · {process.memoryMb} MB</div></div><span className="text-slate-500">{process.cpuPercent}% CPU</span></div>) : <p className="px-3 py-3 text-sm text-slate-500">No process data while this VM is stopped.</p>}</div>
        </section>
      </div>
    </div>
  )
}
