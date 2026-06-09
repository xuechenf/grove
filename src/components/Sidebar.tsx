import { Plus } from 'lucide-react'
import { cx } from '../lib/format'
import type { VM } from '../types'

interface SidebarProps {
  vms: VM[]
  selectedVmId?: string
  onSelect: (vmId: string) => void
  onAddVm: () => void
}

function GroveMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M9 18c0-5.8 4.7-10.5 10.5-10.5H24v4.5C24 17.8 19.8 22 14 22H9v-4Z"
        fill="#d1fae5"
        stroke="#047857"
        strokeWidth="1.8"
      />
      <path d="M10 22c4.4-4.7 8.3-7.6 13-9" stroke="#047857" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M10 22v5h13" stroke="#94a3b8" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

export function Sidebar({ vms, selectedVmId, onSelect, onAddVm }: SidebarProps) {
  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-slate-200 bg-white text-slate-900 lg:w-72 lg:flex-none">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white">
            <GroveMark />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-normal text-slate-950">Grove</h1>
            <p className="truncate text-xs text-slate-500">Local VM console</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
        <div className="mb-2 flex items-center justify-between gap-2 px-2">
          <div className="text-[11px] font-medium uppercase text-slate-500">
            Inventory {vms.length}
          </div>
          <button
            type="button"
            onClick={onAddVm}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add VM
          </button>
        </div>
        <div className="space-y-1">
          {vms.map((vm) => (
            <button
              key={vm.id}
              type="button"
              onClick={() => onSelect(vm.id)}
              className={cx(
                'w-full rounded border p-3 text-left transition',
                selectedVmId === vm.id
                  ? 'border-slate-300 bg-slate-50'
                  : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-slate-900">{vm.name}</span>
              </div>
              <div className="truncate text-xs text-slate-500">{vm.ipAddress}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
