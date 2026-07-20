import { createHash } from 'node:crypto'
import type {
  CloudFirewallRule,
  CloudFirewallRuleInput,
  CloudInventory,
  CloudMachine,
  CloudMachineMetrics,
  CloudMachinePowerAction,
  CredentialProfile,
  CredentialProfileKind,
} from '../src/types'
import type { CredentialManager } from './credentialManager'
import { AlicloudCloudAdapter } from './alicloudCloudAdapter'
import { AwsCloudAdapter } from './awsCloudAdapter'

export interface CloudProviderContext {
  profile: CredentialProfile
  secrets: Record<string, string>
}

export interface ProviderMachine {
  nativeId: string
  location: string
  zone?: string
  name: string
  state: CloudMachine['state']
  publicIp?: string
  privateIp?: string
  machineType?: string
  imageId?: string
  launchedAt?: string
  monitoring?: string
  vpcId?: string
  subnetId?: string
  networkType?: string
  maxBandwidthInMbps?: number
  maxBandwidthOutMbps?: number
  firewalls: Array<{ nativeId: string; name: string }>
}

export interface ProviderFirewallRule {
  nativeId: string
  firewallNativeId: string
  firewallName: string
  direction: CloudFirewallRule['direction']
  protocol: string
  fromPort?: number
  toPort?: number
  source: string
  description?: string
}

export type ProviderMachineMetrics = Omit<CloudMachineMetrics, 'machineId'>

export interface CloudProviderAdapter {
  listMachines(context: CloudProviderContext): Promise<{ machines: ProviderMachine[]; warnings: string[] }>
  listFirewallRules(context: CloudProviderContext, machine: ProviderMachine): Promise<ProviderFirewallRule[]>
  addFirewallRule(
    context: CloudProviderContext,
    machine: ProviderMachine,
    firewallNativeId: string,
    input: Omit<CloudFirewallRuleInput, 'firewallId'>,
  ): Promise<void>
  removeFirewallRule(
    context: CloudProviderContext,
    machine: ProviderMachine,
    firewallNativeId: string,
    ruleNativeId: string,
  ): Promise<void>
  getMetrics(context: CloudProviderContext, machine: ProviderMachine, hours: number): Promise<ProviderMachineMetrics>
  power(context: CloudProviderContext, machine: ProviderMachine, action: CloudMachinePowerAction): Promise<void>
}

export interface CloudControlService {
  listMachines(profileId?: string): Promise<CloudInventory>
  listFirewallRules(machineId: string): Promise<CloudFirewallRule[]>
  addFirewallRule(machineId: string, input: CloudFirewallRuleInput): Promise<CloudFirewallRule[]>
  removeFirewallRule(machineId: string, ruleId: string): Promise<CloudFirewallRule[]>
  getMetrics(machineId: string, hours?: number): Promise<CloudMachineMetrics>
  power(machineId: string, action: CloudMachinePowerAction): Promise<CloudMachine>
}

interface MachineReference {
  context: CloudProviderContext
  adapter: CloudProviderAdapter
  machine: ProviderMachine
}

interface FirewallReference extends MachineReference {
  firewallNativeId: string
}

interface RuleReference extends FirewallReference {
  ruleNativeId: string
  direction: CloudFirewallRule['direction']
}

function opaqueId(prefix: string, ...parts: string[]) {
  const digest = createHash('sha256').update(parts.join('\0'), 'utf8').digest('base64url').slice(0, 22)
  return `${prefix}-${digest}`
}

function clampHours(hours: number | undefined) {
  return Math.min(Math.max(Number(hours) || 1, 1), 168)
}

export class CloudProviderManager implements CloudControlService {
  private readonly credentials: CredentialManager
  private readonly adapters: Partial<Record<CredentialProfileKind, CloudProviderAdapter>>
  private readonly machines = new Map<string, MachineReference>()
  private readonly firewalls = new Map<string, FirewallReference>()
  private readonly rules = new Map<string, RuleReference>()

  constructor(
    credentials: CredentialManager,
    adapters: Partial<Record<CredentialProfileKind, CloudProviderAdapter>> = {
      aws: new AwsCloudAdapter(),
      alicloud: new AlicloudCloudAdapter(),
    },
  ) {
    this.credentials = credentials
    this.adapters = adapters
  }

  async listMachines(profileId?: string): Promise<CloudInventory> {
    // Inventory is the authority for opaque references. Drop references that are no longer
    // discoverable so deleted profiles/machines cannot remain operable through stale ids.
    if (profileId) {
      for (const [id, reference] of this.machines) {
        if (reference.context.profile.id === profileId) this.machines.delete(id)
      }
      for (const [id, reference] of this.firewalls) {
        if (reference.context.profile.id === profileId) this.firewalls.delete(id)
      }
      for (const [id, reference] of this.rules) {
        if (reference.context.profile.id === profileId) this.rules.delete(id)
      }
    } else {
      this.machines.clear()
      this.firewalls.clear()
      this.rules.clear()
    }
    const profiles = profileId
      ? [this.credentials.profile(profileId)]
      : this.credentials.list().filter((profile) => Boolean(this.adapters[profile.kind]))
    const machines: CloudMachine[] = []
    const warnings: string[] = []

    for (const profile of profiles) {
      const adapter = this.adapters[profile.kind]
      if (!adapter) {
        warnings.push(`${profile.name}: existing-resource control is not available yet.`)
        continue
      }
      const context = { profile, secrets: this.credentials.secrets(profile.id) }
      try {
        const result = await adapter.listMachines(context)
        warnings.push(...result.warnings.map((warning) => `${profile.name}: ${warning}`))
        for (const machine of result.machines) {
          const id = opaqueId('cloud-machine', profile.id, machine.location, machine.nativeId)
          const reference = { context, adapter, machine }
          this.machines.set(id, reference)
          const firewalls = machine.firewalls.map((firewall) => {
            const firewallId = opaqueId('cloud-firewall', profile.id, machine.location, firewall.nativeId)
            this.firewalls.set(firewallId, { ...reference, firewallNativeId: firewall.nativeId })
            return { id: firewallId, name: firewall.name }
          })
          machines.push({
            id,
            provider: profile.kind as CloudMachine['provider'],
            credentialProfileId: profile.id,
            credentialProfileName: profile.name,
            name: machine.name,
            location: machine.location,
            zone: machine.zone,
            state: machine.state,
            publicIp: machine.publicIp,
            privateIp: machine.privateIp,
            machineType: machine.machineType,
            imageId: machine.imageId,
            launchedAt: machine.launchedAt,
            monitoring: machine.monitoring,
            vpcId: machine.vpcId,
            subnetId: machine.subnetId,
            networkType: machine.networkType,
            maxBandwidthInMbps: machine.maxBandwidthInMbps,
            maxBandwidthOutMbps: machine.maxBandwidthOutMbps,
            firewalls,
          })
        }
      } catch (error) {
        warnings.push(`${profile.name}: ${error instanceof Error ? error.message : 'inventory failed'}`)
      }
    }

    return {
      machines: machines.sort((left, right) => left.name.localeCompare(right.name)),
      scannedAt: new Date().toISOString(),
      warnings,
    }
  }

  async listFirewallRules(machineId: string): Promise<CloudFirewallRule[]> {
    const reference = await this.requireMachine(machineId)
    const rules = await reference.adapter.listFirewallRules(reference.context, reference.machine)
    return rules.map((rule) => {
      const firewallId = opaqueId(
        'cloud-firewall',
        reference.context.profile.id,
        reference.machine.location,
        rule.firewallNativeId,
      )
      const ruleId = opaqueId(
        'cloud-rule',
        reference.context.profile.id,
        reference.machine.location,
        rule.nativeId,
      )
      const firewallReference = { ...reference, firewallNativeId: rule.firewallNativeId }
      this.firewalls.set(firewallId, firewallReference)
      this.rules.set(ruleId, { ...firewallReference, ruleNativeId: rule.nativeId, direction: rule.direction })
      return {
        id: ruleId,
        firewallId,
        firewallName: rule.firewallName,
        direction: rule.direction,
        protocol: rule.protocol,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        source: rule.source,
        description: rule.description,
      }
    })
  }

  async addFirewallRule(machineId: string, input: CloudFirewallRuleInput) {
    this.validateFirewallInput(input)
    const machine = await this.requireMachine(machineId)
    const firewall = this.firewalls.get(input.firewallId)
    if (!firewall || firewall.context.profile.id !== machine.context.profile.id || firewall.machine.nativeId !== machine.machine.nativeId) {
      throw new Error('The selected firewall does not belong to this cloud machine.')
    }
    await machine.adapter.addFirewallRule(machine.context, machine.machine, firewall.firewallNativeId, {
      protocol: input.protocol,
      fromPort: input.fromPort,
      toPort: input.toPort,
      cidr: input.cidr,
      description: input.description,
    })
    return this.listFirewallRules(machineId)
  }

  async removeFirewallRule(machineId: string, ruleId: string) {
    const machine = await this.requireMachine(machineId)
    if (!this.rules.has(ruleId)) {
      await this.listFirewallRules(machineId)
    }
    const rule = this.rules.get(ruleId)
    if (!rule || rule.context.profile.id !== machine.context.profile.id || rule.machine.nativeId !== machine.machine.nativeId) {
      throw new Error('The selected firewall rule does not belong to this cloud machine.')
    }
    if (rule.direction !== 'ingress') {
      throw new Error('Only ingress firewall rules can be removed by Grove.')
    }
    await machine.adapter.removeFirewallRule(
      machine.context,
      machine.machine,
      rule.firewallNativeId,
      rule.ruleNativeId,
    )
    return this.listFirewallRules(machineId)
  }

  async getMetrics(machineId: string, hours?: number): Promise<CloudMachineMetrics> {
    const reference = await this.requireMachine(machineId)
    const metrics = await reference.adapter.getMetrics(reference.context, reference.machine, clampHours(hours))
    return { machineId, ...metrics }
  }

  async power(machineId: string, action: CloudMachinePowerAction): Promise<CloudMachine> {
    const reference = await this.requireMachine(machineId)
    await reference.adapter.power(reference.context, reference.machine, action)
    const inventory = await this.listMachines(reference.context.profile.id)
    const refreshed = inventory.machines.find((machine) => machine.id === machineId)
    if (!refreshed) {
      throw new Error('Cloud machine was not returned after the power action.')
    }
    return refreshed
  }

  private async requireMachine(machineId: string) {
    if (!this.machines.has(machineId)) {
      await this.listMachines()
    }
    const reference = this.machines.get(machineId)
    if (!reference) {
      throw new Error('Cloud machine not found. Refresh cloud inventory and try again.')
    }
    // Resolve the profile and secret on every operation. Credential deletion takes effect
    // immediately, while credential rotation does not require a backend restart or rescan.
    const profile = this.credentials.profile(reference.context.profile.id)
    const current = { ...reference, context: { profile, secrets: this.credentials.secrets(profile.id) } }
    this.machines.set(machineId, current)
    return current
  }

  private validateFirewallInput(input: CloudFirewallRuleInput) {
    if (!input.firewallId.trim()) throw new Error('Select a firewall.')
    if (!Number.isInteger(input.fromPort) || !Number.isInteger(input.toPort)) throw new Error('Ports must be integers.')
    if (input.fromPort < 1 || input.toPort > 65535 || input.fromPort > input.toPort) {
      throw new Error('Port range must be between 1 and 65535.')
    }
    if (!/^[0-9a-f:.]+\/\d{1,3}$/i.test(input.cidr.trim())) {
      throw new Error('Provide an IPv4 or IPv6 CIDR range.')
    }
  }
}
