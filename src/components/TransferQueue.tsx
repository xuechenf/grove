import * as Progress from '@radix-ui/react-progress'
import { ArrowDownToLine, ArrowUpFromLine, Copy, XCircle } from 'lucide-react'
import { cx, transferLabels } from '../lib/format'
import type { TransferJob, VM } from '../types'

interface TransferQueueProps {
  transfers: TransferJob[]
  vms: VM[]
}

function iconForDirection(direction: TransferJob['direction']) {
  if (direction === 'upload') {
    return <ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />
  }

  if (direction === 'download') {
    return <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
  }

  return <Copy className="h-4 w-4" aria-hidden="true" />
}

export function TransferQueue({ transfers, vms }: TransferQueueProps) {
  if (transfers.length === 0) {
    return null
  }

  return (
    <aside className="border-t border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">Transfer queue</h2>
          <p className="text-xs text-slate-500">Uploads, downloads, conflicts, and recent history</p>
        </div>
        <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{transfers.length} jobs</span>
      </div>
      <div className="grid max-h-40 gap-2 overflow-auto p-3 md:grid-cols-2 xl:grid-cols-3">
        {transfers.map((job) => {
          const vm = vms.find((item) => item.id === job.vmId)
          const failed = job.status === 'failed' || job.status === 'conflict'
          return (
            <div key={job.id} className="rounded border border-slate-200 bg-white p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-700">
                  <span className={cx('text-slate-500', failed && 'text-rose-500')}>{iconForDirection(job.direction)}</span>
                  <span className="truncate">{job.fileName}</span>
                </span>
                {failed ? <XCircle className="h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" /> : null}
              </div>
              <Progress.Root className="h-1 overflow-hidden rounded bg-slate-100" value={job.progress}>
                <Progress.Indicator
                  className={cx('h-full rounded', failed ? 'bg-rose-500' : 'bg-slate-700')}
                  style={{ transform: `translateX(-${100 - job.progress}%)` }}
                />
              </Progress.Root>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span className="truncate">{vm?.name ?? 'unknown VM'}</span>
                <span>{transferLabels[job.status]}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-slate-400">{job.speed}</div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
