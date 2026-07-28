import { Activity, LoaderCircle, Play, Plus, RefreshCw, RotateCw, Shield, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addCloudFirewallRule,
  apiDisabled,
  changeCloudMachinePower,
  getCloudMachineMetrics,
  listCloudFirewallRules,
  listCloudMachines,
  removeCloudFirewallRule,
} from '../lib/api'
import { formatFirewallRule } from '../lib/format'
import type {
  CloudFirewallRule,
  CloudFirewallRuleInput,
  CloudInventory,
  CloudMachine,
  CloudMachineMetrics,
  CloudMachinePowerAction,
} from '../types'

const emptyInventory: CloudInventory = { machines: [], scannedAt: '', warnings: [] }

function latestMetric(metrics: CloudMachineMetrics | undefined, key: CloudMachineMetrics['series'][number]['key']) {
  const points = metrics?.series.find((series) => series.key === key)?.points ?? []
  return points.at(-1)?.value
}

function stateTone(state: CloudMachine['state']) {
  if (state === 'running') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (state === 'stopped') return 'border-slate-200 bg-slate-50 text-slate-600'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

export function CloudMachinesPanel() {
  const [inventory, setInventory] = useState(emptyInventory)
  const [selectedId, setSelectedId] = useState<string>()
  const [rules, setRules] = useState<CloudFirewallRule[]>([])
  const [metrics, setMetrics] = useState<CloudMachineMetrics>()
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string>()
  const [showAddRule, setShowAddRule] = useState(false)
  const [ruleInput, setRuleInput] = useState<CloudFirewallRuleInput>({
    firewallId: '',
    protocol: 'tcp',
    fromPort: 443,
    toPort: 443,
    cidr: '0.0.0.0/0',
    description: 'Managed by Grove',
  })
  const selected = useMemo(
    () => inventory.machines.find((machine) => machine.id === selectedId),
    [inventory.machines, selectedId],
  )

  const refresh = useCallback(async () => {
    if (apiDisabled()) return
    setLoading(true)
    setError(undefined)
    try {
      const next = await listCloudMachines()
      setInventory(next)
      setSelectedId((current) => current && next.machines.some((machine) => machine.id === current)
        ? current
        : next.machines[0]?.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cloud inventory failed.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh])

  useEffect(() => {
    if (!selectedId || apiDisabled()) {
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (!cancelled) {
          // Switching machines (or retrying) drops the previous error and the stale
          // rules/metrics of the machine they belonged to.
          setDetailLoading(true)
          setError(undefined)
          setRules([])
          setMetrics(undefined)
        }
        return Promise.all([listCloudFirewallRules(selectedId), getCloudMachineMetrics(selectedId, 1)])
      })
      .then(([nextRules, nextMetrics]) => {
        if (cancelled) return
        setRules(nextRules)
        setMetrics(nextMetrics)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Cloud details failed.')
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  async function power(action: CloudMachinePowerAction) {
    const azureDeallocateWarning = selected?.provider === 'azure' && action === 'stop'
      ? '\n\nAzure will deallocate this VM. A dynamically assigned public IP may change when it starts again.'
      : ''
    if (!selected || !window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${selected.name}?${azureDeallocateWarning}`)) return
    setMutating(true)
    setError(undefined)
    try {
      await changeCloudMachinePower(selected.id, action)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Power action failed.')
    } finally {
      setMutating(false)
    }
  }

  async function addRule() {
    if (!selected) return
    setMutating(true)
    setError(undefined)
    try {
      const firewallId = selected.firewalls.some((firewall) => firewall.id === ruleInput.firewallId)
        ? ruleInput.firewallId
        : selected.firewalls[0]?.id ?? ''
      setRules(await addCloudFirewallRule(selected.id, { ...ruleInput, firewallId }))
      setShowAddRule(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Firewall change failed.')
    } finally {
      setMutating(false)
    }
  }

  async function removeRule(rule: CloudFirewallRule) {
    if (!selected || !rule.removable || !window.confirm(`Remove ${formatFirewallRule(rule)} from ${rule.source}?`)) return
    setMutating(true)
    setError(undefined)
    try {
      setRules(await removeCloudFirewallRule(selected.id, rule.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Firewall change failed.')
    } finally {
      setMutating(false)
    }
  }

  const cpu = latestMetric(metrics, 'cpuPercent')
  const networkIn = latestMetric(metrics, 'networkInBytes')
  const networkOut = latestMetric(metrics, 'networkOutBytes')

  return (
    <section className="@container rounded border border-slate-200 bg-white" data-testid="cloud-machines-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Cloud access</h3>
          <p className="text-xs text-slate-500">Existing machines only · inventory, metrics, firewalls, and power controls</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </header>
      {error ? <p className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p> : null}
      {inventory.warnings.length ? (
        <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {inventory.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}
      {loading && !inventory.machines.length ? (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" /> Discovering existing cloud machines…</div>
      ) : inventory.machines.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate-500">Import and test a cloud credential in Grove settings to discover existing machines. No resource-creation operation is available.</p>
      ) : (
        <div className="grid min-h-[260px] @min-[700px]:grid-cols-[220px_1fr]">
          <div className="border-b border-slate-200 @min-[700px]:border-b-0 @min-[700px]:border-r">
            {inventory.machines.map((machine) => (
              <button key={machine.id} type="button" onClick={() => {
                setSelectedId(machine.id)
                setRuleInput((current) => ({ ...current, firewallId: machine.firewalls[0]?.id ?? '' }))
              }} className={`block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 ${selectedId === machine.id ? 'bg-slate-50' : ''}`}>
                <span className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm text-slate-900">{machine.name}</strong>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${stateTone(machine.state)}`}>{machine.state}</span>
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{machine.location} · {machine.publicIp ?? machine.privateIp ?? 'no address'}</span>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="min-w-0 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="font-semibold text-slate-950">{selected.name}</h4>
                  <p className="break-all text-xs text-slate-500">{selected.machineType ?? 'unknown type'} · {selected.zone ?? selected.location} · {selected.imageId ?? 'unknown image'}</p>
                </div>
                <div className="flex gap-1">
                  <button type="button" title="Start" disabled={mutating || selected.state === 'running'} onClick={() => void power('start')} className="icon-action"><Play className="h-3.5 w-3.5" /></button>
                  <button type="button" title="Stop" disabled={mutating || selected.state === 'stopped'} onClick={() => void power('stop')} className="icon-action"><Square className="h-3.5 w-3.5" /></button>
                  <button type="button" title="Reboot" disabled={mutating || selected.state !== 'running'} onClick={() => void power('reboot')} className="icon-action"><RotateCw className="h-3.5 w-3.5" /></button>
                </div>
              </div>

              <div className="mt-3 grid gap-2 @min-[480px]:grid-cols-3">
                <div className="rounded border border-slate-200 p-2"><span className="flex items-center gap-1 text-[10px] uppercase text-slate-500"><Activity className="h-3 w-3" /> CPU</span><strong className="mt-1 block text-sm">{cpu === undefined ? '—' : `${cpu.toFixed(1)}%`}</strong></div>
                <div className="rounded border border-slate-200 p-2"><span className="text-[10px] uppercase text-slate-500">Network in</span><strong className="mt-1 block text-sm">{networkIn === undefined ? '—' : `${Math.round(networkIn / 1024)} KB`}</strong></div>
                <div className="rounded border border-slate-200 p-2"><span className="text-[10px] uppercase text-slate-500">Network out</span><strong className="mt-1 block text-sm">{networkOut === undefined ? '—' : `${Math.round(networkOut / 1024)} KB`}</strong></div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <h5 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500"><Shield className="h-3.5 w-3.5" /> Firewall rules</h5>
                <button type="button" disabled={!selected.firewalls.length || mutating} onClick={() => setShowAddRule((value) => !value)} className="inline-flex h-7 items-center gap-1 rounded border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Plus className="h-3 w-3" /> Add ingress</button>
              </div>
              {showAddRule ? (
                <div className="mt-2 grid gap-2 rounded border border-slate-200 bg-slate-50 p-2 @min-[480px]:grid-cols-2">
                  <label className="grid gap-1 text-xs text-slate-600">Firewall<select value={selected.firewalls.some((firewall) => firewall.id === ruleInput.firewallId) ? ruleInput.firewallId : selected.firewalls[0]?.id ?? ''} onChange={(event) => setRuleInput((current) => ({ ...current, firewallId: event.target.value }))} className="field-control">{selected.firewalls.map((firewall) => <option key={firewall.id} value={firewall.id}>{firewall.name}</option>)}</select></label>
                  <label className="grid gap-1 text-xs text-slate-600">Protocol<select value={ruleInput.protocol} onChange={(event) => setRuleInput((current) => ({ ...current, protocol: event.target.value as 'tcp' | 'udp' }))} className="field-control"><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
                  <label className="grid gap-1 text-xs text-slate-600">From port<input type="number" min={0} max={65535} value={ruleInput.fromPort} onChange={(event) => setRuleInput((current) => ({ ...current, fromPort: Number(event.target.value) }))} className="field-control" /></label>
                  <label className="grid gap-1 text-xs text-slate-600">To port<input type="number" min={0} max={65535} value={ruleInput.toPort} onChange={(event) => setRuleInput((current) => ({ ...current, toPort: Number(event.target.value) }))} className="field-control" /></label>
                  <label className="grid gap-1 text-xs text-slate-600">Source CIDR<input value={ruleInput.cidr} onChange={(event) => setRuleInput((current) => ({ ...current, cidr: event.target.value }))} className="field-control" /></label>
                  <label className="grid gap-1 text-xs text-slate-600">Description<input value={ruleInput.description ?? ''} onChange={(event) => setRuleInput((current) => ({ ...current, description: event.target.value }))} className="field-control" /></label>
                  <div className="flex justify-end gap-1 @min-[480px]:col-span-2"><button type="button" onClick={() => setShowAddRule(false)} className="h-8 rounded px-2 text-xs text-slate-600">Cancel</button><button type="button" disabled={mutating} onClick={() => void addRule()} className="h-8 rounded bg-slate-950 px-3 text-xs font-medium text-white disabled:opacity-50">Add rule</button></div>
                </div>
              ) : null}
              {detailLoading ? (
                <p className="mt-2 text-xs text-slate-500">Loading firewall rules and metrics…</p>
              ) : (
                <div className="mt-2 max-h-48 overflow-auto rounded border border-slate-200">
                  {rules.length ? rules.map((rule) => (
                    <div key={rule.id} className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5 text-xs last:border-b-0">
                      <span className={`rounded px-1.5 py-0.5 ${rule.direction === 'ingress' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{rule.direction}</span>
                      <span className="font-mono text-slate-700">{formatFirewallRule(rule)}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-500">{rule.source} · {rule.firewallName}</span>
                      {rule.removable ? <button type="button" aria-label={`Remove ${formatFirewallRule(rule)} rule`} disabled={mutating} onClick={() => void removeRule(rule)} className="rounded p-1 text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button> : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title={rule.readOnlyReason}>Read only</span>}
                    </div>
                  )) : <p className="px-2 py-3 text-xs text-slate-500">No firewall rules returned.</p>}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
