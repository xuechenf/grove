import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleDashed, CircleX, ListFilter, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { cx } from '../lib/format'
import type { ActivityEvent, TransferJob, VM } from '../types'

interface ActivityTabProps { vm: VM; transfers: TransferJob[] }
type ActivityFilter = 'all' | 'operations' | 'transfers'

function iconForActivity(severity: ActivityEvent['severity']) {
  if (severity === 'success') return <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
  if (severity === 'warning') return <TriangleAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />
  if (severity === 'critical') return <CircleX className="h-4 w-4 text-rose-500" aria-hidden="true" />
  return <CircleDashed className="h-4 w-4 text-slate-400" aria-hidden="true" />
}

export function ActivityTab({ vm, transfers }: ActivityTabProps) {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const relatedTransfers = transfers.filter((job) => job.vmId === vm.id)

  return (
    <section className="rounded border border-slate-200 bg-white" data-testid="activity-tab">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div><h2 className="text-sm font-semibold text-slate-950">Activity</h2><p className="text-xs text-slate-500">VM controls, health checks, deployments, Copilot runs, and file transfers</p></div><div className="flex items-center gap-1"><ListFilter className="mr-1 h-3.5 w-3.5 text-slate-400" />{(['all', 'operations', 'transfers'] as ActivityFilter[]).map((value) => <button key={value} type="button" onClick={() => setFilter(value)} className={cx('h-7 rounded px-2 text-xs capitalize', filter === value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}>{value}</button>)}</div></header>
      {(filter === 'all' || filter === 'operations') ? <div className="divide-y divide-slate-100">{vm.activity.length ? vm.activity.map((event) => <article key={event.id} className="grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-3"><span className="mt-0.5">{iconForActivity(event.severity)}</span><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-800">{event.title}</h3><p className="text-sm text-slate-500">{event.detail}</p></div><time className="text-xs text-slate-400">{event.timestamp}</time></article>) : <p className="px-3 py-4 text-sm text-slate-500">No operational events for this VM yet.</p>}</div> : null}
      {(filter === 'all' || filter === 'transfers') && relatedTransfers.length ? <div className="border-t border-slate-200"><div className="bg-slate-50 px-3 py-1.5 text-[11px] font-medium uppercase text-slate-500">File transfers</div><div className="divide-y divide-slate-100">{relatedTransfers.map((job) => <article key={job.id} className="grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-3"><span className="mt-0.5">{job.direction === 'download' ? <ArrowDownToLine className="h-4 w-4 text-blue-600" /> : <ArrowUpFromLine className="h-4 w-4 text-violet-600" />}</span><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-800">{job.fileName}</h3><p className="truncate text-xs text-slate-500">{job.source} → {job.target}</p></div><span className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500">{job.status}</span></article>)}</div></div> : null}
      {filter === 'transfers' && relatedTransfers.length === 0 ? <p className="px-3 py-4 text-sm text-slate-500">No transfer jobs for this VM yet.</p> : null}
    </section>
  )
}
