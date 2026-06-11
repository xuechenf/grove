import * as Progress from '@radix-ui/react-progress'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

export type MetricTileTone = 'normal' | 'warning' | 'critical' | 'info'

interface MetricTileProps {
  label: string
  value: string
  detail: string
  percent?: number
  tone?: MetricTileTone
  icon: ReactNode
}

const toneStyles = {
  normal: 'bg-slate-700',
  warning: 'bg-amber-400',
  critical: 'bg-rose-500',
  info: 'bg-slate-500',
}

export function MetricTile({ label, value, detail, percent, tone = 'normal', icon }: MetricTileProps) {
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
