import { AlertTriangle, Cpu, HardDrive, MemoryStick, PanelRightClose, Server } from 'lucide-react'
import { cx } from '../lib/format'
import { IconButton } from './IconButton'
import { MetricTile } from './MetricTile'
import { StatusPill } from './StatusPill'
import type { VM } from '../types'

interface FleetOverviewTabProps {
  vms: VM[]
  onSelectVm: (vmId: string) => void
  onCollapse?: () => void
}

/** Fixture/backend placeholder entry meaning "nothing to report"; never a real alert. */
const ALERT_PLACEHOLDER = 'No active alerts'

function realAlerts(vm: VM) {
  return vm.alerts.filter((alert) => alert !== ALERT_PLACEHOLDER)
}

function average(values: number[]) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined
}

/** A tiny inline usage bar for the per-VM table; warns once the metric crosses its threshold. */
function MiniBar({ percent, warnAt }: { percent: number; warnAt?: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-14 overflow-hidden rounded bg-slate-100">
        <span
          className={cx('block h-full rounded', warnAt !== undefined && percent >= warnAt ? 'bg-amber-400' : 'bg-slate-700')}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className="text-xs text-slate-500">{percent}%</span>
    </span>
  )
}

/**
 * Fleet-wide dashboard shown in the workspace panel when the "All VMs" scope is active:
 * summary tiles, a per-VM table that drills down into a machine, and the active alerts list.
 */
export function FleetOverviewTab({ vms, onSelectVm, onCollapse }: FleetOverviewTabProps) {
  const running = vms.filter((vm) => vm.lifecycle === 'running')
  const stopped = vms.length - running.length
  const needsAttention = vms.filter((vm) => vm.health === 'warning' || vm.health === 'critical').length
  const alertEntries = vms.flatMap((vm) => realAlerts(vm).map((alert) => ({ vm, alert })))
  const avgCpu = average(running.map((vm) => vm.metrics.cpuPercent))
  const avgMemory = average(running.map((vm) => vm.metrics.memoryPercent))
  const avgDisk = average(running.map((vm) => vm.metrics.diskPercent))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="fleet-overview-tab">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold tracking-normal text-slate-950">All VMs</h2>
            <p className="truncate text-sm text-slate-500">
              {running.length} running · {stopped} stopped · {needsAttention} need attention
            </p>
          </div>
          {onCollapse ? (
            <IconButton label="Collapse VM workspace" onClick={onCollapse} className="hidden lg:inline-flex">
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            <MetricTile
              label="Running"
              value={`${running.length}/${vms.length}`}
              detail={`${stopped} stopped`}
              icon={<Server className="h-4 w-4" aria-hidden="true" />}
            />
            <MetricTile
              label="Alerts"
              value={String(alertEntries.length)}
              detail={`${needsAttention} VM${needsAttention === 1 ? '' : 's'} need attention`}
              tone={alertEntries.length > 0 ? 'warning' : 'normal'}
              icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
            />
            <MetricTile
              label="Avg CPU"
              value={avgCpu === undefined ? '—' : `${avgCpu}%`}
              detail={running.length ? `across ${running.length} running VM${running.length === 1 ? '' : 's'}` : 'No running VMs'}
              percent={avgCpu}
              icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
            />
            <MetricTile
              label="Avg Memory"
              value={avgMemory === undefined ? '—' : `${avgMemory}%`}
              detail={running.length ? `across ${running.length} running VM${running.length === 1 ? '' : 's'}` : 'No running VMs'}
              percent={avgMemory}
              icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}
            />
            <MetricTile
              label="Avg Disk"
              value={avgDisk === undefined ? '—' : `${avgDisk}%`}
              detail={running.length ? `across ${running.length} running VM${running.length === 1 ? '' : 's'}` : 'No running VMs'}
              percent={avgDisk}
              icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
            />
          </div>

          <section className="rounded border border-slate-200 bg-white">
            <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">Virtual machines</h3>
                <p className="text-xs text-slate-500">Click a row to open that VM</p>
              </div>
              <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{vms.length} total</span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-slate-100 bg-white text-[11px] uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">VM</th>
                    <th className="px-3 py-2 font-medium">Host</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">CPU</th>
                    <th className="px-3 py-2 font-medium">Memory</th>
                    <th className="px-3 py-2 font-medium">Disk</th>
                    <th className="px-3 py-2 font-medium">Alerts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vms.length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-sm text-slate-500" colSpan={7}>
                        No VMs in the inventory yet.
                      </td>
                    </tr>
                  ) : (
                    vms.map((vm) => {
                      const alerts = realAlerts(vm).length
                      return (
                        <tr
                          key={vm.id}
                          onClick={() => onSelectVm(vm.id)}
                          className="cursor-pointer transition hover:bg-slate-50"
                        >
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              aria-label={`Open ${vm.name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                onSelectVm(vm.id)
                              }}
                              className="block min-w-0 text-left"
                            >
                              <span className="block truncate font-medium text-slate-800">{vm.name}</span>
                              <span className="block truncate text-xs text-slate-500">{vm.hostname}</span>
                            </button>
                          </td>
                          <td className="px-3 py-2 text-slate-500">{vm.connection.host}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-col gap-0.5">
                              <StatusPill status={vm.health} compact />
                              <span className="text-xs text-slate-400">{vm.lifecycle}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <MiniBar percent={vm.metrics.cpuPercent} />
                          </td>
                          <td className="px-3 py-2">
                            <MiniBar percent={vm.metrics.memoryPercent} warnAt={vm.metrics.thresholds.memoryWarning} />
                          </td>
                          <td className="px-3 py-2">
                            <MiniBar percent={vm.metrics.diskPercent} warnAt={vm.metrics.thresholds.diskWarning} />
                          </td>
                          <td className="px-3 py-2">
                            {alerts > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                                {alerts}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded border border-slate-200 bg-white">
            <header className="border-b border-slate-200 px-3 py-2">
              <h3 className="text-sm font-semibold text-slate-950">Active alerts</h3>
              <p className="text-xs text-slate-500">Across the whole fleet</p>
            </header>
            {alertEntries.length === 0 ? (
              <p className="px-3 py-3 text-sm text-slate-500">No active alerts across the fleet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {alertEntries.map(({ vm, alert }, index) => (
                  <div key={`${vm.id}-${index}`} className="flex items-start gap-2 px-3 py-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onSelectVm(vm.id)}
                        className="font-medium text-slate-800 underline-offset-2 hover:underline"
                      >
                        {vm.name}
                      </button>
                      <span className="text-slate-600"> — {alert}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
