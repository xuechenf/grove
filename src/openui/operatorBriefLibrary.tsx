/* eslint-disable react-refresh/only-export-components */
import { createLibrary, defineComponent, useIsStreaming, useTriggerAction } from '@openuidev/react-lang'
import { z } from 'zod'
import { cx, healthLabels, healthStyles } from '../lib/format'
import type { AppRunnerServiceState, LifecycleState, VMHealth } from '../types'

const toneSchema = z.enum(['neutral', 'info', 'success', 'warning', 'critical'])
const healthSchema = z.enum(['healthy', 'warning', 'critical', 'offline'])
const lifecycleSchema = z.enum(['running', 'stopped', 'suspended', 'provisioning'])
const tabSchema = z.enum(['overview', 'files', 'terminal', 'apprunner', 'activity', 'settings'])
const serviceStateSchema = z.enum(['running', 'degraded', 'stopped'])
const appRunnerStateSchema = z.enum(['running', 'degraded', 'stopped', 'unknown'])
const actionKindSchema = z.enum(['focus_vm', 'open_tab', 'ask_followup', 'request_fix'])

const metricSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  detail: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  tone: toneSchema.optional(),
})

const vmRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  health: healthSchema,
  lifecycle: lifecycleSchema,
  host: z.string().optional(),
  detail: z.string().optional(),
})

const alertSchema = z.object({
  vmId: z.string().optional(),
  vmName: z.string().optional(),
  severity: toneSchema.optional(),
  message: z.string(),
})

const serviceSchema = z.object({
  name: z.string(),
  state: serviceStateSchema,
  port: z.union([z.string(), z.number()]).optional(),
  cpuPercent: z.number().optional(),
  memoryMb: z.number().optional(),
  detail: z.string().optional(),
})

const processSchema = z.object({
  pid: z.union([z.string(), z.number()]),
  command: z.string(),
  user: z.string().optional(),
  cpuPercent: z.number().optional(),
  memoryMb: z.number().optional(),
})

const appRunnerSchema = z.object({
  name: z.string(),
  state: appRunnerStateSchema,
  port: z.union([z.string(), z.number()]).optional(),
  accessUrl: z.string().optional(),
  lastDeployStatus: z.string().optional(),
  detail: z.string().optional(),
})

const actionSchema = z.object({
  kind: actionKindSchema,
  label: z.string(),
  vmId: z.string().optional(),
  tab: tabSchema.optional(),
  message: z.string().optional(),
})

type BriefTone = z.infer<typeof toneSchema>
type Metric = z.infer<typeof metricSchema>
type VmRow = z.infer<typeof vmRowSchema>
type AlertEntry = z.infer<typeof alertSchema>
type ServiceRow = z.infer<typeof serviceSchema>
type ProcessRow = z.infer<typeof processSchema>
type AppRunnerRow = z.infer<typeof appRunnerSchema>
export type OperatorBriefAction = z.infer<typeof actionSchema>

const toneStyles: Record<BriefTone, string> = {
  neutral: 'border-slate-200 bg-white text-slate-700',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  critical: 'border-rose-200 bg-rose-50 text-rose-800',
}

const stateDotStyles: Record<ServiceRow['state'] | AppRunnerServiceState, string> = {
  running: 'bg-emerald-400',
  degraded: 'bg-amber-500',
  stopped: 'bg-slate-400',
  unknown: 'bg-slate-300',
}

function textValue(value: string | number | undefined) {
  return value === undefined ? '-' : String(value)
}

function toneClass(tone: BriefTone | undefined) {
  return toneStyles[tone ?? 'neutral']
}

function percentBarClass(tone: BriefTone | undefined) {
  if (tone === 'critical') {
    return 'bg-rose-500'
  }
  if (tone === 'warning') {
    return 'bg-amber-400'
  }
  if (tone === 'success') {
    return 'bg-emerald-500'
  }
  return 'bg-slate-700'
}

function MetricGridView({ items }: { items?: Metric[] }) {
  const metrics = items ?? []
  if (metrics.length === 0) {
    return null
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="openui-metric-grid">
      {metrics.map((metric, index) => (
        <section key={`${metric.label}-${index}`} className="rounded border border-slate-200 bg-white p-3">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="truncate text-xs font-medium text-slate-500">{metric.label}</span>
            <span className="text-sm font-semibold text-slate-950">{textValue(metric.value)}</span>
          </div>
          {typeof metric.percent === 'number' ? (
            <div className="mb-2 h-1 overflow-hidden rounded bg-slate-100">
              <span
                className={cx('block h-full rounded', percentBarClass(metric.tone))}
                style={{ width: `${Math.min(100, Math.max(0, metric.percent))}%` }}
              />
            </div>
          ) : null}
          {metric.detail ? <p className="truncate text-xs text-slate-500">{metric.detail}</p> : null}
        </section>
      ))}
    </div>
  )
}

function HealthPill({ health }: { health: VMHealth }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700">
      <span className={cx('h-2 w-2 rounded-full', healthStyles[health])} />
      {healthLabels[health]}
    </span>
  )
}

function StatePill({ state }: { state: ServiceRow['state'] | AppRunnerServiceState }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600">
      <span className={cx('h-2 w-2 rounded-full', stateDotStyles[state])} />
      {state}
    </span>
  )
}

function VmHealthTableView({ rows }: { rows?: VmRow[] }) {
  const vms = rows ?? []
  if (vms.length === 0) {
    return null
  }

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white" data-testid="openui-vm-table">
      <header className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        VMs
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] text-left text-xs">
          <thead className="border-b border-slate-100 text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">VM</th>
              <th className="px-3 py-2 font-medium">Health</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vms.map((vm) => (
              <tr key={vm.id}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{vm.name}</div>
                  <div className="font-mono text-[11px] text-slate-400">{vm.host ?? vm.id}</div>
                </td>
                <td className="px-3 py-2">
                  <HealthPill health={vm.health as VMHealth} />
                </td>
                <td className="px-3 py-2 text-slate-500">{vm.lifecycle as LifecycleState}</td>
                <td className="px-3 py-2 text-slate-500">{vm.detail ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AlertListView({ alerts }: { alerts?: AlertEntry[] }) {
  const entries = alerts ?? []
  if (entries.length === 0) {
    return null
  }

  return (
    <section className="rounded border border-slate-200 bg-white" data-testid="openui-alert-list">
      <header className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        Alerts
      </header>
      <div className="divide-y divide-slate-100">
        {entries.map((alert, index) => (
          <div key={`${alert.vmId ?? alert.vmName ?? 'alert'}-${index}`} className="flex gap-2 px-3 py-2 text-sm">
            <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', percentBarClass(alert.severity))} />
            <div className="min-w-0">
              {alert.vmName ? <div className="font-medium text-slate-800">{alert.vmName}</div> : null}
              <p className="break-words text-slate-600">{alert.message}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ServiceTableView({ rows }: { rows?: ServiceRow[] }) {
  const services = rows ?? []
  if (services.length === 0) {
    return null
  }

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white" data-testid="openui-service-table">
      <header className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        Services
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-xs">
          <thead className="border-b border-slate-100 text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Port</th>
              <th className="px-3 py-2 font-medium">Load</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {services.map((service) => (
              <tr key={service.name}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{service.name}</div>
                  {service.detail ? <div className="text-slate-500">{service.detail}</div> : null}
                </td>
                <td className="px-3 py-2">
                  <StatePill state={service.state} />
                </td>
                <td className="px-3 py-2 text-slate-500">{textValue(service.port)}</td>
                <td className="px-3 py-2 text-slate-500">
                  {service.cpuPercent ?? 0}% CPU / {service.memoryMb ?? 0} MB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ProcessListView({ rows }: { rows?: ProcessRow[] }) {
  const processes = rows ?? []
  if (processes.length === 0) {
    return null
  }

  return (
    <section className="rounded border border-slate-200 bg-white" data-testid="openui-process-list">
      <header className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        Processes
      </header>
      <div className="divide-y divide-slate-100">
        {processes.map((process) => (
          <div key={String(process.pid)} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs">
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-800">{process.command}</div>
              <div className="truncate font-mono text-[11px] text-slate-400">
                pid {process.pid} {process.user ? `/ ${process.user}` : ''}
              </div>
            </div>
            <div className="text-right text-slate-500">
              {process.cpuPercent ?? 0}% CPU
              <br />
              {process.memoryMb ?? 0} MB
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function AppRunnerTableView({ rows }: { rows?: AppRunnerRow[] }) {
  const services = rows ?? []
  if (services.length === 0) {
    return null
  }

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white" data-testid="openui-apprunner-table">
      <header className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        AppRunner
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[500px] text-left text-xs">
          <thead className="border-b border-slate-100 text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Port</th>
              <th className="px-3 py-2 font-medium">Deploy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {services.map((service) => (
              <tr key={service.name}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{service.name}</div>
                  {service.accessUrl ? <div className="truncate text-slate-500">{service.accessUrl}</div> : null}
                </td>
                <td className="px-3 py-2">
                  <StatePill state={service.state} />
                </td>
                <td className="px-3 py-2 text-slate-500">{textValue(service.port)}</td>
                <td className="px-3 py-2 text-slate-500">{service.lastDeployStatus ?? service.detail ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ActionButtons({ actions }: { actions?: OperatorBriefAction[] }) {
  const triggerAction = useTriggerAction()
  const disabled = useIsStreaming()
  const items = actions ?? []
  if (items.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2" data-testid="openui-action-bar">
      {items.map((action, index) => (
        <button
          key={`${action.kind}-${action.label}-${index}`}
          type="button"
          disabled={disabled}
          onClick={() => {
            void triggerAction(action.message ?? action.label, undefined, {
              type: action.kind,
              params: action,
            })
          }}
          className={cx(
            'h-8 rounded border px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
            action.kind === 'request_fix'
              ? 'border-amber-200 bg-white text-amber-800 hover:bg-amber-50'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
          )}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

const OperatorBrief = defineComponent({
  name: 'OperatorBrief',
  description: 'A compact Grove operator brief with optional metrics, fleet rows, alerts, runtime tables, and safe action buttons.',
  props: z.object({
    title: z.string(),
    scope: z.enum(['fleet', 'vm']).optional(),
    tone: toneSchema.optional(),
    summary: z.string().optional(),
    metrics: z.array(metricSchema).optional(),
    vms: z.array(vmRowSchema).optional(),
    alerts: z.array(alertSchema).optional(),
    services: z.array(serviceSchema).optional(),
    processes: z.array(processSchema).optional(),
    appServices: z.array(appRunnerSchema).optional(),
    actions: z.array(actionSchema).optional(),
  }),
  component: ({ props }) => {
    const { title, scope, tone, summary, metrics, vms, alerts, services, processes, appServices, actions } = props
    return (
      <article className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3" data-testid="openui-operator-brief">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="break-words text-sm font-semibold text-slate-950">{title}</h3>
              {scope ? (
                <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-500">
                  {scope}
                </span>
              ) : null}
            </div>
            {summary ? <p className="mt-1 break-words text-sm text-slate-600">{summary}</p> : null}
          </div>
          <span className={cx('rounded border px-2 py-1 text-[11px] font-medium capitalize', toneClass(tone))}>
            {tone ?? 'brief'}
          </span>
        </header>
        <MetricGridView items={metrics} />
        <VmHealthTableView rows={vms} />
        <AlertListView alerts={alerts} />
        <ServiceTableView rows={services} />
        <ProcessListView rows={processes} />
        <AppRunnerTableView rows={appServices} />
        <ActionButtons actions={actions} />
      </article>
    )
  },
})

const MetricGrid = defineComponent({
  name: 'MetricGrid',
  description: 'Grid of compact operational metrics.',
  props: z.object({ items: z.array(metricSchema) }),
  component: ({ props }) => <MetricGridView items={props.items} />,
})

const VmHealthTable = defineComponent({
  name: 'VmHealthTable',
  description: 'Fleet table showing VM health, lifecycle, and short operational details.',
  props: z.object({ rows: z.array(vmRowSchema) }),
  component: ({ props }) => <VmHealthTableView rows={props.rows} />,
})

const AlertList = defineComponent({
  name: 'AlertList',
  description: 'List of alerts or notable findings grouped by VM when available.',
  props: z.object({ alerts: z.array(alertSchema) }),
  component: ({ props }) => <AlertListView alerts={props.alerts} />,
})

const ServiceTable = defineComponent({
  name: 'ServiceTable',
  description: 'Service status table for a VM diagnosis brief.',
  props: z.object({ services: z.array(serviceSchema) }),
  component: ({ props }) => <ServiceTableView rows={props.services} />,
})

const ProcessList = defineComponent({
  name: 'ProcessList',
  description: 'List of top processes with CPU and memory hints.',
  props: z.object({ processes: z.array(processSchema) }),
  component: ({ props }) => <ProcessListView rows={props.processes} />,
})

const AppRunnerTable = defineComponent({
  name: 'AppRunnerTable',
  description: 'AppRunner service health and last deployment status.',
  props: z.object({ services: z.array(appRunnerSchema) }),
  component: ({ props }) => <AppRunnerTableView rows={props.services} />,
})

const ActionBar = defineComponent({
  name: 'ActionBar',
  description: 'Safe Grove navigation, follow-up, or request-fix buttons. Never executes mutating work directly.',
  props: z.object({ actions: z.array(actionSchema) }),
  component: ({ props }) => <ActionButtons actions={props.actions} />,
})

export const operatorBriefLibrary = createLibrary({
  root: 'OperatorBrief',
  components: [OperatorBrief, MetricGrid, VmHealthTable, AlertList, ServiceTable, ProcessList, AppRunnerTable, ActionBar],
})
