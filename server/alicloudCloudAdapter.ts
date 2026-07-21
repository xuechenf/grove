import RpcClientSdk from '@alicloud/pop-core'
import type { CloudMachinePowerAction } from '../src/types'
import type {
  CloudProviderAdapter,
  CloudProviderContext,
  ProviderFirewallRule,
  ProviderMachine,
  ProviderMachineMetrics,
} from './cloudProvider'

interface RpcClient {
  request(action: string, parameters?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

interface RpcClientConstructor {
  new (options: {
    accessKeyId: string
    accessKeySecret: string
    securityToken?: string
    endpoint: string
    apiVersion: string
    opts?: { timeout?: number }
  }): RpcClient
}

// A static import lets esbuild include the CommonJS SDK in Grove's CommonJS Electron bundle.
// createRequire(import.meta.url) works in development but import.meta is empty in that bundle.
const RpcClient = RpcClientSdk as unknown as RpcClientConstructor

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : value == null ? undefined : String(value)
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nestedList(value: unknown, container: string, item: string) {
  const items = record(record(value)[container])[item]
  return Array.isArray(items) ? items.map(record) : []
}

function directStringList(value: unknown, container: string, item: string) {
  const items = record(record(value)[container])[item]
  return Array.isArray(items) ? items.map(stringValue).filter((entry): entry is string => Boolean(entry)) : []
}

function credentials(context: CloudProviderContext) {
  const accessKeyId = context.profile.configuration.accessKeyId
  const accessKeySecret = context.secrets.accessKeySecret
  if (!accessKeyId || !accessKeySecret) throw new Error('The Alibaba Cloud credential profile is incomplete.')
  return { accessKeyId, accessKeySecret, securityToken: context.secrets.securityToken || undefined }
}

function client(context: CloudProviderContext, endpoint: string, apiVersion: string) {
  return new RpcClient({ ...credentials(context), endpoint, apiVersion, opts: { timeout: 20_000 } })
}

function ecs(context: CloudProviderContext, region: string) {
  return client(context, `https://ecs.${region}.aliyuncs.com`, '2014-05-26')
}

function cloudMonitor(context: CloudProviderContext) {
  return client(context, 'https://metrics.cn-hangzhou.aliyuncs.com', '2019-01-01')
}

function configuredRegions(context: CloudProviderContext) {
  const value = context.profile.configuration.regions || context.profile.configuration.region || 'cn-beijing'
  return [...new Set(value.split(',').map((region) => region.trim()).filter(Boolean))].sort()
}

function machineState(value: string | undefined): ProviderMachine['state'] {
  switch (value?.toLowerCase()) {
    case 'pending':
    case 'starting':
      return 'pending'
    case 'running':
      return 'running'
    case 'stopping':
      return 'stopping'
    case 'stopped':
      return 'stopped'
    case 'rebooting':
      return 'rebooting'
    default:
      return 'unknown'
  }
}

function firstIp(instance: JsonRecord, ...paths: Array<[string, string]>) {
  for (const [container, item] of paths) {
    const values = directStringList(instance, container, item)
    if (values[0]) return values[0]
  }
  return undefined
}

function toMachine(instance: JsonRecord, region: string): ProviderMachine | undefined {
  const nativeId = stringValue(instance.InstanceId)
  if (!nativeId) return undefined
  const vpcAttributes = record(instance.VpcAttributes)
  const eip = record(instance.EipAddress)
  const securityGroupIds = directStringList(instance, 'SecurityGroupIds', 'SecurityGroupId')
  const publicIp = stringValue(eip.IpAddress) || firstIp(instance, ['PublicIpAddress', 'IpAddress'])
  const privateIp = firstIp(vpcAttributes, ['PrivateIpAddress', 'IpAddress']) ||
    firstIp(instance, ['InnerIpAddress', 'IpAddress'])
  return {
    nativeId,
    location: stringValue(instance.RegionId) || region,
    zone: stringValue(instance.ZoneId),
    name: stringValue(instance.InstanceName)?.trim() || nativeId,
    state: machineState(stringValue(instance.Status)),
    publicIp,
    privateIp,
    machineType: stringValue(instance.InstanceType),
    imageId: stringValue(instance.ImageId),
    launchedAt: stringValue(instance.CreationTime) || stringValue(instance.StartTime),
    monitoring: 'CloudMonitor basic monitoring',
    vpcId: stringValue(vpcAttributes.VpcId),
    subnetId: stringValue(vpcAttributes.VSwitchId),
    networkType: stringValue(instance.InstanceNetworkType) || (vpcAttributes.VpcId ? 'VPC' : undefined),
    maxBandwidthInMbps: numberValue(instance.InternetMaxBandwidthIn),
    maxBandwidthOutMbps: numberValue(instance.InternetMaxBandwidthOut),
    firewalls: securityGroupIds.map((id) => ({ nativeId: id, name: id })),
  }
}

function parsePortRange(value: string | undefined) {
  const match = value?.match(/^(\d+)\/(\d+)$/)
  return match ? { fromPort: Number(match[1]), toPort: Number(match[2]) } : {}
}

function metricTimestamp(point: JsonRecord) {
  const raw = point.timestamp ?? point.Timestamp ?? point.time ?? point.Time
  const numeric = numberValue(raw)
  if (numeric !== undefined) {
    return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric).toISOString()
  }
  const text = stringValue(raw)
  const date = text ? new Date(text) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function metricValue(point: JsonRecord) {
  return numberValue(point.Average ?? point.Value ?? point.value ?? point.Maximum) ?? 0
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : 'unknown error'
}

export class AlicloudCloudAdapter implements CloudProviderAdapter {
  async listMachines(context: CloudProviderContext) {
    const machines: ProviderMachine[] = []
    const warnings: string[] = []
    for (const region of configuredRegions(context)) {
      try {
        const regionClient = ecs(context, region)
        const pageSize = 100
        let pageNumber = 1
        let loaded = 0
        let total = Number.POSITIVE_INFINITY
        do {
          const response = record(await regionClient.request('DescribeInstances', {
            RegionId: region,
            PageNumber: pageNumber,
            PageSize: pageSize,
          }, { method: 'POST' }))
          const instances = nestedList(response, 'Instances', 'Instance')
          for (const instance of instances) {
            const machine = toMachine(instance, region)
            if (machine) machines.push(machine)
          }
          loaded += instances.length
          total = numberValue(response.TotalCount) ?? loaded
          pageNumber += 1
          if (!instances.length) break
        } while (loaded < total)
      } catch (error) {
        warnings.push(`${region} inventory failed (${errorDetail(error)}).`)
      }
    }
    return { machines, warnings }
  }

  async listFirewallRules(context: CloudProviderContext, machine: ProviderMachine) {
    const regionClient = ecs(context, machine.location)
    const output: ProviderFirewallRule[] = []
    for (const firewall of machine.firewalls) {
      const response = record(await regionClient.request('DescribeSecurityGroupAttribute', {
        RegionId: machine.location,
        SecurityGroupId: firewall.nativeId,
        Direction: 'all',
      }, { method: 'POST' }))
      const firewallName = stringValue(response.SecurityGroupName) || firewall.name
      const permissions = nestedList(response, 'Permissions', 'Permission')
      for (const [index, permission] of permissions.entries()) {
        const direction = stringValue(permission.Direction)?.toLowerCase() === 'egress' ? 'egress' : 'ingress'
        const source = direction === 'egress'
          ? stringValue(permission.DestCidrIp) || stringValue(permission.Ipv6DestCidrIp)
          : stringValue(permission.SourceCidrIp) || stringValue(permission.Ipv6SourceCidrIp)
        output.push({
          nativeId: stringValue(permission.SecurityGroupRuleId) || `${firewall.nativeId}:${direction}:${index}`,
          firewallNativeId: firewall.nativeId,
          firewallName,
          direction,
          protocol: stringValue(permission.IpProtocol)?.toLowerCase() || 'all',
          ...parsePortRange(stringValue(permission.PortRange)),
          source: source || stringValue(permission.SourceGroupId) || stringValue(permission.DestGroupId) || 'unknown',
          description: stringValue(permission.Description),
        })
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
    if (!machine.firewalls.some((firewall) => firewall.nativeId === firewallNativeId)) {
      throw new Error('The selected firewall is not attached to this cloud machine.')
    }
    await ecs(context, machine.location).request('AuthorizeSecurityGroup', {
      RegionId: machine.location,
      SecurityGroupId: firewallNativeId,
      IpProtocol: input.protocol,
      PortRange: `${input.fromPort}/${input.toPort}`,
      ...(input.cidr.includes(':') ? { Ipv6SourceCidrIp: input.cidr } : { SourceCidrIp: input.cidr }),
      Description: input.description?.trim() || 'Managed by Grove',
    }, { method: 'POST' })
  }

  async removeFirewallRule(
    context: CloudProviderContext,
    machine: ProviderMachine,
    firewallNativeId: string,
    ruleNativeId: string,
  ) {
    if (!machine.firewalls.some((firewall) => firewall.nativeId === firewallNativeId)) {
      throw new Error('The selected firewall is not attached to this cloud machine.')
    }
    if (ruleNativeId.includes(':')) throw new Error('Alibaba Cloud did not return a removable rule identifier.')
    await ecs(context, machine.location).request('RevokeSecurityGroup', {
      RegionId: machine.location,
      SecurityGroupId: firewallNativeId,
      SecurityGroupRuleId: [ruleNativeId],
    }, { method: 'POST' })
  }

  async getMetrics(context: CloudProviderContext, machine: ProviderMachine, hours: number): Promise<ProviderMachineMetrics> {
    const end = new Date()
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
    const definitions = [
      { metricName: 'CPUUtilization', key: 'cpuPercent' as const, label: 'CPU utilization', unit: 'Percent' },
      { metricName: 'IntranetInRate', key: 'networkInBytes' as const, label: 'Network in', unit: 'Bits/Second' },
      { metricName: 'IntranetOutRate', key: 'networkOutBytes' as const, label: 'Network out', unit: 'Bits/Second' },
    ]
    const monitor = cloudMonitor(context)
    const settled = await Promise.allSettled(definitions.map(async (definition) => {
      // DescribeMetricList truncates at Length datapoints and pages via NextToken; follow it
      // so windows beyond a single page (~16.7h at 60s period) are not silently cut off.
      // 20 pages covers the full 168h max window with headroom.
      const datapoints: unknown[] = []
      let nextToken: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const response = record(await monitor.request('DescribeMetricList', {
          Namespace: 'acs_ecs_dashboard',
          MetricName: definition.metricName,
          Dimensions: JSON.stringify([{ instanceId: machine.nativeId }]),
          StartTime: start.getTime(),
          EndTime: end.getTime(),
          Period: '60',
          Length: '1000',
          ...(nextToken ? { NextToken: nextToken } : {}),
        }, { method: 'POST' }))
        const raw = stringValue(response.Datapoints)
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          if (Array.isArray(parsed)) datapoints.push(...parsed)
        }
        nextToken = stringValue(response.NextToken)
        if (!nextToken) break
      }
      return {
        key: definition.key,
        label: definition.label,
        unit: definition.unit,
        points: datapoints.map(record).map((point) => ({ timestamp: metricTimestamp(point), value: metricValue(point) })),
      }
    }))
    const failures = settled.filter((result) => result.status === 'rejected')
    if (failures.length === settled.length) {
      const first = failures[0] as PromiseRejectedResult
      throw new Error(`Alibaba CloudMonitor metrics failed: ${errorDetail(first.reason)}`)
    }
    const series: ProviderMachineMetrics['series'] = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    series.push({ key: 'statusCheckFailed', label: 'Failed status checks', unit: 'Count', points: [] })
    return {
      periodSeconds: 60,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      series,
    }
  }

  async power(context: CloudProviderContext, machine: ProviderMachine, action: CloudMachinePowerAction) {
    const actionName = action === 'start' ? 'StartInstance' : action === 'stop' ? 'StopInstance' : 'RebootInstance'
    await ecs(context, machine.location).request(actionName, {
      RegionId: machine.location,
      InstanceId: machine.nativeId,
    }, { method: 'POST' })
  }
}
