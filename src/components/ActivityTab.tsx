import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from 'lucide-react'
import type { ActivityEvent, TransferJob, VM } from '../types'

interface ActivityTabProps {
  vm: VM
  transfers: TransferJob[]
}

function iconForActivity(severity: ActivityEvent['severity']) {
  if (severity === 'success') {
    return <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
  }

  if (severity === 'warning') {
    return <TriangleAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />
  }

  if (severity === 'critical') {
    return <CircleX className="h-4 w-4 text-rose-500" aria-hidden="true" />
  }

  return <CircleDashed className="h-4 w-4 text-slate-400" aria-hidden="true" />
}

export function ActivityTab({ vm, transfers }: ActivityTabProps) {
  const relatedTransfers = transfers.filter((job) => job.vmId === vm.id)

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]" data-testid="activity-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-950">Activity stream</h2>
          <p className="text-xs text-slate-500">Control actions, health checks, and copilot executions</p>
        </header>
        <div className="divide-y divide-slate-100">
          {vm.activity.map((event) => (
            <article key={event.id} className="grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-3">
              <span className="mt-0.5">{iconForActivity(event.severity)}</span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-800">{event.title}</h3>
                <p className="text-sm text-slate-500">{event.detail}</p>
              </div>
              <time className="text-xs text-slate-400">{event.timestamp}</time>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-950">Transfer history</h2>
          <p className="text-xs text-slate-500">Jobs scoped to {vm.name}</p>
        </header>
        <div className="divide-y divide-slate-100">
          {relatedTransfers.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">No transfer jobs for this VM yet.</p>
          ) : (
            relatedTransfers.map((job) => (
              <article key={job.id} className="px-3 py-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-800">{job.fileName}</h3>
                  <span className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500">{job.status}</span>
                </div>
                <p className="truncate text-xs text-slate-500">{job.source}</p>
                <p className="truncate text-xs text-slate-500">{job.target}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
