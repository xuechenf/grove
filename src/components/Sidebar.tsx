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
      <circle cx="10.5" cy="13" r="6.5" fill="#34d399" />
      <circle cx="17" cy="10.5" r="7.5" fill="#86efac" />
      <circle cx="22.5" cy="15" r="6" fill="#22c55e" />
      <path fill="#14532d" d="M8 17c2.2 2.2 5.4 3.3 9 3.3s6.8-1.1 9-3.3c-.5 6.3-4.3 10.5-9 10.5S8.5 23.3 8 17Z" />
      <path stroke="#ecfccb" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M16 15v12m0-6-4.8-3.7M16 21l5.3-4.8" />
      <path stroke="#a7f3d0" strokeLinecap="round" strokeWidth="1.8" d="M8.5 27h15" />
    </svg>
  )
}

export function Sidebar({ vms, selectedVmId, onSelect, onAddVm }: SidebarProps) {
  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-slate-200 bg-slate-950 text-slate-100 lg:w-72 lg:flex-none">
      <div className="border-b border-slate-800 px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded border border-emerald-300/40 bg-emerald-950">
            <GroveMark />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-normal text-white">Grove</h1>
            <p className="truncate text-xs text-slate-400">Local VM console</p>
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
            className="inline-flex h-7 items-center gap-1.5 rounded border border-cyan-400/50 bg-cyan-400/10 px-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-400/20"
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
                  ? 'border-cyan-300 bg-slate-900 shadow-[inset_3px_0_0_#67e8f9]'
                  : 'border-transparent hover:border-slate-700 hover:bg-slate-900',
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-white">{vm.name}</span>
              </div>
              <div className="truncate text-xs text-slate-400">{vm.ipAddress}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
