import * as Progress from '@radix-ui/react-progress'
import { Activity, Cpu, Database, HardDrive, MemoryStick, Network, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'
import type { ServiceInfo, VM } from '../types'

interface OverviewTabProps {
  vm: VM
}

interface MetricTileProps {
  label: string
  value: string
  detail: string
  percent?: number
  tone?: 'normal' | 'warning' | 'critical' | 'info'
  icon: ReactNode
}

const toneStyles = {
  normal: 'bg-slate-700',
  warning: 'bg-amber-400',
  critical: 'bg-rose-500',
  info: 'bg-slate-500',
}

function MetricTile({ label, value, detail, percent, tone = 'normal', icon }: MetricTileProps) {
  return (
    <section className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-500">
          <span className="text-slate-400">{icon}</span>
          <span className="truncate">{label}</span>
        </span>
        <span className="text-sm font-semibold text-slate-950">{value}</span>
      </div>
      {typeof percent === 'number' ? (
        <Progress.Root className="mb-2 h-1 overflow-hidden rounded bg-slate-100" value={percent}>
          <Progress.Indicator
            className={cx('h-full rounded transition-transform', toneStyles[tone])}
            style={{ transform: `translateX(-${100 - percent}%)` }}
          />
        </Progress.Root>
      ) : null}
      <p className="truncate text-xs text-slate-500">{detail}</p>
    </section>
  )
}

function serviceTone(service: ServiceInfo) {
  if (service.state === 'running') {
    return 'bg-emerald-400'
  }

  if (service.state === 'degraded') {
    return 'bg-amber-500'
  }

  return 'bg-slate-400'
}

export function OverviewTab({ vm }: OverviewTabProps) {
  const diskTone = vm.metrics.diskPercent >= vm.metrics.thresholds.diskWarning ? 'warning' : 'normal'
  const memoryTone = vm.metrics.memoryPercent >= vm.metrics.thresholds.memoryWarning ? 'warning' : 'normal'

  return (
    <div className="space-y-4" data-testid="overview-tab">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="CPU"
          value={`${vm.metrics.cpuPercent}%`}
          detail={`${vm.resources.cpuCores} cores, load ${vm.metrics.loadAverage.join(' ')}`}
          percent={vm.metrics.cpuPercent}
          icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Memory"
          value={`${vm.metrics.memoryPercent}%`}
          detail={`${vm.resources.memoryGb} GB allocated`}
          percent={vm.metrics.memoryPercent}
          tone={memoryTone}
          icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Disk"
          value={`${vm.metrics.diskPercent}%`}
          detail={`${vm.resources.diskGb} GB virtual disk`}
          percent={vm.metrics.diskPercent}
          tone={diskTone}
          icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricTile
          label="Network"
          value={`${vm.metrics.networkInMbps}/${vm.metrics.networkOutMbps}`}
          detail="Mbps in / out"
          icon={<Network className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      <div className="grid gap-4 2xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded border border-slate-200 bg-white">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-950">Services</h2>
              <p className="text-xs text-slate-500">Primary daemons and resource use</p>
            </div>
            <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">
              sampled {vm.metrics.sampledAt}
            </span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-slate-100 bg-white text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Port</th>
                  <th className="px-3 py-2 font-medium">CPU</th>
                  <th className="px-3 py-2 font-medium">Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vm.services.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-sm text-slate-500" colSpan={5}>
                      No service data returned by this VM.
                    </td>
                  </tr>
                ) : (
                  vm.services.map((service) => (
                    <tr key={service.name}>
                      <td className="px-3 py-2 font-medium text-slate-800">{service.name}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600">
                          <span className={cx('h-2 w-2 rounded-full', serviceTone(service))} />
                          {service.state}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{service.port ?? '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{service.cpuPercent}%</td>
                      <td className="px-3 py-2 text-slate-500">{service.memoryMb} MB</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-950">Runtime</h2>
            <p className="text-xs text-slate-500">Uptime and top processes</p>
          </header>
          <div className="space-y-3 p-3">
            <div className="grid gap-2 2xl:grid-cols-2">
              <MetricTile
                label="Uptime"
                value={vm.metrics.uptime}
                detail={vm.lifecycle}
                icon={<Timer className="h-4 w-4" aria-hidden="true" />}
              />
              <MetricTile
                label="Provider"
                value={vm.provider.name}
                detail={`${vm.provider.region} / ${vm.provider.node}`}
                icon={<Database className="h-4 w-4" aria-hidden="true" />}
              />
            </div>
            <div className="rounded border border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                <Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />
                Top processes
              </div>
              {vm.processes.length === 0 ? (
                <p className="px-3 py-3 text-sm text-slate-500">No process data while this VM is stopped.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {vm.processes.map((process) => (
                    <div key={process.pid} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-700">{process.command}</div>
                        <div className="truncate text-xs text-slate-500">
                          pid {process.pid} / {process.user} / {process.memoryMb} MB
                        </div>
                      </div>
                      <span className="text-slate-500">{process.cpuPercent}% CPU</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
