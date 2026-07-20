import { Boxes, ExternalLink, FolderOpen, ServerCog } from 'lucide-react'
import { cx } from '../lib/format'
import type { GroveApplication, VM } from '../types'

interface VmApplicationsTabProps {
  vm: VM
  applications: GroveApplication[]
  onOpenApplication: (applicationId: string) => void
}

const statusTone: Record<string, string> = {
  healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  degraded: 'border-amber-200 bg-amber-50 text-amber-700',
  uploading: 'border-blue-200 bg-blue-50 text-blue-700',
  deploying: 'border-blue-200 bg-blue-50 text-blue-700',
  stopped: 'border-slate-200 bg-slate-50 text-slate-600',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
  failed: 'border-rose-200 bg-rose-50 text-rose-700',
}

function versionLabel(application: GroveApplication, versionId?: string) {
  if (!versionId) return '—'
  const version = application.versions.find((candidate) => candidate.id === versionId)
  return version ? `v${version.sequence}` : versionId
}

function formatDate(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

export function VmApplicationsTab({ vm, applications, onOpenApplication }: VmApplicationsTabProps) {
  const deployments = applications.flatMap((application) => {
    const instance = application.instances.find((candidate) => candidate.vmId === vm.id)
    return instance ? [{ application, instance }] : []
  })

  return (
    <div className="space-y-3" data-testid="vm-applications-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div className="flex items-center gap-2"><Boxes className="h-4 w-4 text-slate-500" aria-hidden="true" /><div><h2 className="text-sm font-semibold text-slate-950">Deployed applications</h2><p className="text-xs text-slate-500">Runtime projection for {vm.name}; source, builds, and multi-VM deployment stay in Applications.</p></div></div>
          <span className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500">{deployments.length} deployed</span>
        </header>
        {deployments.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="border-b border-slate-100 text-[11px] uppercase text-slate-500"><tr><th className="px-3 py-2 font-medium">Application</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Current</th><th className="px-3 py-2 font-medium">Desired</th><th className="px-3 py-2 font-medium">Runtime</th><th className="px-3 py-2 font-medium">Remote workspace</th><th className="px-3 py-2 font-medium">Updated</th><th className="px-3 py-2 font-medium">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{deployments.map(({ application, instance }) => <tr key={application.id}><td className="px-3 py-2"><strong className="block text-slate-800">{application.name}</strong><span className="block text-xs text-slate-500">{application.description || application.slug}</span></td><td className="px-3 py-2"><span className={cx('rounded border px-2 py-1 text-xs capitalize', statusTone[instance.status] ?? statusTone.unknown)}>{instance.status}</span></td><td className="px-3 py-2 font-medium text-slate-700">{versionLabel(application, instance.versionId)}</td><td className="px-3 py-2 text-slate-500">{versionLabel(application, instance.desiredVersionId)}</td><td className="px-3 py-2"><span className="flex items-center gap-1.5 text-slate-600"><ServerCog className="h-3.5 w-3.5" />{instance.unitName}</span><span className="mt-0.5 block text-xs text-slate-500">port {application.configuration.port}</span></td><td className="px-3 py-2"><span className="flex items-center gap-1.5 font-mono text-xs text-slate-500"><FolderOpen className="h-3.5 w-3.5" />{instance.remotePath}</span></td><td className="px-3 py-2 text-xs text-slate-500">{formatDate(instance.updatedAt)}</td><td className="px-3 py-2"><button type="button" onClick={() => onOpenApplication(application.id)} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Manage<ExternalLink className="h-3.5 w-3.5" /></button></td></tr>)}</tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 py-10 text-center"><span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500"><Boxes className="h-4 w-4" /></span><h3 className="mt-3 text-sm font-semibold text-slate-900">No applications deployed</h3><p className="mt-1 text-sm text-slate-500">Build an immutable version in Applications, then deploy it to {vm.name}.</p></div>
        )}
      </section>
    </div>
  )
}
