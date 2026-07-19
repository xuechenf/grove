import {
  Boxes,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Server,
  Settings,
} from 'lucide-react'
import { useState } from 'react'
import { cx } from '../lib/format'
import type { CopilotScope, GroveApplication, VM } from '../types'
import { vmScope } from '../types'
import { IconButton } from './IconButton'

export type OperationalSection = 'virtual-machines' | 'applications'

interface SidebarProps {
  vms: VM[]
  applications: GroveApplication[]
  activeSection: OperationalSection
  activeScope: CopilotScope
  selectedApplicationId?: string
  onSelectSection: (section: OperationalSection) => void
  onSelectScope: (scope: CopilotScope) => void
  onSelectApplication: (applicationId: string) => void
  busyScopes: Set<string>
  attentionScopes: Set<string>
  onAddVm: () => void
  onAddApplication: () => void
  onOpenSettings: () => void
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

function initials(name: string) {
  const value = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return value || name.slice(0, 2).toUpperCase()
}

const healthDot: Record<VM['health'] | GroveApplication['health'], string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-rose-500',
  offline: 'bg-slate-300',
  degraded: 'bg-amber-500',
  failed: 'bg-rose-500',
  unknown: 'bg-slate-300',
  not_deployed: 'bg-slate-300',
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

export function Sidebar({
  vms,
  applications,
  activeSection,
  activeScope,
  selectedApplicationId,
  onSelectSection,
  onSelectScope,
  onSelectApplication,
  busyScopes,
  attentionScopes,
  onAddVm,
  onAddApplication,
  onOpenSettings,
}: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const running = vms.filter((vm) => vm.lifecycle === 'running').length
  const healthyApps = applications.filter((application) => application.health === 'healthy').length
  const fleetActive = activeScope === 'fleet'

  function selectSection(section: OperationalSection) {
    onSelectSection(section)
    if (section === 'virtual-machines' && !activeScope) {
      onSelectScope('fleet')
    }
  }

  return (
    <aside
      className={cx(
        'flex max-h-[48svh] min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-white text-slate-900 transition-[width] duration-200 lg:max-h-none lg:flex-none',
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
            <p className="truncate text-xs text-slate-500">Local application platform</p>
          </div>
          <IconButton
            label={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-controls="grove-navigation-context"
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

      <nav className={cx('grid gap-1 border-b border-slate-200 p-2', isCollapsed && 'lg:px-1')} aria-label="Grove sections">
        <button
          type="button"
          aria-pressed={activeSection === 'virtual-machines'}
          title="Virtual Machines"
          onClick={() => selectSection('virtual-machines')}
          className={cx(
            'flex h-10 items-center gap-3 rounded px-3 text-left text-sm font-medium transition',
            isCollapsed && 'lg:justify-center lg:px-0',
            activeSection === 'virtual-machines'
              ? 'bg-slate-950 text-white'
              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950',
          )}
        >
          <Server className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className={cx('min-w-0 flex-1 truncate', isCollapsed && 'lg:hidden')}>Virtual Machines</span>
          <span className={cx('text-xs opacity-70', isCollapsed && 'lg:hidden')}>{vms.length}</span>
        </button>
        <button
          type="button"
          aria-pressed={activeSection === 'applications'}
          title="Applications"
          onClick={() => selectSection('applications')}
          className={cx(
            'flex h-10 items-center gap-3 rounded px-3 text-left text-sm font-medium transition',
            isCollapsed && 'lg:justify-center lg:px-0',
            activeSection === 'applications'
              ? 'bg-slate-950 text-white'
              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950',
          )}
        >
          <Boxes className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className={cx('min-w-0 flex-1 truncate', isCollapsed && 'lg:hidden')}>Applications</span>
          <span className={cx('text-xs opacity-70', isCollapsed && 'lg:hidden')}>{applications.length}</span>
        </button>
      </nav>

      <div id="grove-navigation-context" className={cx('min-h-0 flex-1 overflow-auto px-2 py-3', isCollapsed && 'lg:px-1')}>
        {activeSection === 'virtual-machines' ? (
          <>
            <button
              type="button"
              aria-label="All VMs"
              aria-pressed={fleetActive}
              title="All virtual machines"
              onClick={() => onSelectScope('fleet')}
              className={cx(
                'mb-2 flex w-full items-center gap-2 rounded border p-3 text-left transition',
                isCollapsed && 'lg:h-10 lg:justify-center lg:p-0',
                fleetActive ? 'border-slate-300 bg-slate-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
              )}
            >
              <Server className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />
              <div className={cx('min-w-0 flex-1', isCollapsed && 'lg:hidden')}>
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">All virtual machines</span>
                  <Markers busy={busyScopes.has('fleet')} attention={attentionScopes.has('fleet')} />
                </div>
                <div className="truncate text-xs text-slate-500">{running} running · {vms.length} total</div>
              </div>
            </button>

            <ContextHeader
              title={`Inventory ${vms.length}`}
              actionLabel="Add VM"
              collapsed={isCollapsed}
              onAction={onAddVm}
            />
            <div className="space-y-1">
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
                      {initials(vm.name)}
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
          </>
        ) : (
          <>
            <div className={cx('mb-3 rounded border border-slate-200 bg-slate-50 p-3', isCollapsed && 'lg:hidden')}>
              <div className="text-sm font-semibold text-slate-900">Application workspace</div>
              <div className="mt-1 text-xs text-slate-500">{healthyApps} healthy · {applications.length} total</div>
            </div>
            <ContextHeader
              title={`Applications ${applications.length}`}
              actionLabel="New app"
              collapsed={isCollapsed}
              onAction={onAddApplication}
            />
            <div className="space-y-1">
              {applications.map((application) => {
                const isActive = selectedApplicationId === application.id
                const healthyInstances = application.instances.filter((instance) => instance.status === 'healthy').length
                return (
                  <button
                    key={application.id}
                    type="button"
                    aria-label={`Select ${application.name}`}
                    aria-pressed={isActive}
                    title={application.name}
                    onClick={() => onSelectApplication(application.id)}
                    className={cx(
                      'w-full rounded border p-3 text-left transition',
                      isCollapsed && 'lg:flex lg:h-10 lg:items-center lg:justify-center lg:p-0',
                      isActive ? 'border-slate-300 bg-slate-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
                    )}
                  >
                    <span className={cx('hidden text-xs font-semibold text-slate-700', isCollapsed && 'lg:inline')}>
                      {initials(application.name)}
                    </span>
                    <div className={cx(isCollapsed && 'lg:hidden')}>
                      <div className="mb-2 flex items-center gap-2">
                        <span className={cx('h-2 w-2 shrink-0 rounded-full', healthDot[application.health])} aria-hidden="true" />
                        <span className="truncate text-sm font-semibold text-slate-900">{application.name}</span>
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {application.instances.length ? `${healthyInstances}/${application.instances.length} VMs healthy` : 'Not deployed'}
                      </div>
                    </div>
                  </button>
                )
              })}
              {applications.length === 0 ? (
                <div className={cx('rounded border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500', isCollapsed && 'lg:hidden')}>
                  Create an application to build and deploy local source.
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className={cx('border-t border-slate-200 p-2', isCollapsed && 'lg:px-1')}>
        <button
          type="button"
          aria-label="Open Grove settings"
          title="Settings"
          onClick={onOpenSettings}
          className={cx(
            'flex h-10 w-full items-center gap-3 rounded px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-950',
            isCollapsed && 'lg:justify-center lg:px-0',
          )}
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className={cx(isCollapsed && 'lg:hidden')}>Settings</span>
        </button>
      </div>
    </aside>
  )
}

function ContextHeader({
  title,
  actionLabel,
  collapsed,
  onAction,
}: {
  title: string
  actionLabel: string
  collapsed: boolean
  onAction: () => void
}) {
  return (
    <div className={cx('mb-2 flex items-center justify-between gap-2 px-2', collapsed && 'lg:justify-center lg:px-0')}>
      <div className={cx('text-[11px] font-medium uppercase text-slate-500', collapsed && 'lg:hidden')}>{title}</div>
      <button
        type="button"
        aria-label={actionLabel}
        onClick={onAction}
        className={cx(
          'inline-flex h-7 items-center gap-1.5 rounded border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50',
          collapsed && 'lg:h-8 lg:w-8 lg:justify-center lg:px-0',
        )}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        <span className={cx(collapsed && 'lg:hidden')}>{actionLabel}</span>
      </button>
    </div>
  )
}
