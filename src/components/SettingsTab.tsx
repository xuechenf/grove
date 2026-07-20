import { AlertTriangle, Cloud, LoaderCircle, PenLine, PlugZap, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { addCloudFirewallRule, listCloudFirewallRules, removeCloudFirewallRule } from '../lib/api'
import { cx } from '../lib/format'
import type { CloudFirewallRule, GroveApplication, VM, VmOverviewTelemetry } from '../types'

interface SettingsTabProps {
  vm: VM
  telemetry: VmOverviewTelemetry
  applications: GroveApplication[]
  loading?: boolean
  onRefreshCloud: () => void
  onTestConnection: () => void
  onEditVm: () => void
  onOpenInfrastructure: (applicationId: string) => void
  onRemoveVm: () => void
}

function Field({ label, value, mono = false }: { label: string; value: string | number; mono?: boolean }) {
  return <div className="rounded border border-slate-200 bg-white px-3 py-2"><div className="text-[11px] font-medium uppercase text-slate-500">{label}</div><div className={cx('truncate text-sm font-semibold text-slate-800', mono && 'font-mono')}>{value}</div></div>
}

function credentialLabel(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function SettingsTab({ vm, telemetry, applications, loading = false, onRefreshCloud, onTestConnection, onEditVm, onOpenInfrastructure, onRemoveVm }: SettingsTabProps) {
  const machine = telemetry.cloudMachine
  const managedEnvironment = useMemo(() => applications.flatMap((application) => application.environments.map((environment) => ({ application, environment }))).find(({ environment }) => environment.vmIds.includes(vm.id)), [applications, vm.id])
  const [rules, setRules] = useState<CloudFirewallRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string>()
  const [showAddRule, setShowAddRule] = useState(false)
  const [firewallId, setFirewallId] = useState('')
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  const [fromPort, setFromPort] = useState(443)
  const [toPort, setToPort] = useState(443)
  const [cidr, setCidr] = useState('0.0.0.0/0')
  const [description, setDescription] = useState('')
  const machineId = machine?.id
  const effectiveFirewallId = machine?.firewalls.some((firewall) => firewall.id === firewallId) ? firewallId : machine?.firewalls[0]?.id ?? ''

  useEffect(() => {
    if (!machineId) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setRulesLoading(true)
        setError(undefined)
      }
    }).then(() => listCloudFirewallRules(machineId)).then((nextRules) => { if (!cancelled) setRules(nextRules) }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load security-group rules.') }).finally(() => { if (!cancelled) setRulesLoading(false) })
    return () => { cancelled = true }
  }, [machineId])

  async function addRule() {
    if (!machine || !effectiveFirewallId || managedEnvironment) return
    setMutating(true)
    setError(undefined)
    try {
      setRules(await addCloudFirewallRule(machine.id, { firewallId: effectiveFirewallId, protocol, fromPort, toPort, cidr: cidr.trim(), description: description.trim() || undefined }))
      setShowAddRule(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Security-group change failed.')
    } finally {
      setMutating(false)
    }
  }

  async function removeRule(rule: CloudFirewallRule) {
    if (!machine || managedEnvironment || !window.confirm(`Remove ${rule.protocol} ${rule.fromPort ?? '*'}-${rule.toPort ?? '*'} from ${rule.source}?`)) return
    setMutating(true)
    setError(undefined)
    try {
      setRules(await removeCloudFirewallRule(machine.id, rule.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Security-group change failed.')
    } finally {
      setMutating(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="settings-tab">
      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div><h2 className="text-sm font-semibold text-slate-950">Identity and SSH</h2><p className="text-xs text-slate-500">The VM references a Grove credential; private key material is never rendered.</p></div><div className="flex gap-2"><button type="button" onClick={onEditVm} className="inline-flex h-8 items-center gap-2 rounded border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><PenLine className="h-3.5 w-3.5" />Modify VM</button><button type="button" onClick={onTestConnection} className="inline-flex h-8 items-center gap-2 rounded bg-slate-900 px-2.5 text-xs font-medium text-white hover:bg-slate-800"><PlugZap className="h-3.5 w-3.5" />Test connection</button></div></header>
        <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4"><Field label="Host" value={vm.connection.host} mono /><Field label="User" value={vm.connection.user} /><Field label="Port" value={vm.connection.port} /><Field label="SSH credential" value={credentialLabel(vm.connection.keyLabel)} /><Field label="Key status" value={vm.connection.keyStatus} /><Field label="Last connected" value={vm.connection.lastConnected} /><Field label="Test status" value={vm.connection.testStatus} /><Field label="Remote OS" value={vm.os} /></div>
      </section>

      <section className="rounded border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div className="flex items-center gap-2"><Cloud className="h-4 w-4 text-slate-500" /><div><h2 className="text-sm font-semibold text-slate-950">Cloud binding and network</h2><p className="text-xs text-slate-500">The same provider match powers Overview, Monitoring, and security controls.</p></div></div><button type="button" onClick={onRefreshCloud} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />Refresh binding</button></header>
        {machine ? <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4"><Field label="Provider" value={machine.provider.toUpperCase()} /><Field label="Credential profile" value={machine.credentialProfileName} /><Field label="Region / zone" value={`${machine.location}${machine.zone ? ` / ${machine.zone}` : ''}`} /><Field label="Native machine ID" value={machine.nativeId ?? machine.id} mono /><Field label="Public IP" value={machine.publicIp ?? '—'} mono /><Field label="Private IP" value={machine.privateIp ?? '—'} mono /><Field label="VPC / virtual network" value={machine.vpcId ?? '—'} mono /><Field label="Subnet / VSwitch" value={machine.subnetId ?? '—'} mono /></div> : <div className="flex gap-3 p-4 text-sm text-slate-600"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /><div><strong className="block text-slate-800">Host-managed VM</strong><p className="mt-1">No tested AWS or Alibaba Cloud credential currently matches this VM. Grove continues to monitor it over SSH without presenting cloud-only controls.</p></div></div>}
      </section>

      <section className="rounded border border-slate-200 bg-white" data-testid="security-groups-panel">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2"><div className="flex items-center gap-2"><Shield className="h-4 w-4 text-slate-500" /><div><h2 className="text-sm font-semibold text-slate-950">Cloud security groups</h2><p className="text-xs text-slate-500">Cloud rules are separate from the VM's host firewall.</p></div></div>{machine && !managedEnvironment ? <button type="button" onClick={() => setShowAddRule((current) => !current)} disabled={!machine.firewalls.length || mutating} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />Add ingress</button> : null}</header>
        {managedEnvironment ? <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800"><span>Managed by Terraform through {managedEnvironment.application.name} / {managedEnvironment.environment.name}. Direct provider changes are disabled to prevent drift.</span><button type="button" onClick={() => onOpenInfrastructure(managedEnvironment.application.id)} className="h-7 rounded border border-blue-200 bg-white px-2 font-medium">Open infrastructure</button></div> : null}
        {!machine ? <p className="px-3 py-4 text-sm text-slate-500">Cloud security groups are unavailable for host-managed machines. Use SSH to inspect the host firewall.</p> : null}
        {showAddRule && machine && !managedEnvironment ? <div className="grid gap-2 border-b border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 xl:grid-cols-3"><label className="grid gap-1 text-xs text-slate-600">Security group<select value={effectiveFirewallId} onChange={(event) => setFirewallId(event.target.value)} className="field-control">{machine.firewalls.map((firewall) => <option key={firewall.id} value={firewall.id}>{firewall.name}</option>)}</select></label><label className="grid gap-1 text-xs text-slate-600">Protocol<select value={protocol} onChange={(event) => setProtocol(event.target.value as 'tcp' | 'udp')} className="field-control"><option value="tcp">TCP</option><option value="udp">UDP</option></select></label><label className="grid gap-1 text-xs text-slate-600">Source CIDR<input value={cidr} onChange={(event) => setCidr(event.target.value)} className="field-control" /></label><label className="grid gap-1 text-xs text-slate-600">From port<input type="number" min={0} max={65535} value={fromPort} onChange={(event) => setFromPort(Number(event.target.value))} className="field-control" /></label><label className="grid gap-1 text-xs text-slate-600">To port<input type="number" min={0} max={65535} value={toPort} onChange={(event) => setToPort(Number(event.target.value))} className="field-control" /></label><label className="grid gap-1 text-xs text-slate-600">Description<input value={description} onChange={(event) => setDescription(event.target.value)} className="field-control" /></label><div className="flex justify-end gap-2 xl:col-span-3"><button type="button" onClick={() => setShowAddRule(false)} className="h-8 px-2 text-xs text-slate-600">Cancel</button><button type="button" onClick={() => void addRule()} disabled={mutating || !cidr.trim() || fromPort > toPort} className="h-8 rounded bg-slate-900 px-3 text-xs font-medium text-white disabled:opacity-50">Add rule</button></div></div> : null}
        {error ? <p className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p> : null}
        {machine ? rulesLoading ? <p className="flex items-center gap-2 px-3 py-4 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading security-group rules…</p> : <div className="divide-y divide-slate-100">{rules.length ? rules.map((rule) => <div key={rule.id} className="flex items-center gap-2 px-3 py-2 text-xs"><span className={cx('rounded px-1.5 py-0.5', rule.direction === 'ingress' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600')}>{rule.direction}</span><span className="font-mono text-slate-700">{rule.protocol} {rule.fromPort ?? '*'}-{rule.toPort ?? '*'}</span><span className="min-w-0 flex-1 truncate text-slate-500">{rule.source} · {rule.firewallName}</span>{rule.direction === 'ingress' && !managedEnvironment ? <button type="button" aria-label={`Remove ${rule.protocol} ${rule.fromPort ?? '*'} rule`} onClick={() => void removeRule(rule)} disabled={mutating} className="rounded p-1 text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>) : <p className="px-3 py-4 text-sm text-slate-500">No security-group rules returned.</p>}</div> : null}
      </section>

      <section className="rounded border border-rose-200 bg-white"><header className="border-b border-rose-100 px-3 py-2"><h2 className="text-sm font-semibold text-rose-800">Danger zone</h2><p className="text-xs text-slate-500">Removing a VM only removes it from Grove; it does not delete the provider resource.</p></header><div className="flex flex-wrap items-center justify-between gap-3 p-3"><div><strong className="text-sm text-slate-800">Remove {vm.name}</strong><p className="text-xs text-slate-500">The confirmation dialog identifies the exact VM before removal.</p></div><button type="button" onClick={onRemoveVm} className="inline-flex h-8 items-center gap-1.5 rounded border border-rose-300 px-2.5 text-xs font-medium text-rose-700 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />Remove from Grove</button></div></section>
    </div>
  )
}
