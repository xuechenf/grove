import type { DangerLevel, TransferStatus, VMHealth } from '../types'

export function formatBytes(value: number) {
  if (value === 0) {
    return '-'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export const healthStyles: Record<VMHealth, string> = {
  healthy: 'bg-emerald-400',
  warning: 'bg-amber-400',
  critical: 'bg-rose-500',
  offline: 'bg-slate-300',
}

export const healthLabels: Record<VMHealth, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  offline: 'Offline',
}

export const transferLabels: Record<TransferStatus, string> = {
  queued: 'Queued',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  conflict: 'Conflict',
}

export const dangerButtonStyles: Record<DangerLevel, string> = {
  safe: 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
  caution: 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50',
  destructive: 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50',
}
