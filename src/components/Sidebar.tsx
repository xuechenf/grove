import { Layers, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { cx } from '../lib/format'
import type { CopilotScope, VM } from '../types'
import { vmScope } from '../types'
import { IconButton } from './IconButton'

interface SidebarProps {
  vms: VM[]
  activeScope: CopilotScope
  onSelectScope: (scope: CopilotScope) => void
  busyScopes: Set<string>
  attentionScopes: Set<string>
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

function vmInitials(name: string) {
  const initials = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return initials || name.slice(0, 2).toUpperCase()
}

const healthDot: Record<VM['health'], string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-rose-500',
  offline: 'bg-slate-300',
}

function Markers({ busy, attention }: { busy: boolean; attention: boolean }) {
  return (
    <span className="ml-auto flex items-center gap-1.5">
      {attention ? (
        <span className="h-2 w-2 rounded-full bg-amber-500" title="Waiting for your confirmation" aria-hidden="true" />
      ) : null}
      {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden="true" /> : null}
    </span>
  )
}

export function Sidebar({ vms, activeScope, onSelectScope, busyScopes, attentionScopes, onAddVm }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const running = vms.filter((vm) => vm.lifecycle === 'running').length
  const warning = vms.filter((vm) => vm.health === 'warning' || vm.health === 'critical').length
  const fleetActive = activeScope === 'fleet'

  return (
    <aside
      className={cx(
        'flex max-h-[42svh] min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-white text-slate-900 transition-[width] duration-200 lg:max-h-none lg:flex-none',
        isCollapsed ? 'lg:w-16' : 'lg:w-72',
      )}
    >
      <div className={cx('border-b border-slate-200 px-4 py-4', isCollapsed && 'lg:px-2')}>
        <div className={cx('flex items-center gap-2', isCollapsed && 'lg:flex-col lg:justify-center')}>
          <span className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white">
            <GroveMark />
          </span>
          <div className={cx('min-w-0 flex-1', isCollapsed && 'lg:hidden')}>
            <h1 className="truncate text-sm font-semibold tracking-normal text-slate-950">Grove</h1>
            <p className="truncate text-xs text-slate-500">Local VM console</p>
          </div>
          <IconButton
            label={isCollapsed ? 'Expand inventory' : 'Collapse inventory'}
            aria-controls="vm-inventory-list"
            aria-expanded={!isCollapsed}
            onClick={() => setIsCollapsed((current) => !current)}
            className={cx('ml-auto hidden lg:inline-flex', isCollapsed && 'lg:ml-0')}
          >
            {isCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            )}
          </IconButton>
        </div>
      </div>

      <div className={cx('min-h-0 flex-1 overflow-auto px-2 py-3', isCollapsed && 'lg:px-1')}>
        <button
          type="button"
          aria-label="All VMs"
          aria-pressed={fleetActive}
          title="All VMs"
          onClick={() => onSelectScope('fleet')}
          className={cx(
            'mb-2 flex w-full items-center gap-2 rounded border p-3 text-left transition',
            isCollapsed && 'lg:h-10 lg:justify-center lg:p-0',
            fleetActive ? 'border-slate-300 bg-slate-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
          )}
        >
          <Layers className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />
          <div className={cx('min-w-0 flex-1', isCollapsed && 'lg:hidden')}>
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-slate-900">All VMs</span>
              <Markers busy={busyScopes.has('fleet')} attention={attentionScopes.has('fleet')} />
            </div>
            <div className="truncate text-xs text-slate-500">
              {running} running{warning ? ` · ${warning} need attention` : ''}
            </div>
          </div>
        </button>

        <div className={cx('mb-2 flex items-center justify-between gap-2 px-2', isCollapsed && 'lg:justify-center lg:px-0')}>
          <div className={cx('text-[11px] font-medium uppercase text-slate-500', isCollapsed && 'lg:hidden')}>
            Inventory {vms.length}
          </div>
          <button
            type="button"
            aria-label="Add VM"
            onClick={onAddVm}
            className={cx(
              'inline-flex h-7 items-center gap-1.5 rounded border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50',
              isCollapsed && 'lg:h-8 lg:w-8 lg:justify-center lg:px-0',
            )}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={cx(isCollapsed && 'lg:hidden')}>Add VM</span>
          </button>
        </div>
        <div id="vm-inventory-list" className="space-y-1">
          {vms.map((vm) => {
            const scope = vmScope(vm.id)
            const isActive = activeScope === scope
            return (
              <button
                key={vm.id}
                type="button"
                aria-label={`Select ${vm.name}`}
                aria-pressed={isActive}
                title={vm.name}
                onClick={() => onSelectScope(scope)}
                className={cx(
                  'w-full rounded border p-3 text-left transition',
                  isCollapsed && 'lg:flex lg:h-10 lg:items-center lg:justify-center lg:p-0',
                  isActive ? 'border-slate-300 bg-slate-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
                )}
              >
                <span className={cx('hidden text-xs font-semibold text-slate-700', isCollapsed && 'lg:inline')}>
                  {vmInitials(vm.name)}
                </span>
                <div className={cx(isCollapsed && 'lg:hidden')}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className={cx('h-2 w-2 shrink-0 rounded-full', healthDot[vm.health])} aria-hidden="true" />
                    <span className="truncate text-sm font-semibold text-slate-900">{vm.name}</span>
                    <Markers busy={busyScopes.has(scope)} attention={attentionScopes.has(scope)} />
                  </div>
                  <div className="truncate text-xs text-slate-500">{vm.ipAddress}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
