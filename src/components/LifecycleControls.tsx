import {
  CopyPlus,
  Pause,
  Play,
  Power,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react'
import { dangerButtonStyles } from '../lib/format'
import type { LifecycleState, VMAction } from '../types'

interface LifecycleControlsProps {
  lifecycle: LifecycleState
  actions: VMAction[]
  onAction: (action: VMAction) => void
}

function iconForAction(actionId: VMAction['id']) {
  const icons = {
    start: <Play className="h-3.5 w-3.5" aria-hidden="true" />,
    stop: <Square className="h-3.5 w-3.5" aria-hidden="true" />,
    suspend: <Pause className="h-3.5 w-3.5" aria-hidden="true" />,
    reboot: <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />,
    snapshot: <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />,
    clone: <CopyPlus className="h-3.5 w-3.5" aria-hidden="true" />,
    delete: <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />,
  }

  return icons[actionId]
}

function isDisabled(action: VMAction, lifecycle: LifecycleState) {
  if (action.id === 'start') {
    return lifecycle === 'running' || lifecycle === 'provisioning'
  }

  if (['stop', 'suspend', 'reboot', 'snapshot', 'clone'].includes(action.id)) {
    return lifecycle === 'stopped' || lifecycle === 'provisioning'
  }

  return false
}

export function LifecycleControls({ lifecycle, actions, onAction }: LifecycleControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600">
        <Power className="h-3.5 w-3.5" aria-hidden="true" />
        {lifecycle}
      </span>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-label={`${action.label} selected VM`}
          disabled={isDisabled(action, lifecycle)}
          onClick={() => onAction(action)}
          className={`inline-flex h-8 items-center gap-2 rounded border px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${dangerButtonStyles[action.danger]}`}
        >
          {iconForAction(action.id)}
          {action.label}
        </button>
      ))}
    </div>
  )
}
