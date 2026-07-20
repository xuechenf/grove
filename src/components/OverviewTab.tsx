import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Cloud,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Router,
  Timer,
} from 'lucide-react'
import { apiDisabled, getVmOverview } from '../lib/api'
import { cx } from '../lib/format'
import { MetricTile } from './MetricTile'
import type { CloudMetricSeries, ServiceInfo, VM, VmOverviewTelemetry } from '../types'

interface OverviewTabProps {
  vm: VM
}

function serviceTone(service: ServiceInfo) {
  if (service.state === 'running') return 'bg-emerald-400'
  if (service.state === 'degraded') return 'bg-amber-500'
  return 'bg-slate-400'
}

function statusTone(status: string) {
  if (status === 'running') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'pending' || status === 'rebooting') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'stopped' || status === 'stopping') return 'border-slate-300 bg-slate-100 text-slate-600'
  return 'border-rose-200 bg-rose-50 text-rose-700'
}

function hostTelemetry(vm: VM, warning?: string): VmOverviewTelemetry {
  return {
    vm,
    source: 'host',
    sourceLabel: 'Host over SSH',
    sampledAt: vm.metrics.sampledAt,
    warnings: warning ? [warning] : [],
  }
}

function seriesFor(telemetry: VmOverviewTelemetry, key: CloudMetricSeries['key']) {
  return telemetry.cloudMetrics?.series.find((series) => series.key === key)
}

function latest(series: CloudMetricSeries | undefined) {
  return series?.points.at(-1)?.value
}

function rateMbps(series: CloudMetricSeries | undefined, periodSeconds: number) {
  const value = latest(series)
  if (value === undefined) return undefined
  if (series?.unit.toLowerCase().includes('bits/second')) return value / 1_000_000
  if (series?.unit.toLowerCase() === 'bytes') return (value * 8) / Math.max(periodSeconds, 1) / 1_000_000
  return value
}

function rateLabel(value: number | undefined) {
  if (value === undefined) return 'No data'
  if (value >= 1) return `${value.toFixed(2)} Mbps`
  return `${(value * 1000).toFixed(value * 1000 >= 10 ? 1 : 2)} Kbps`
}

function formatSampleTime(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function Sparkline({ series, className = 'text-blue-600' }: { series: CloudMetricSeries | undefined; className?: string }) {
  const points = series?.points ?? []
  if (points.length < 2) {
    return <div className="flex h-14 items-center justify-center rounded bg-slate-50 text-xs text-slate-400">Waiting for samples</div>
  }
  const values = points.map((point) => point.value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const span = Math.max(maximum - minimum, 0.0001)
  const path = points.map((point, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 100
    const y = 36 - ((point.value - minimum) / span) * 32
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  return (
    <svg viewBox="0 0 100 40" className={cx('h-14 w-full overflow-visible', className)} preserveAspectRatio="none" aria-hidden="true">
      <path d="M 0 36 L 100 36" fill="none" stroke="currentColor" strokeOpacity="0.12" vectorEffect="non-scaling-stroke" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Detail({ label, value }: { label: string; value?: string | number }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-all text-sm font-medium text-slate-700">{value ?? '—'}</dd>
    </div>
  )
}

export function OverviewTab({ vm }: OverviewTabProps) {
  const [telemetry, setTelemetry] = useState<VmOverviewTelemetry>(() => hostTelemetry(vm))
  const [loading, setLoading] = useState(!apiDisabled())
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (apiDisabled()) {
      return () => { cancelled = true }
    }
    void getVmOverview(vm.id, 1)
      .then((result) => {
        if (!cancelled) setTelemetry(result)
      })
      .catch((error) => {
        if (!cancelled) {
          setTelemetry((current) => hostTelemetry(
            current.vm,
            error instanceof Error ? error.message : 'Overview refresh failed.',
          ))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [vm.id, refreshToken])

  const currentVm = telemetry.vm
  const period = telemetry.cloudMetrics?.periodSeconds ?? 1
  const cpuSeries = seriesFor(telemetry, 'cpuPercent')
  const networkInSeries = seriesFor(telemetry, 'networkInBytes')
  const networkOutSeries = seriesFor(telemetry, 'networkOutBytes')
  const statusSeries = seriesFor(telemetry, 'statusCheckFailed')
  const statusCheckFailed = latest(statusSeries)
  const cloudCpu = latest(cpuSeries)
  const cpuPercent = cloudCpu === undefined ? currentVm.metrics.cpuPercent : Number(cloudCpu.toFixed(1))
  const networkInMbps = telemetry.source === 'host'
    ? currentVm.metrics.networkInMbps
    : rateMbps(networkInSeries, period)
  const networkOutMbps = telemetry.source === 'host'
    ? currentVm.metrics.networkOutMbps
    : rateMbps(networkOutSeries, period)
  const machineStatus = telemetry.cloudMachine?.state ?? currentVm.lifecycle
  const diskTone = currentVm.metrics.diskPercent >= currentVm.metrics.thresholds.diskWarning ? 'warning' : 'normal'
  const memoryTone = currentVm.metrics.memoryPercent >= currentVm.metrics.thresholds.memoryWarning ? 'warning' : 'normal'
  const hostSeries = useMemo(() => ({
    cpu: { key: 'cpuPercent', label: 'CPU utilization', unit: 'Percent', points: [{ timestamp: telemetry.sampledAt, value: currentVm.metrics.cpuPercent }] } as CloudMetricSeries,
    networkIn: { key: 'networkInBytes', label: 'Network in', unit: 'Megabits/Second', points: [{ timestamp: telemetry.sampledAt, value: currentVm.metrics.networkInMbps }] } as CloudMetricSeries,
    networkOut: { key: 'networkOutBytes', label: 'Network out', unit: 'Megabits/Second', points: [{ timestamp: telemetry.sampledAt, value: currentVm.metrics.networkOutMbps }] } as CloudMetricSeries,
  }), [currentVm.metrics, telemetry.sampledAt])

  return (
    <div className="space-y-4" data-testid="overview-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Cloud className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-950">Machine status</h2>
              <p className="truncate text-xs text-slate-500">{loading ? 'Matching VM to provider inventory…' : telemetry.sourceLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx('rounded border px-2 py-1 text-xs font-semibold capitalize', statusTone(machineStatus))}>{machineStatus}</span>
            <button
              type="button"
              onClick={() => {
                setTelemetry(hostTelemetry(vm))
                setLoading(true)
                setRefreshToken((value) => value + 1)
              }}
              disabled={loading}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </header>
        <dl className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4">
          <Detail label="Data source" value={telemetry.sourceLabel} />
          <Detail label="Location" value={telemetry.cloudMachine ? `${telemetry.cloudMachine.location}${telemetry.cloudMachine.zone ? ` / ${telemetry.cloudMachine.zone}` : ''}` : `${currentVm.provider.region} / ${currentVm.provider.node}`} />
          <Detail label="Machine type" value={telemetry.cloudMachine?.machineType || `${currentVm.resources.cpuCores} vCPU / ${currentVm.resources.memoryGb} GB`} />
          <Detail label="Last sample" value={formatSampleTime(telemetry.sampledAt)} />
        </dl>
        {telemetry.warnings.length ? (
          <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{telemetry.warnings.join(' ')}</span>
          </div>
        ) : null}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="CPU"
          value={`${cpuPercent}%`}
          detail={telemetry.source === 'host' ? `${currentVm.resources.cpuCores} cores, load ${currentVm.metrics.loadAverage.join(' ')}` : telemetry.sourceLabel}
          percent={cpuPercent}
          icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Memory"
          value={`${currentVm.metrics.memoryPercent}%`}
          detail={`${currentVm.resources.memoryGb} GB · host reported`}
          percent={currentVm.metrics.memoryPercent}
          tone={memoryTone}
          icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Disk"
          value={`${currentVm.metrics.diskPercent}%`}
          detail={`${currentVm.resources.diskGb} GB · host reported`}
          percent={currentVm.metrics.diskPercent}
          tone={diskTone}
          icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Network"
          value={`${rateLabel(networkInMbps)} / ${rateLabel(networkOutMbps)}`}
          detail="in / out"
          icon={<Network className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded border border-slate-200 bg-white" data-testid="network-panel">
          <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <Router className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-slate-950">Network</h2>
              <p className="text-xs text-slate-500">Addresses, cloud network, and current throughput</p>
            </div>
          </header>
          <div className="grid gap-4 p-3 sm:grid-cols-2">
            <dl className="grid gap-3">
              <Detail label="Public IP" value={telemetry.cloudMachine?.publicIp || currentVm.ipAddress || currentVm.connection.host} />
              <Detail label="Private IP" value={telemetry.cloudMachine?.privateIp} />
              <Detail label="Network type" value={telemetry.cloudMachine?.networkType || 'Host interface'} />
            </dl>
            <dl className="grid gap-3">
              <Detail label="VPC / virtual network" value={telemetry.cloudMachine?.vpcId} />
              <Detail label="Subnet / VSwitch" value={telemetry.cloudMachine?.subnetId} />
              <Detail label="Security groups" value={telemetry.cloudMachine ? telemetry.cloudMachine.firewalls.length : 'Host managed'} />
            </dl>
          </div>
          <div className="grid gap-2 border-t border-slate-100 p-3 sm:grid-cols-2">
            <div className="rounded bg-slate-50 px-3 py-2">
              <div className="text-[11px] font-medium uppercase text-slate-400">Inbound now</div>
              <div className="mt-1 text-lg font-semibold text-slate-800">{rateLabel(networkInMbps)}</div>
            </div>
            <div className="rounded bg-slate-50 px-3 py-2">
              <div className="text-[11px] font-medium uppercase text-slate-400">Outbound now</div>
              <div className="mt-1 text-lg font-semibold text-slate-800">{rateLabel(networkOutMbps)}</div>
            </div>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white" data-testid="metrics-panel">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Metrics</h2>
                <p className="text-xs text-slate-500">{telemetry.source === 'host' ? 'Current host sample' : 'Last hour from the cloud provider'}</p>
              </div>
            </div>
            <span className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500">{telemetry.source === 'aws' ? 'CloudWatch' : telemetry.source === 'alicloud' ? 'CloudMonitor' : 'SSH'}</span>
          </header>
          <div className="grid gap-3 p-3 sm:grid-cols-3">
            <div className="rounded border border-slate-200 p-2">
              <div className="text-xs font-medium text-slate-600">CPU</div>
              <div className="mt-1 text-base font-semibold text-slate-900">{cpuPercent}%</div>
              <Sparkline series={cpuSeries ?? hostSeries.cpu} />
            </div>
            <div className="rounded border border-slate-200 p-2">
              <div className="text-xs font-medium text-slate-600">Network in</div>
              <div className="mt-1 text-base font-semibold text-slate-900">{rateLabel(networkInMbps)}</div>
              <Sparkline series={networkInSeries ?? hostSeries.networkIn} className="text-emerald-600" />
            </div>
            <div className="rounded border border-slate-200 p-2">
              <div className="text-xs font-medium text-slate-600">Network out</div>
              <div className="mt-1 text-base font-semibold text-slate-900">{rateLabel(networkOutMbps)}</div>
              <Sparkline series={networkOutSeries ?? hostSeries.networkOut} className="text-violet-600" />
            </div>
          </div>
          {telemetry.source === 'aws' ? (
            <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              EC2 status check:{' '}
              <strong className={statusCheckFailed === undefined ? 'text-slate-500' : statusCheckFailed > 0 ? 'text-rose-700' : 'text-emerald-700'}>
                {statusCheckFailed === undefined ? 'no data' : statusCheckFailed > 0 ? 'failed' : 'passing'}
              </strong>
            </div>
          ) : null}
        </section>
      </div>

      <div className="grid gap-4 2xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded border border-slate-200 bg-white">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-950">Services</h2>
              <p className="text-xs text-slate-500">Primary daemons and resource use</p>
            </div>
            <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">sampled {formatSampleTime(currentVm.metrics.sampledAt)}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-slate-100 bg-white text-[11px] uppercase text-slate-500">
                <tr><th className="px-3 py-2 font-medium">Service</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 font-medium">Port</th><th className="px-3 py-2 font-medium">CPU</th><th className="px-3 py-2 font-medium">Memory</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentVm.services.length === 0 ? (
                  <tr><td className="px-3 py-3 text-sm text-slate-500" colSpan={5}>No service data returned by this VM.</td></tr>
                ) : currentVm.services.map((service) => (
                  <tr key={service.name}>
                    <td className="px-3 py-2 font-medium text-slate-800">{service.name}</td>
                    <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600"><span className={cx('h-2 w-2 rounded-full', serviceTone(service))} />{service.state}</span></td>
                    <td className="px-3 py-2 text-slate-500">{service.port ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{service.cpuPercent}%</td>
                    <td className="px-3 py-2 text-slate-500">{service.memoryMb} MB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-3 py-2"><h2 className="text-sm font-semibold text-slate-950">Runtime</h2><p className="text-xs text-slate-500">Uptime and top processes</p></header>
          <div className="space-y-3 p-3">
            <div className="grid gap-2 2xl:grid-cols-2">
              <MetricTile label="Uptime" value={currentVm.metrics.uptime} detail={currentVm.lifecycle} icon={<Timer className="h-4 w-4" aria-hidden="true" />} />
              <MetricTile label="Provider" value={telemetry.source === 'host' ? currentVm.provider.name : telemetry.cloudMachine?.credentialProfileName || currentVm.provider.name} detail={telemetry.sourceLabel} icon={<Database className="h-4 w-4" aria-hidden="true" />} />
            </div>
            <div className="rounded border border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-600"><Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />Top processes</div>
              {currentVm.processes.length === 0 ? <p className="px-3 py-3 text-sm text-slate-500">No process data while this VM is stopped.</p> : (
                <div className="divide-y divide-slate-100">{currentVm.processes.map((process) => (
                  <div key={process.pid} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-sm"><div className="min-w-0"><div className="truncate font-medium text-slate-700">{process.command}</div><div className="truncate text-xs text-slate-500">pid {process.pid} / {process.user} / {process.memoryMb} MB</div></div><span className="text-slate-500">{process.cpuPercent}% CPU</span></div>
                ))}</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
