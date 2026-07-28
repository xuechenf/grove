import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Clock3,
  Code2,
  FileClock,
  FileText,
  Globe2,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  Server,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { cx } from '../lib/format'
import type {
  ApplicationDeployment,
  ApplicationDeploymentTargetStatus,
  ApplicationInstanceStatus,
  ApplicationVersionStatus,
  ApplicationEnvironmentInput,
  ApplicationDomainInput,
  CredentialProfile,
  GroveApplication,
  VM,
  TerraformRuntimeStatus,
} from '../types'
import { EnvironmentsPanel } from './EnvironmentsPanel'
import { IconButton } from './IconButton'

type ApplicationTab = 'overview' | 'configuration' | 'domain' | 'environments' | 'deployments' | 'versions' | 'vms' | 'logs'

interface ApplicationsWorkspaceProps {
  application?: GroveApplication
  vms: VM[]
  credentialProfiles: CredentialProfile[]
  terraform: TerraformRuntimeStatus
  onInstallTerraform: () => Promise<void>
  onCreate: () => void
  onEdit: () => void
  onSync: () => Promise<void>
  onBuild: () => Promise<void>
  onDeploy: (versionId: string, vmIds: string[], environment: string) => Promise<void>
  onLoadLogs: (vmId: string) => Promise<string[]>
  onOpenVm: (vmId: string) => void
  onSaveDomain: (input: ApplicationDomainInput) => Promise<void>
  onRemoveDomain: () => Promise<void>
  onCreateEnvironment: (input: ApplicationEnvironmentInput) => Promise<void>
  onPlanEnvironment: (environmentId: string, destroy: boolean) => Promise<void>
  onApplyEnvironment: (environmentId: string, planOperationId: string) => Promise<void>
}

const applicationTabs: Array<{ value: ApplicationTab; label: string; icon: typeof Activity }> = [
  { value: 'overview', label: 'Overview', icon: Activity },
  { value: 'configuration', label: 'Configuration', icon: Settings2 },
  { value: 'domain', label: 'Domain', icon: Globe2 },
  { value: 'environments', label: 'Environments', icon: Cloud },
  { value: 'deployments', label: 'Deployments', icon: Rocket },
  { value: 'versions', label: 'Versions', icon: FileClock },
  { value: 'vms', label: 'Deployed VMs', icon: Server },
  { value: 'logs', label: 'Logs', icon: FileText },
]

const statusClasses: Record<string, string> = {
  healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  succeeded: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  degraded: 'border-amber-200 bg-amber-50 text-amber-700',
  partial: 'border-amber-200 bg-amber-50 text-amber-700',
  building: 'border-blue-200 bg-blue-50 text-blue-700',
  running: 'border-blue-200 bg-blue-50 text-blue-700',
  deploying: 'border-blue-200 bg-blue-50 text-blue-700',
  uploading: 'border-blue-200 bg-blue-50 text-blue-700',
  queued: 'border-slate-200 bg-slate-50 text-slate-600',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
  not_deployed: 'border-slate-200 bg-slate-50 text-slate-600',
  stopped: 'border-slate-200 bg-slate-50 text-slate-600',
  failed: 'border-rose-200 bg-rose-50 text-rose-700',
  rolled_back: 'border-rose-200 bg-rose-50 text-rose-700',
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  pending: 'border-blue-200 bg-blue-50 text-blue-700',
}

export function ApplicationsWorkspace({
  application,
  vms,
  credentialProfiles,
  terraform,
  onInstallTerraform,
  onCreate,
  onEdit,
  onSync,
  onBuild,
  onDeploy,
  onLoadLogs,
  onOpenVm,
  onSaveDomain,
  onRemoveDomain,
  onCreateEnvironment,
  onPlanEnvironment,
  onApplyEnvironment,
}: ApplicationsWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<ApplicationTab>('overview')
  const [action, setAction] = useState<'sync' | 'build' | 'deploy'>()
  const [message, setMessage] = useState<string>()
  const [deployOpen, setDeployOpen] = useState(false)

  if (!application) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-slate-50 p-6">
        <section className="max-w-lg rounded border border-slate-200 bg-white p-8 text-center shadow-sm">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <Boxes className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-slate-950">Create your first application</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Grove copies source into its local workspace, builds immutable versions, and deploys them to one or more existing VMs.
          </p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800"
          >
            <Boxes className="h-4 w-4" aria-hidden="true" />
            New application
          </button>
        </section>
      </main>
    )
  }

  async function runAction(kind: 'sync' | 'build', operation: () => Promise<void>) {
    setAction(kind)
    setMessage(undefined)
    try {
      await operation()
      setMessage(kind === 'sync' ? 'Managed source is up to date.' : 'A new application version was built.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : `${kind === 'sync' ? 'Source sync' : 'Build'} failed.`)
    } finally {
      setAction(undefined)
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-5 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-slate-950">{application.name}</h2>
              <StatusBadge status={application.health} />
            </div>
            <p className="truncate text-sm text-slate-500">
              {application.description || `${sourceLabel(application)} · ${application.managedSourcePath}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ActionButton
              label={action === 'sync' ? 'Syncing' : 'Sync source'}
              icon={action === 'sync' ? LoaderCircle : RefreshCw}
              disabled={Boolean(action)}
              spinning={action === 'sync'}
              onClick={() => runAction('sync', onSync)}
            />
            <ActionButton
              label={action === 'build' ? 'Building' : 'Build version'}
              icon={action === 'build' ? LoaderCircle : Code2}
              disabled={Boolean(action)}
              spinning={action === 'build'}
              onClick={() => runAction('build', onBuild)}
            />
            <button
              type="button"
              disabled={!application.versions.some((version) => version.status === 'succeeded') || Boolean(action)}
              onClick={() => setDeployOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Rocket className="h-4 w-4" aria-hidden="true" />
              Deploy
            </button>
          </div>
        </div>
        {message ? <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">{message}</div> : null}
        <nav className="flex gap-1 overflow-x-auto" aria-label="Application sections">
          {applicationTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.value}
                type="button"
                aria-pressed={activeTab === tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cx(
                  'inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-2 text-sm font-medium transition',
                  activeTab === tab.value
                    ? 'border-slate-950 text-slate-950'
                    : 'border-transparent text-slate-500 hover:text-slate-900',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {activeTab === 'overview' ? <Overview application={application} vms={vms} onOpenVm={onOpenVm} onSelectTab={setActiveTab} /> : null}
        {activeTab === 'configuration' ? <Configuration application={application} onEdit={onEdit} /> : null}
        {activeTab === 'domain' ? (
          <Domain
            application={application}
            vms={vms}
            credentialProfiles={credentialProfiles}
            onSave={onSaveDomain}
            onRemove={onRemoveDomain}
          />
        ) : null}
        {activeTab === 'environments' ? (
          <EnvironmentsPanel
            application={application}
            credentialProfiles={credentialProfiles}
            terraform={terraform}
            onInstallTerraform={onInstallTerraform}
            onCreate={onCreateEnvironment}
            onPlan={onPlanEnvironment}
            onApply={onApplyEnvironment}
            onOpenVm={onOpenVm}
          />
        ) : null}
        {activeTab === 'deployments' ? <Deployments deployments={application.deployments} vms={vms} /> : null}
        {activeTab === 'versions' ? <Versions application={application} onDeploy={(versionId) => {
          setDeployOpen(true)
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('grove:select-deploy-version', { detail: versionId })), 0)
        }} /> : null}
        {activeTab === 'vms' ? <Instances application={application} vms={vms} onOpenVm={onOpenVm} /> : null}
        {activeTab === 'logs' ? <Logs application={application} vms={vms} onLoad={onLoadLogs} /> : null}
      </div>

      {deployOpen ? <DeployDialog
        // Key by application only: the version list is read reactively from props, and a
        // build completing mid-dialog must not remount and wipe the user's selections.
        key={application.id}
        open={deployOpen}
        application={application}
        vms={vms}
        busy={action === 'deploy'}
        onOpenChange={setDeployOpen}
        onDeploy={async (versionId, vmIds, environment) => {
          setAction('deploy')
          setMessage(undefined)
          try {
            await onDeploy(versionId, vmIds, environment)
            setDeployOpen(false)
            setActiveTab('deployments')
            setMessage(`Deployment completed for ${vmIds.length} VM${vmIds.length === 1 ? '' : 's'}.`)
          } catch (cause) {
            setMessage(cause instanceof Error ? cause.message : 'Deployment failed.')
          } finally {
            setAction(undefined)
          }
        }}
      /> : null}
    </main>
  )
}

function Overview({
  application,
  vms,
  onOpenVm,
  onSelectTab,
}: {
  application: GroveApplication
  vms: VM[]
  onOpenVm: (vmId: string) => void
  onSelectTab: (tab: ApplicationTab) => void
}) {
  const latestVersion = application.versions[0]
  const latestDeployment = application.deployments[0]
  const healthyInstances = application.instances.filter((instance) => instance.status === 'healthy').length
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)]">
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Application status" value={humanize(application.health)} detail={`${healthyInstances}/${application.instances.length} targets healthy`} status={application.health} />
          <Metric label="Active version" value={activeVersionLabel(application)} detail={latestVersion ? `Latest build ${formatRelative(latestVersion.createdAt)}` : 'No builds yet'} />
          <Metric label="Deployed VMs" value={String(application.instances.length)} detail={`${application.deployments.length} deployment records`} />
          <button type="button" onClick={() => onSelectTab('domain')} className="text-left">
            <Metric
              label="Domain"
              value={application.domain?.hostname ?? 'Not set'}
              detail={application.domain?.dnsDetail ?? 'Configure a Name.com A record'}
              status={application.domain?.dnsStatus}
            />
          </button>
        </div>
        <Panel title="Deployed virtual machines" detail="Observed state for every application target" action="View all" onAction={() => onSelectTab('vms')}>
          {application.instances.length ? (
            <div className="divide-y divide-slate-200">
              {application.instances.slice(0, 5).map((instance) => {
                const vm = vms.find((item) => item.id === instance.vmId)
                return (
                  <button key={instance.vmId} type="button" onClick={() => onOpenVm(instance.vmId)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                    <span className={cx('h-2 w-2 rounded-full', instance.status === 'healthy' ? 'bg-emerald-500' : instance.status === 'failed' ? 'bg-rose-500' : 'bg-amber-500')} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm text-slate-900">{vm?.name ?? instance.vmId}</strong>
                      <span className="block truncate text-xs text-slate-500">{vm?.ipAddress ?? instance.remotePath}</span>
                    </span>
                    <span className="text-xs text-slate-500">{versionLabel(application, instance.versionId)}</span>
                    <StatusBadge status={instance.status} />
                  </button>
                )
              })}
            </div>
          ) : <EmptyLine text="This application has not been deployed." />}
        </Panel>
      </div>
      <div className="grid content-start gap-4">
        <Panel title="Latest deployment" detail={latestDeployment ? formatDate(latestDeployment.createdAt) : 'No deployment history'} action={latestDeployment ? 'History' : undefined} onAction={() => onSelectTab('deployments')}>
          {latestDeployment ? (
            <div className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-900">{versionLabel(application, latestDeployment.versionId)}</span>
                <StatusBadge status={latestDeployment.status} />
              </div>
              <div className="text-xs text-slate-500">{latestDeployment.targetVmIds.length} targets · {latestDeployment.environment}</div>
              <DeploymentProgress deployment={latestDeployment} />
            </div>
          ) : <EmptyLine text="Build a version, then deploy it to one or more VMs." />}
        </Panel>
        <Panel title="Workspace" detail="Local managed state">
          <dl className="grid gap-3 p-4 text-xs">
            <Definition label="Source" value={sourceLabel(application)} />
            <Definition label="Managed copy" value={application.managedSourcePath} mono />
            <Definition label="Remote root" value={`~/grove/${application.slug}`} mono />
            <Definition label="Service" value={`grove-${application.slug}.service`} mono />
          </dl>
        </Panel>
      </div>
    </div>
  )
}

function Domain({
  application,
  vms,
  credentialProfiles,
  onSave,
  onRemove,
}: {
  application: GroveApplication
  vms: VM[]
  credentialProfiles: CredentialProfile[]
  onSave: (input: ApplicationDomainInput) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const nameComProfiles = credentialProfiles.filter((profile) => profile.kind === 'name.com')
  const deployedVms = application.instances.flatMap((instance) => {
    const vm = vms.find((candidate) => candidate.id === instance.vmId)
    return vm ? [vm] : []
  })
  const defaultProfile =
    application.domain?.nameComCredentialProfileId ??
    nameComProfiles.find((profile) => profile.isDefault)?.id ??
    nameComProfiles[0]?.id ??
    ''
  const [hostname, setHostname] = useState(application.domain?.hostname ?? '')
  const [profileId, setProfileId] = useState(defaultProfile)
  const [vmId, setVmId] = useState(application.domain?.vmId ?? deployedVms[0]?.id ?? '')
  const [busy, setBusy] = useState<'save' | 'remove'>()
  const [message, setMessage] = useState<string>()
  const targetVm = deployedVms.find((vm) => vm.id === vmId)

  async function save() {
    setBusy('save')
    setMessage(undefined)
    try {
      await onSave({ hostname: hostname.trim(), nameComCredentialProfileId: profileId, vmId })
      setMessage('Name.com DNS is configured.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Unable to configure the domain.')
    } finally {
      setBusy(undefined)
    }
  }

  async function remove() {
    if (!window.confirm(`Remove Grove's DNS record for ${application.domain?.hostname}?`)) return
    setBusy('remove')
    setMessage(undefined)
    try {
      await onRemove()
      setHostname('')
      setMessage('The Grove-owned Name.com record was removed.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Unable to remove the domain.')
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
      <Panel title="Application domain" detail="Create and maintain one Name.com A record for this application">
        <div className="grid gap-5 p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium text-slate-600 md:col-span-2">
              Fully-qualified hostname
              <input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="app.example.com"
                className="field-control"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-slate-600">
              Name.com credential
              <select value={profileId} onChange={(event) => setProfileId(event.target.value)} className="field-control">
                <option value="">Select a credential</option>
                {nameComProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id} disabled={!profile.secretConfigured}>
                    {profile.name}{profile.isDefault ? ' · default' : ''}{!profile.secretConfigured ? ' · token missing' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-slate-600">
              Deployed VM
              <select value={vmId} onChange={(event) => setVmId(event.target.value)} className="field-control">
                <option value="">Select a deployed VM</option>
                {deployedVms.map((vm) => <option key={vm.id} value={vm.id}>{vm.name} · {vm.ipAddress}</option>)}
              </select>
            </label>
          </div>

          {nameComProfiles.length === 0 ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Add a Name.com credential in Grove Settings before configuring DNS.
            </div>
          ) : null}
          {deployedVms.length === 0 ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Deploy this application to a VM before assigning a domain.
            </div>
          ) : null}
          {message ? <div role="status" className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{message}</div> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <span className="text-xs text-slate-500">Target: {targetVm?.ipAddress ?? 'Select a deployed VM'} · TTL 300</span>
            <div className="flex gap-2">
              {application.domain ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={remove}
                  className="inline-flex h-9 items-center gap-2 rounded border border-rose-300 px-3 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-45"
                >
                  {busy === 'remove' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Remove domain
                </button>
              ) : null}
              <button
                type="button"
                disabled={Boolean(busy) || !hostname.trim() || !profileId || !vmId}
                onClick={save}
                className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy === 'save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
                {application.domain ? 'Reconcile domain' : 'Configure domain'}
              </button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid content-start gap-4">
        <Panel title="DNS status" detail="Latest Name.com reconciliation result">
          {application.domain ? (
            <div className="grid gap-4 p-4 text-xs">
              <div className="flex items-center justify-between gap-3">
                <strong className="break-all text-sm text-slate-900">{application.domain.hostname}</strong>
                <StatusBadge status={application.domain.dnsStatus} />
              </div>
              <dl className="grid gap-3">
                <Definition label="Target VM" value={vms.find((vm) => vm.id === application.domain?.vmId)?.name ?? application.domain.vmId} />
                <Definition label="Record type" value="A · TTL 300" mono />
                {application.domain.dnsRecordId ? <Definition label="Grove-owned record ID" value={application.domain.dnsRecordId} mono /> : null}
                <Definition label="Last update" value={formatDate(application.domain.updatedAt)} />
                <Definition label="Detail" value={application.domain.dnsDetail ?? 'No detail available.'} />
              </dl>
            </div>
          ) : <EmptyLine text="No application domain is configured." />}
        </Panel>
        <Panel title="Routing boundary" detail="What this DNS setting controls">
          <p className="p-4 text-xs leading-5 text-slate-600">
            Grove points the hostname to the selected VM. DNS cannot select an application port or provide TLS; expose this app through port 80/443 and configure HTTPS separately.
          </p>
        </Panel>
      </div>
    </div>
  )
}

function Configuration({ application, onEdit }: { application: GroveApplication; onEdit: () => void }) {
  const configuration = application.configuration
  return (
    <Panel title="Application configuration" detail="Source, local build, systemd runtime, and health settings" action="Edit" onAction={onEdit}>
      <div className="grid gap-6 p-5 md:grid-cols-2">
        <ConfigGroup title="Source">
          <Definition label="Type" value={application.source.type === 'local' ? 'Local folder' : 'Git repository'} />
          <Definition label="Location" value={application.source.type === 'local' ? application.source.path : application.source.repoUrl} mono />
          {application.source.type === 'git' ? <Definition label="Reference" value={application.source.ref || 'default branch'} mono /> : null}
          <Definition label="Managed copy" value={application.managedSourcePath} mono />
        </ConfigGroup>
        <ConfigGroup title="Build">
          <Definition label="Install" value={configuration.installCommand || 'None'} mono />
          <Definition label="Build" value={configuration.buildCommand || 'None'} mono />
          <Definition label="Artifact" value={configuration.artifactPath} mono />
        </ConfigGroup>
        <ConfigGroup title="Runtime">
          <Definition label="Start" value={configuration.startCommand} mono />
          <Definition label="Port" value={String(configuration.port)} mono />
          <Definition label="Remote root" value={`~/grove/${application.slug}`} mono />
        </ConfigGroup>
        <ConfigGroup title="Health and environment">
          <Definition label="Health path" value={configuration.healthCheckPath} mono />
          <Definition label="Timeout" value={`${configuration.healthCheckTimeoutSeconds} seconds`} />
          <Definition label="Environment" value={`${Object.keys(configuration.environment).length} non-secret values`} />
        </ConfigGroup>
      </div>
    </Panel>
  )
}

function Deployments({ deployments, vms }: { deployments: ApplicationDeployment[]; vms: VM[] }) {
  return (
    <Panel title="Deployment history" detail="Every multi-VM rollout and its per-target result">
      {deployments.length ? (
        <div className="divide-y divide-slate-200">
          {deployments.map((deployment) => (
            <div key={deployment.id} className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{deployment.id}</div>
                  <div className="mt-1 text-xs text-slate-500">{formatDate(deployment.createdAt)} · {deployment.environment} · rolling</div>
                </div>
                <StatusBadge status={deployment.status} />
              </div>
              <DeploymentProgress deployment={deployment} />
              <div className="grid gap-2 md:grid-cols-2">
                {deployment.targets.map((target) => (
                  <div key={target.vmId} className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-xs">
                    <StatusIcon status={target.status} />
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{vms.find((vm) => vm.id === target.vmId)?.name ?? target.vmId}</span>
                    <span className="text-slate-500">{humanize(target.status)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyLine text="No deployments yet." />}
    </Panel>
  )
}

function Versions({ application, onDeploy }: { application: GroveApplication; onDeploy: (versionId: string) => void }) {
  return (
    <Panel title="Application versions" detail="Immutable artifacts built on this machine">
      {application.versions.length ? (
        <div className="divide-y divide-slate-200">
          {application.versions.map((version) => (
            <div key={version.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">v{version.sequence}</span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm text-slate-900">
                  {version.label}{application.activeVersionId === version.id ? ' · active' : ''}
                </strong>
                <span className="block truncate text-xs text-slate-500">
                  {version.id} · {formatDate(version.createdAt)}{version.artifactSizeBytes ? ` · ${formatBytes(version.artifactSizeBytes)}` : ''}
                </span>
                {version.failure ? <span className="mt-1 block text-xs text-rose-700">{version.failure}</span> : null}
              </span>
              <StatusBadge status={version.status} />
              {version.status === 'succeeded' ? (
                <button type="button" onClick={() => onDeploy(version.id)} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <Play className="h-3.5 w-3.5" aria-hidden="true" /> Deploy
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : <EmptyLine text="No versions yet. Sync source and build the first version." />}
    </Panel>
  )
}

function Instances({ application, vms, onOpenVm }: { application: GroveApplication; vms: VM[]; onOpenVm: (vmId: string) => void }) {
  return (
    <Panel title="Deployed virtual machines" detail="Current and desired version for every target">
      {application.instances.length ? (
        <div className="divide-y divide-slate-200">
          {application.instances.map((instance) => {
            const vm = vms.find((item) => item.id === instance.vmId)
            return (
              <button key={instance.vmId} type="button" onClick={() => onOpenVm(instance.vmId)} className="grid w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:grid-cols-[minmax(160px,1fr)_minmax(160px,1fr)_auto] sm:items-center">
                <span className="min-w-0">
                  <strong className="block truncate text-sm text-slate-900">{vm?.name ?? instance.vmId}</strong>
                  <span className="block truncate text-xs text-slate-500">{vm?.ipAddress ?? instance.remotePath}</span>
                </span>
                <span className="min-w-0 text-xs text-slate-500">
                  <span className="block truncate font-mono">{instance.remotePath}</span>
                  <span className="block truncate">{versionLabel(application, instance.versionId)}</span>
                </span>
                <StatusBadge status={instance.status} />
              </button>
            )
          })}
        </div>
      ) : <EmptyLine text="No deployed VMs." />}
    </Panel>
  )
}

function Logs({ application, vms, onLoad }: { application: GroveApplication; vms: VM[]; onLoad: (vmId: string) => Promise<string[]> }) {
  const [vmId, setVmId] = useState(application.instances[0]?.vmId ?? '')
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const availableVmIds = application.instances.map((instance) => instance.vmId)
  const selectedVmId = availableVmIds.includes(vmId) ? vmId : (availableVmIds[0] ?? '')

  async function load() {
    if (!selectedVmId) return
    setLoading(true)
    setError(undefined)
    try {
      setLines(await onLoad(selectedVmId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load logs.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Panel title="Application logs" detail={`journalctl for grove-${application.slug}.service`}>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
        <label className="grid min-w-56 gap-1 text-xs font-medium text-slate-600">
          Virtual machine
          <select value={selectedVmId} onChange={(event) => setVmId(event.target.value)} className="field-control">
            {application.instances.map((instance) => <option key={instance.vmId} value={instance.vmId}>{vms.find((vm) => vm.id === instance.vmId)?.name ?? instance.vmId}</option>)}
          </select>
        </label>
        <ActionButton label={loading ? 'Loading' : 'Load latest'} icon={loading ? LoaderCircle : RefreshCw} spinning={loading} disabled={loading || !selectedVmId} onClick={load} />
      </div>
      <pre className="min-h-72 overflow-auto bg-slate-950 p-4 text-xs leading-5 text-slate-100">
        {error || lines.join('\n') || (selectedVmId ? 'Load the latest service logs from this VM.' : 'Deploy the application before reading logs.')}
      </pre>
    </Panel>
  )
}

function DeployDialog({
  open,
  application,
  vms,
  busy,
  onOpenChange,
  onDeploy,
}: {
  open: boolean
  application: GroveApplication
  vms: VM[]
  busy: boolean
  onOpenChange: (open: boolean) => void
  onDeploy: (versionId: string, vmIds: string[], environment: string) => Promise<void>
}) {
  const versions = application.versions.filter((version) => version.status === 'succeeded')
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '')
  const [selectedVmIds, setSelectedVmIds] = useState<string[]>(application.instances.map((instance) => instance.vmId))
  const [environment, setEnvironment] = useState('production')

  useEffect(() => {
    if (!open) return
    const selectVersion = (event: Event) => setVersionId((event as CustomEvent<string>).detail)
    window.addEventListener('grove:select-deploy-version', selectVersion)
    return () => window.removeEventListener('grove:select-deploy-version', selectVersion)
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-32px)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded border border-slate-200 bg-white shadow-2xl focus:outline-none">
          <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-slate-950">Deploy {application.name}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">Select an immutable version and one or more existing VMs.</Dialog.Description>
            </div>
            <IconButton label="Close deployment" disabled={busy} onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></IconButton>
          </header>
          <div className="grid gap-5 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Version
                <select value={versionId} onChange={(event) => setVersionId(event.target.value)} className="field-control">
                  {versions.map((version) => <option key={version.id} value={version.id}>v{version.sequence} · {version.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Environment
                <input value={environment} onChange={(event) => setEnvironment(event.target.value)} className="field-control" />
              </label>
            </div>
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-950">Target virtual machines</h3>
                  <p className="text-xs text-slate-500">Deployment runs sequentially and rolls back a failed target.</p>
                </div>
                <button type="button" onClick={() => setSelectedVmIds(selectedVmIds.length === vms.length ? [] : vms.map((vm) => vm.id))} className="text-xs font-medium text-slate-600 hover:text-slate-950">
                  {selectedVmIds.length === vms.length ? 'Clear' : 'Select all'}
                </button>
              </div>
              <div className="max-h-64 divide-y divide-slate-200 overflow-auto rounded border border-slate-200">
                {vms.map((vm) => (
                  <label key={vm.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selectedVmIds.includes(vm.id)}
                      onChange={(event) => setSelectedVmIds((current) => event.target.checked ? [...current, vm.id] : current.filter((id) => id !== vm.id))}
                    />
                    <span className={cx('h-2 w-2 rounded-full', vm.health === 'healthy' ? 'bg-emerald-500' : vm.health === 'offline' ? 'bg-slate-300' : 'bg-amber-500')} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm text-slate-900">{vm.name}</strong>
                      <span className="block truncate text-xs text-slate-500">{vm.connection.user}@{vm.ipAddress}:{vm.connection.port}</span>
                    </span>
                    <span className="text-xs capitalize text-slate-500">{vm.lifecycle}</span>
                  </label>
                ))}
                {vms.length === 0 ? <EmptyLine text="Add a VM before deploying this application." /> : null}
              </div>
            </section>
          </div>
          <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
            <span className="text-xs text-slate-500">{selectedVmIds.length} selected</span>
            <button
              type="button"
              disabled={busy || !versionId || selectedVmIds.length === 0}
              onClick={() => onDeploy(versionId, selectedVmIds, environment.trim() || 'production')}
              className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {busy ? 'Deploying' : 'Deploy to selected VMs'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Panel({ title, detail, action, onAction, children }: { title: string; detail: string; action?: string; onAction?: () => void; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div><h3 className="text-sm font-semibold text-slate-950">{title}</h3><p className="mt-0.5 text-xs text-slate-500">{detail}</p></div>
        {action ? <button type="button" onClick={onAction} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">{action === 'Edit' ? <Pencil className="h-3.5 w-3.5" /> : null}{action}</button> : null}
      </header>
      {children}
    </section>
  )
}

function Metric({ label, value, detail, status }: { label: string; value: string; detail: string; status?: string }) {
  return <div className="rounded border border-slate-200 bg-white p-4 shadow-sm"><div className="text-xs font-medium text-slate-500">{label}</div><div className="mt-2 flex items-center gap-2"><strong className="text-xl text-slate-950">{value}</strong>{status ? <StatusBadge status={status} compact /> : null}</div><div className="mt-1 text-xs text-slate-500">{detail}</div></div>
}

function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  return <span className={cx('inline-flex items-center rounded-full border font-medium', compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs', statusClasses[status] ?? statusClasses.unknown)}>{humanize(status)}</span>
}

function StatusIcon({ status }: { status: ApplicationDeploymentTargetStatus | ApplicationVersionStatus | ApplicationInstanceStatus }) {
  return status === 'healthy' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : status === 'failed' || status === 'rolled_back' ? <CircleAlert className="h-4 w-4 text-rose-600" /> : <Clock3 className="h-4 w-4 text-slate-500" />
}

function ActionButton({ label, icon: Icon, disabled, spinning, onClick }: { label: string; icon: typeof Activity; disabled?: boolean; spinning?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"><Icon className={cx('h-4 w-4', spinning && 'animate-spin')} />{label}</button>
}

function Definition({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid gap-0.5"><dt className="text-slate-500">{label}</dt><dd className={cx('break-all font-medium text-slate-800', mono && 'font-mono')}>{value}</dd></div>
}

function ConfigGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="grid content-start gap-3 rounded border border-slate-200 p-4"><h3 className="text-xs font-semibold uppercase text-slate-500">{title}</h3><dl className="grid gap-3 text-xs">{children}</dl></section>
}

function EmptyLine({ text }: { text: string }) {
  return <div className="p-6 text-center text-sm text-slate-500">{text}</div>
}

function DeploymentProgress({ deployment }: { deployment: ApplicationDeployment }) {
  const complete = deployment.targets.filter((target) => target.status === 'healthy').length
  const progress = deployment.targets.length ? Math.round((complete / deployment.targets.length) * 100) : 0
  return <div><div className="mb-1 flex justify-between text-[11px] text-slate-500"><span>{complete}/{deployment.targets.length} healthy</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} /></div></div>
}

function humanize(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function sourceLabel(application: GroveApplication) {
  return application.source.type === 'local' ? application.source.path : `${application.source.repoUrl}${application.source.ref ? ` @ ${application.source.ref}` : ''}`
}

function formatDate(value: string) {
  const parsed = new Date(value)
  // A malformed timestamp degrades to the raw value; Intl.DateTimeFormat.format would
  // throw a RangeError and take the whole workspace render down with it.
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
}

function formatRelative(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

function versionLabel(application: GroveApplication, versionId?: string) {
  if (!versionId) return 'No active version'
  const version = application.versions.find((item) => item.id === versionId)
  return version ? `v${version.sequence}` : versionId
}

function activeVersionLabel(application: GroveApplication) {
  return versionLabel(application, application.activeVersionId)
}
