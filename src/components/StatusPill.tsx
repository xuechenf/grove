import { cx, healthLabels, healthStyles } from '../lib/format'
import type { VMHealth } from '../types'

interface StatusPillProps {
  status: VMHealth
  compact?: boolean
}

export function StatusPill({ status, compact = false }: StatusPillProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700',
        compact && 'border-0 bg-transparent px-0 py-0',
      )}
    >
      <span className={cx('h-2 w-2 rounded-full', healthStyles[status])} />
      {healthLabels[status]}
    </span>
  )
}
