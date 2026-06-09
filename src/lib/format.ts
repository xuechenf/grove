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
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-rose-500',
  offline: 'bg-slate-400',
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
  safe: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
  caution: 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
  destructive: 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100',
}
