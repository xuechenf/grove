import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudProviderContext, ProviderMachine } from './cloudProvider'

const mocks = vi.hoisted(() => ({
  vmListAll: vi.fn(),
  instanceView: vi.fn(),
  vmStart: vi.fn(),
  vmDeallocate: vi.fn(),
  vmRestart: vi.fn(),
  nicGet: vi.fn(),
  subnetGet: vi.fn(),
  publicIpGet: vi.fn(),
  nsgGet: vi.fn(),
  nsgListAll: vi.fn(),
  securityRuleCreate: vi.fn(),
  securityRuleDelete: vi.fn(),
  metricsList: vi.fn(),
  credential: vi.fn(),
}))

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    constructor(...args: unknown[]) { mocks.credential(...args) }
  },
}))

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: class {
    virtualMachines = {
      listAll: mocks.vmListAll,
      instanceView: mocks.instanceView,
      start: mocks.vmStart,
      deallocate: mocks.vmDeallocate,
      restart: mocks.vmRestart,
    }
  },
}))

vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: class {
    networkInterfaces = { get: mocks.nicGet }
    subnets = { get: mocks.subnetGet }
    publicIPAddresses = { get: mocks.publicIpGet }
    networkSecurityGroups = { get: mocks.nsgGet, listAll: mocks.nsgListAll }
    securityRules = { createOrUpdate: mocks.securityRuleCreate, delete: mocks.securityRuleDelete }
  },
}))

vi.mock('@azure/arm-monitor', () => ({
  MonitorClient: class { metrics = { list: mocks.metricsList } },
}))

import { AzureCloudAdapter, normalizeAzureError } from './azureCloudAdapter'

function asyncItems<T>(items: T[]) {
  return (async function* () { for (const item of items) yield item })()
}

function context(): CloudProviderContext {
  return {
    profile: {
      id: 'profile-azure',
      kind: 'azure',
      name: 'Azure subscription',
      isDefault: true,
      secretConfigured: true,
      configuration: { tenantId: 'tenant', clientId: 'client', subscriptionId: 'subscription' },
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
    secrets: { clientSecret: 'secret' },
  }
}

const vmId = '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Compute/virtualMachines/grove-vm'
const nicId = '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Network/networkInterfaces/grove-nic'
const subnetId = '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Network/virtualNetworks/grove-vnet/subnets/default'
const nsgId = '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Network/networkSecurityGroups/grove-nsg'
const publicIpId = '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Network/publicIPAddresses/grove-ip'

const providerMachine: ProviderMachine = {
  nativeId: vmId,
  location: 'eastus',
  name: 'grove-vm',
  state: 'running',
  firewalls: [{ nativeId: nsgId, name: 'grove-nsg' }],
}

const poller = () => ({ pollUntilDone: vi.fn().mockResolvedValue(undefined) })

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.vmListAll.mockReturnValue(asyncItems([]))
  mocks.nsgListAll.mockReturnValue(asyncItems([]))
  mocks.vmStart.mockReturnValue(poller())
  mocks.vmDeallocate.mockReturnValue(poller())
  mocks.vmRestart.mockReturnValue(poller())
  mocks.securityRuleCreate.mockReturnValue(poller())
  mocks.securityRuleDelete.mockReturnValue(poller())
})

describe('AzureCloudAdapter', () => {
  it('discovers subscription VMs and resolves runtime, IP, VNet, subnet, and attached NSGs', async () => {
    mocks.vmListAll.mockReturnValue(asyncItems([{
      id: vmId,
      name: 'grove-vm',
      location: 'eastus',
      zones: ['1'],
      provisioningState: 'Succeeded',
      timeCreated: new Date('2026-07-20T00:00:00.000Z'),
      hardwareProfile: { vmSize: 'Standard_B2s' },
      storageProfile: { imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' } },
      networkProfile: { networkInterfaces: [{ id: nicId }] },
    }]))
    mocks.instanceView.mockResolvedValue({ statuses: [{ code: 'PowerState/running' }] })
    mocks.nicGet.mockResolvedValue({
      primary: true,
      networkSecurityGroup: { id: nsgId },
      ipConfigurations: [{ primary: true, privateIPAddress: '10.0.0.4', subnet: { id: subnetId }, publicIPAddress: { id: publicIpId } }],
    })
    mocks.subnetGet.mockResolvedValue({ networkSecurityGroup: { id: nsgId } })
    mocks.publicIpGet.mockResolvedValue({ ipAddress: '203.0.113.14' })

    const inventory = await new AzureCloudAdapter().listMachines(context())

    expect(inventory.warnings).toEqual([])
    expect(inventory.machines).toEqual([expect.objectContaining({
      nativeId: vmId,
      name: 'grove-vm',
      state: 'running',
      publicIp: '203.0.113.14',
      privateIp: '10.0.0.4',
      machineType: 'Standard_B2s',
      vpcId: '/subscriptions/subscription/resourceGroups/grove-rg/providers/Microsoft.Network/virtualNetworks/grove-vnet',
      subnetId,
      networkType: 'VNet',
      firewalls: [{ nativeId: nsgId, name: 'grove-nsg' }],
    })])
    expect(mocks.credential).toHaveBeenCalledWith('tenant', 'client', 'secret')
  })

  it('preserves the VM and reports an enrichment warning when a NIC read fails', async () => {
    mocks.vmListAll.mockReturnValue(asyncItems([{ id: vmId, name: 'grove-vm', location: 'eastus', networkProfile: { networkInterfaces: [{ id: nicId }] } }]))
    mocks.instanceView.mockResolvedValue({ statuses: [{ code: 'PowerState/deallocated' }] })
    mocks.nicGet.mockRejectedValue({ statusCode: 403, code: 'AuthorizationFailed' })

    const inventory = await new AzureCloudAdapter().listMachines(context())

    expect(inventory.machines[0]).toMatchObject({ name: 'grove-vm', state: 'stopped', firewalls: [] })
    expect(inventory.warnings.join(' ')).toContain('Monitoring Reader')
  })

  it('marks default and outbound NSG rules read-only and creates custom ingress with a free Grove priority', async () => {
    mocks.nsgGet.mockResolvedValue({
      securityRules: [
        { name: 'ssh', direction: 'Inbound', access: 'Allow', protocol: 'Tcp', priority: 3000, sourceAddressPrefix: '0.0.0.0/0', destinationPortRange: '22' },
        { name: 'allow-out', direction: 'Outbound', access: 'Allow', protocol: '*', priority: 3002, sourceAddressPrefix: '*', destinationPortRange: '*' },
      ],
      defaultSecurityRules: [{ name: 'AllowVnetInBound', direction: 'Inbound', access: 'Allow', protocol: '*', priority: 65000, sourceAddressPrefix: 'VirtualNetwork', destinationPortRange: '*' }],
    })
    const adapter = new AzureCloudAdapter()

    const rules = await adapter.listFirewallRules(context(), providerMachine)
    expect(rules.find((rule) => rule.nativeId === 'ssh')).toMatchObject({ removable: true, fromPort: 22, toPort: 22 })
    expect(rules.find((rule) => rule.nativeId === 'allow-out')).toMatchObject({ removable: false, direction: 'egress' })
    expect(rules.find((rule) => rule.nativeId === 'AllowVnetInBound')).toMatchObject({ removable: false, readOnlyReason: 'Azure default NSG rules cannot be removed.' })

    await adapter.addFirewallRule(context(), providerMachine, nsgId, { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' })
    expect(mocks.securityRuleCreate).toHaveBeenCalledWith('grove-rg', 'grove-nsg', expect.stringMatching(/^grove-/), expect.objectContaining({
      priority: 3001,
      direction: 'Inbound',
      destinationPortRange: '443',
    }))
  })

  it('normalizes Azure Monitor metrics and uses deallocate for Grove stop', async () => {
    const metricResult = (metrics: Array<{ name: string; average?: number; total?: number }>) => ({
      value: metrics.map(({ name, average, total }) => ({ name: { value: name }, timeseries: [{ data: [{ timeStamp: new Date('2026-07-21T01:00:00.000Z'), average, total }] }] })),
    })
    mocks.metricsList
      .mockResolvedValueOnce(metricResult([{ name: 'Percentage CPU', average: 12.5 }]))
      .mockResolvedValueOnce(metricResult([{ name: 'Network In Total', total: 1024 }, { name: 'Network Out Total', total: 2048 }]))

    const adapter = new AzureCloudAdapter()
    const metrics = await adapter.getMetrics(context(), providerMachine, 1)
    expect(metrics.periodSeconds).toBe(60)
    expect(metrics.series.map((series) => [series.key, series.points[0]?.value])).toEqual([
      ['cpuPercent', 12.5],
      ['networkInBytes', 1024],
      ['networkOutBytes', 2048],
    ])
    expect(mocks.metricsList).toHaveBeenNthCalledWith(1, vmId, expect.objectContaining({
      metricnames: 'Percentage CPU',
      metricnamespace: 'Microsoft.Compute/virtualMachines',
      aggregation: 'Average',
    }))
    expect(mocks.metricsList).toHaveBeenNthCalledWith(2, vmId, expect.objectContaining({
      metricnames: 'Network In Total,Network Out Total',
      metricnamespace: 'Microsoft.Compute/virtualMachines',
      aggregation: 'Total',
    }))

    await adapter.power(context(), providerMachine, 'stop')
    expect(mocks.vmDeallocate).toHaveBeenCalledWith('grove-rg', 'grove-vm')
    expect(mocks.vmStart).not.toHaveBeenCalled()
  })

  it('reports the role required for authorization and throttling failures', () => {
    expect(normalizeAzureError({ statusCode: 403, code: 'AuthorizationFailed' }, 'starting a VM', 'Virtual Machine Contributor').message)
      .toContain('Virtual Machine Contributor')
    expect(normalizeAzureError({ statusCode: 429, code: 'TooManyRequests' }, 'listing VMs').message)
      .toContain('throttled')
    expect(normalizeAzureError({ code: 'UnexpectedError', message: 'request contained client-secret-value' }, 'listing VMs').message)
      .not.toContain('client-secret-value')
  })
})
