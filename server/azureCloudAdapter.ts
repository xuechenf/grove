import { randomBytes } from 'node:crypto'
import { ComputeManagementClient, type VirtualMachine } from '@azure/arm-compute'
import {
  NetworkManagementClient,
  type NetworkInterface,
  type NetworkSecurityGroup,
  type SecurityRule,
} from '@azure/arm-network'
import { MonitorClient, type Response as AzureMetricsResponse } from '@azure/arm-monitor'
import { ClientSecretCredential } from '@azure/identity'
import type { CloudMachinePowerAction, CloudMetricPoint } from '../src/types'
import type {
  CloudProviderAdapter,
  CloudProviderContext,
  ProviderFirewallRule,
  ProviderMachine,
  ProviderMachineMetrics,
} from './cloudProvider'

const VM_METRIC_NAMESPACE = 'Microsoft.Compute/virtualMachines'
const AZURE_CONCURRENCY = 5

interface AzureClients {
  compute: ComputeManagementClient
  network: NetworkManagementClient
  monitor: MonitorClient
}

interface AzureErrorShape {
  statusCode?: number
  code?: string
  message?: string
  details?: { error?: { code?: string; message?: string } }
}

function azureClients(context: CloudProviderContext): AzureClients {
  const tenantId = context.profile.configuration.tenantId
  const clientId = context.profile.configuration.clientId
  const subscriptionId = context.profile.configuration.subscriptionId
  const clientSecret = context.secrets.clientSecret
  if (!tenantId || !clientId || !subscriptionId || !clientSecret) {
    throw new Error('The Azure credential profile is incomplete.')
  }
  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret)
  return {
    compute: new ComputeManagementClient(credential, subscriptionId),
    network: new NetworkManagementClient(credential, subscriptionId),
    monitor: new MonitorClient(credential, subscriptionId),
  }
}

function azureErrorShape(error: unknown) {
  return error && typeof error === 'object' ? error as AzureErrorShape : {}
}

/** Normalize provider failures without returning request bodies or credential-bearing details. */
export function normalizeAzureError(error: unknown, operation: string, requiredRole?: string) {
  const details = azureErrorShape(error)
  const status = details.statusCode
  const code = details.code || details.details?.error?.code || (error instanceof Error ? error.name : undefined)
  if (status === 401 || /AuthenticationFailed|Unauthorized|Credential/i.test(code ?? '')) {
    return new Error(`Azure authentication failed while ${operation}. Check the tenant ID, client ID, and client secret.`)
  }
  if (status === 403 || /AuthorizationFailed|Forbidden/i.test(code ?? '')) {
    const role = requiredRole ? ` The service principal needs the ${requiredRole} role at the subscription scope.` : ''
    return new Error(`Azure denied permission while ${operation}.${role}`)
  }
  if (status === 404 || /NotFound/i.test(code ?? '')) {
    return new Error(`Azure could not find the resource while ${operation}. Refresh cloud inventory and try again.`)
  }
  if (status === 429 || /TooManyRequests|Throttl/i.test(code ?? '')) {
    return new Error(`Azure throttled the request while ${operation}. Wait briefly and try again.`)
  }
  if (status && status >= 500) {
    return new Error(`Azure is temporarily unavailable while ${operation} (HTTP ${status}).`)
  }
  return new Error(`Azure failed while ${operation}${code ? ` (${code}).` : '.'}`)
}

function resourceSegments(resourceId: string) {
  return resourceId.split('/').filter(Boolean)
}

function segmentAfter(resourceId: string, marker: string) {
  const segments = resourceSegments(resourceId)
  const index = segments.findIndex((segment) => segment.toLowerCase() === marker.toLowerCase())
  return index >= 0 ? segments[index + 1] : undefined
}

function resourceGroup(resourceId: string) {
  return segmentAfter(resourceId, 'resourceGroups')
}

function resourceName(resourceId: string, type: string) {
  return segmentAfter(resourceId, type)
}

function virtualNetworkId(subnetId: string) {
  const segments = resourceSegments(subnetId)
  const subnetIndex = segments.findIndex((segment) => segment.toLowerCase() === 'subnets')
  return subnetIndex > 0 ? `/${segments.slice(0, subnetIndex).join('/')}` : undefined
}

function imageId(vm: VirtualMachine) {
  const image = vm.storageProfile?.imageReference
  if (!image) return undefined
  if (image.id) return image.id
  const urn = [image.publisher, image.offer, image.sku, image.exactVersion || image.version].filter(Boolean)
  return urn.length ? urn.join(':') : undefined
}

function machineState(powerState: string | undefined, provisioningState?: string): ProviderMachine['state'] {
  switch (powerState?.toLowerCase()) {
    case 'running':
      return 'running'
    case 'starting':
    case 'creating':
      return 'pending'
    case 'stopping':
    case 'deallocating':
      return 'stopping'
    case 'stopped':
    case 'deallocated':
      return 'stopped'
    case 'restarting':
      return 'rebooting'
    default:
      return provisioningState?.toLowerCase() === 'creating' ? 'pending' : 'unknown'
  }
}

async function withConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function addFirewall(
  firewalls: Map<string, { nativeId: string; name: string }>,
  id: string | undefined,
) {
  if (!id) return
  const key = id.toLowerCase()
  if (!firewalls.has(key)) firewalls.set(key, { nativeId: id, name: resourceName(id, 'networkSecurityGroups') || id })
}

async function enrichMachine(
  clients: AzureClients,
  vm: VirtualMachine,
  warnings: string[],
): Promise<ProviderMachine | undefined> {
  if (!vm.id || !vm.name || !vm.location) return undefined
  const vmResourceGroup = resourceGroup(vm.id)
  if (!vmResourceGroup) return undefined
  let powerState: string | undefined
  try {
    const instance = await clients.compute.virtualMachines.instanceView(vmResourceGroup, vm.name)
    powerState = instance.statuses?.find((status) => status.code?.toLowerCase().startsWith('powerstate/'))?.code?.split('/')[1]
  } catch (error) {
    warnings.push(`${vm.name}: ${normalizeAzureError(error, 'reading VM runtime state', 'Monitoring Reader').message}`)
  }

  const firewalls = new Map<string, { nativeId: string; name: string }>()
  const subnetIds = new Set<string>()
  const nics: NetworkInterface[] = []
  for (const reference of vm.networkProfile?.networkInterfaces ?? []) {
    if (!reference.id) continue
    const nicGroup = resourceGroup(reference.id)
    const nicName = resourceName(reference.id, 'networkInterfaces')
    if (!nicGroup || !nicName) continue
    try {
      const nic = await clients.network.networkInterfaces.get(nicGroup, nicName)
      nics.push(nic)
      addFirewall(firewalls, nic.networkSecurityGroup?.id)
      for (const ipConfiguration of nic.ipConfigurations ?? []) {
        if (ipConfiguration.subnet?.id) subnetIds.add(ipConfiguration.subnet.id)
      }
    } catch (error) {
      warnings.push(`${vm.name}: ${normalizeAzureError(error, `reading network interface ${nicName}`, 'Monitoring Reader').message}`)
    }
  }

  for (const subnetId of subnetIds) {
    const subnetGroup = resourceGroup(subnetId)
    const vnetName = resourceName(subnetId, 'virtualNetworks')
    const subnetName = resourceName(subnetId, 'subnets')
    if (!subnetGroup || !vnetName || !subnetName) continue
    try {
      const subnet = await clients.network.subnets.get(subnetGroup, vnetName, subnetName)
      addFirewall(firewalls, subnet.networkSecurityGroup?.id)
    } catch (error) {
      warnings.push(`${vm.name}: ${normalizeAzureError(error, `reading subnet ${subnetName}`, 'Monitoring Reader').message}`)
    }
  }

  const orderedNics = [...nics].sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
  const ipConfigurations = orderedNics.flatMap((nic) => [...(nic.ipConfigurations ?? [])]
    .sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary))))
  const primaryIp = ipConfigurations[0]
  const publicIpConfiguration = ipConfigurations.find((configuration) =>
    Boolean(configuration.publicIPAddress?.ipAddress || configuration.publicIPAddress?.id),
  )
  let publicIp = publicIpConfiguration?.publicIPAddress?.ipAddress
  const publicIpReference = publicIpConfiguration?.publicIPAddress?.id
  if (!publicIp && publicIpReference) {
    const publicIpGroup = resourceGroup(publicIpReference)
    const publicIpName = resourceName(publicIpReference, 'publicIPAddresses')
    if (publicIpGroup && publicIpName) {
      try {
        publicIp = (await clients.network.publicIPAddresses.get(publicIpGroup, publicIpName)).ipAddress
      } catch (error) {
        warnings.push(`${vm.name}: ${normalizeAzureError(error, `reading public IP ${publicIpName}`, 'Monitoring Reader').message}`)
      }
    }
  }
  const subnetId = primaryIp?.subnet?.id || [...subnetIds][0]
  return {
    nativeId: vm.id,
    location: vm.location,
    zone: vm.zones?.join(', '),
    name: vm.name,
    state: machineState(powerState, vm.provisioningState),
    publicIp,
    privateIp: primaryIp?.privateIPAddress,
    machineType: vm.hardwareProfile?.vmSize,
    imageId: imageId(vm),
    launchedAt: vm.timeCreated?.toISOString(),
    monitoring: 'Azure Monitor platform metrics',
    vpcId: subnetId ? virtualNetworkId(subnetId) : undefined,
    subnetId,
    networkType: 'VNet',
    firewalls: [...firewalls.values()],
  }
}

function parsePortRange(rule: SecurityRule) {
  const value = rule.destinationPortRange || rule.destinationPortRanges?.[0]
  if (!value || value === '*') return {}
  const match = value.match(/^(\d+)(?:-(\d+))?$/)
  return match ? { fromPort: Number(match[1]), toPort: Number(match[2] || match[1]) } : {}
}

function ruleSource(rule: SecurityRule) {
  const prefixes = rule.sourceAddressPrefixes?.length ? rule.sourceAddressPrefixes : [rule.sourceAddressPrefix]
  const sources = prefixes.filter((value): value is string => Boolean(value))
  const applicationGroups = (rule.sourceApplicationSecurityGroups ?? []).flatMap((group) => group.id ? [group.id] : [])
  return [...sources, ...applicationGroups].join(', ') || '*'
}

function providerRule(
  firewall: { nativeId: string; name: string },
  rule: SecurityRule,
  index: number,
  isDefault: boolean,
): ProviderFirewallRule {
  const direction = rule.direction?.toLowerCase() === 'outbound' ? 'egress' : 'ingress'
  const removable = !isDefault && direction === 'ingress' && Boolean(rule.name)
  const metadata = [
    rule.access?.toLowerCase() === 'deny' ? 'Deny' : undefined,
    isDefault ? 'Azure default rule' : undefined,
    rule.priority === undefined ? undefined : `priority ${rule.priority}`,
    rule.description,
  ].filter(Boolean).join(' · ')
  return {
    nativeId: rule.name || `${firewall.nativeId}:${isDefault ? 'default' : 'custom'}:${index}`,
    firewallNativeId: firewall.nativeId,
    firewallName: firewall.name,
    direction,
    protocol: rule.protocol?.toLowerCase() || 'all',
    ...parsePortRange(rule),
    source: ruleSource(rule),
    description: metadata || undefined,
    removable,
    readOnlyReason: removable
      ? undefined
      : isDefault ? 'Azure default NSG rules cannot be removed.' : direction === 'egress'
        ? 'Outbound rules are read-only in Grove.' : 'Azure did not return a removable rule name.',
  }
}

function metric(clientResult: AzureMetricsResponse | undefined, name: string) {
  return clientResult?.value.find((candidate) => candidate.name.value === name)
}

function metricPoints(result: AzureMetricsResponse | undefined, name: string, aggregation: 'average' | 'total') {
  const values = new Map<string, number[]>()
  for (const timeSeries of metric(result, name)?.timeseries ?? []) {
    for (const point of timeSeries.data ?? []) {
      const value = aggregation === 'average' ? point.average : point.total
      if (value === undefined) continue
      const timestamp = point.timeStamp.toISOString()
      values.set(timestamp, [...(values.get(timestamp) ?? []), value])
    }
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([timestamp, samples]): CloudMetricPoint => ({
      timestamp,
      value: aggregation === 'average'
        ? samples.reduce((sum, value) => sum + value, 0) / samples.length
        : samples.reduce((sum, value) => sum + value, 0),
    }))
}

async function azureMetrics(clients: AzureClients, machine: ProviderMachine, hours: number): Promise<ProviderMachineMetrics> {
  const end = new Date()
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
  const periodSeconds = hours <= 6 ? 60 : 300
  const interval = periodSeconds === 60 ? 'PT1M' : 'PT5M'
  try {
    const [cpuResult, networkResult] = await Promise.all([
      clients.monitor.metrics.list(machine.nativeId, {
        timespan: `${start.toISOString()}/${end.toISOString()}`,
        interval,
        metricnamespace: VM_METRIC_NAMESPACE,
        metricnames: 'Percentage CPU',
        aggregation: 'Average',
      }),
      clients.monitor.metrics.list(machine.nativeId, {
        timespan: `${start.toISOString()}/${end.toISOString()}`,
        interval,
        metricnamespace: VM_METRIC_NAMESPACE,
        metricnames: 'Network In Total,Network Out Total',
        aggregation: 'Total',
      }),
    ])
    return {
      periodSeconds,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      series: [
        { key: 'cpuPercent', label: 'CPU utilization', unit: 'Percent', points: metricPoints(cpuResult, 'Percentage CPU', 'average') },
        { key: 'networkInBytes', label: 'Network in', unit: 'Bytes', points: metricPoints(networkResult, 'Network In Total', 'total') },
        { key: 'networkOutBytes', label: 'Network out', unit: 'Bytes', points: metricPoints(networkResult, 'Network Out Total', 'total') },
      ],
    }
  } catch (error) {
    throw normalizeAzureError(error, 'querying Azure Monitor metrics', 'Monitoring Reader')
  }
}

export class AzureCloudAdapter implements CloudProviderAdapter {
  async listMachines(context: CloudProviderContext) {
    const clients = azureClients(context)
    const vms: VirtualMachine[] = []
    try {
      for await (const vm of clients.compute.virtualMachines.listAll()) vms.push(vm)
    } catch (error) {
      throw normalizeAzureError(error, 'listing virtual machines', 'Monitoring Reader')
    }
    const warnings: string[] = []
    const machines = (await withConcurrency(vms, AZURE_CONCURRENCY, (vm) => enrichMachine(clients, vm, warnings)))
      .filter((machine): machine is ProviderMachine => Boolean(machine))
    return { machines, warnings }
  }

  async listFirewallRules(context: CloudProviderContext, machine: ProviderMachine) {
    const { network } = azureClients(context)
    const output: ProviderFirewallRule[] = []
    for (const firewall of machine.firewalls) {
      const group = resourceGroup(firewall.nativeId)
      const name = resourceName(firewall.nativeId, 'networkSecurityGroups')
      if (!group || !name) continue
      let nsg: NetworkSecurityGroup
      try {
        nsg = await network.networkSecurityGroups.get(group, name)
      } catch (error) {
        throw normalizeAzureError(error, `reading NSG ${name}`, 'Monitoring Reader')
      }
      for (const [index, rule] of (nsg.securityRules ?? []).entries()) {
        output.push(providerRule(firewall, rule, index, false))
      }
      for (const [index, rule] of (nsg.defaultSecurityRules ?? []).entries()) {
        output.push(providerRule(firewall, rule, index, true))
      }
    }
    return output
  }

  async addFirewallRule(
    context: CloudProviderContext,
    machine: ProviderMachine,
    firewallNativeId: string,
    input: { protocol: 'tcp' | 'udp'; fromPort: number; toPort: number; cidr: string; description?: string },
  ) {
    if (!machine.firewalls.some((firewall) => firewall.nativeId.toLowerCase() === firewallNativeId.toLowerCase())) {
      throw new Error('The selected NSG is not attached to this Azure VM.')
    }
    const { network } = azureClients(context)
    const group = resourceGroup(firewallNativeId)
    const name = resourceName(firewallNativeId, 'networkSecurityGroups')
    if (!group || !name) throw new Error('The selected Azure NSG resource ID is invalid.')
    try {
      const nsg = await network.networkSecurityGroups.get(group, name)
      const used = new Set([...(nsg.securityRules ?? []), ...(nsg.defaultSecurityRules ?? [])]
        .flatMap((rule) => rule.priority === undefined ? [] : [rule.priority]))
      let priority: number | undefined
      for (let candidate = 3000; candidate <= 3999; candidate += 1) {
        if (!used.has(candidate)) {
          priority = candidate
          break
        }
      }
      if (priority === undefined) throw new Error('Azure NSG priorities 3000-3999 are all in use.')
      const ruleName = `grove-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
      const poller = network.securityRules.createOrUpdate(group, name, ruleName, {
        protocol: input.protocol === 'tcp' ? 'Tcp' : 'Udp',
        sourcePortRange: '*',
        destinationPortRange: input.fromPort === input.toPort ? String(input.fromPort) : `${input.fromPort}-${input.toPort}`,
        sourceAddressPrefix: input.cidr,
        destinationAddressPrefix: '*',
        access: 'Allow',
        priority,
        direction: 'Inbound',
        description: (input.description?.trim() || 'Managed by Grove').slice(0, 140),
      })
      await poller.pollUntilDone()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Azure NSG priorities')) throw error
      throw normalizeAzureError(error, `adding an ingress rule to NSG ${name}`, 'Network Contributor')
    }
  }

  async removeFirewallRule(
    context: CloudProviderContext,
    machine: ProviderMachine,
    firewallNativeId: string,
    ruleNativeId: string,
  ) {
    if (!machine.firewalls.some((firewall) => firewall.nativeId.toLowerCase() === firewallNativeId.toLowerCase())) {
      throw new Error('The selected NSG is not attached to this Azure VM.')
    }
    const { network } = azureClients(context)
    const group = resourceGroup(firewallNativeId)
    const name = resourceName(firewallNativeId, 'networkSecurityGroups')
    if (!group || !name || ruleNativeId.includes(':')) throw new Error('The selected Azure NSG rule is not removable.')
    try {
      const poller = network.securityRules.delete(group, name, ruleNativeId)
      await poller.pollUntilDone()
    } catch (error) {
      throw normalizeAzureError(error, `removing an ingress rule from NSG ${name}`, 'Network Contributor')
    }
  }

  async getMetrics(context: CloudProviderContext, machine: ProviderMachine, hours: number) {
    return azureMetrics(azureClients(context), machine, hours)
  }

  async power(context: CloudProviderContext, machine: ProviderMachine, action: CloudMachinePowerAction) {
    const { compute } = azureClients(context)
    const group = resourceGroup(machine.nativeId)
    const name = resourceName(machine.nativeId, 'virtualMachines')
    if (!group || !name) throw new Error('The selected Azure VM resource ID is invalid.')
    try {
      const poller = action === 'start'
        ? compute.virtualMachines.start(group, name)
        : action === 'stop'
          ? compute.virtualMachines.deallocate(group, name)
          : compute.virtualMachines.restart(group, name)
      await poller.pollUntilDone()
    } catch (error) {
      throw normalizeAzureError(error, `${action === 'stop' ? 'deallocating' : `${action}ing`} VM ${name}`, 'Virtual Machine Contributor')
    }
  }
}

export async function verifyAzureCapabilities(context: CloudProviderContext) {
  const clients = azureClients(context)
  let vmCount = 0
  let firstVm: VirtualMachine | undefined
  try {
    for await (const vm of clients.compute.virtualMachines.listAll()) {
      firstVm ??= vm
      vmCount += 1
    }
  } catch (error) {
    throw normalizeAzureError(error, 'verifying VM read access', 'Monitoring Reader')
  }
  let nsgCount = 0
  try {
    for await (const nsg of clients.network.networkSecurityGroups.listAll()) {
      void nsg
      nsgCount += 1
    }
  } catch (error) {
    throw normalizeAzureError(error, 'verifying NSG read access', 'Monitoring Reader')
  }
  let metricsVerified = false
  if (firstVm?.id && firstVm.location) {
    await azureMetrics(clients, {
      nativeId: firstVm.id,
      location: firstVm.location,
      name: firstVm.name || firstVm.id,
      state: 'unknown',
      firewalls: [],
    }, 1)
    metricsVerified = true
  }
  return { vmCount, nsgCount, metricsVerified }
}
