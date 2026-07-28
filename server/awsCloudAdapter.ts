import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupRulesCommand,
  EC2Client,
  RebootInstancesCommand,
  RevokeSecurityGroupIngressCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2'
import { CloudWatchClient, GetMetricDataCommand, type GetMetricDataCommandOutput, type MetricDataQuery } from '@aws-sdk/client-cloudwatch'
import type { CloudMachinePowerAction } from '../src/types'
import type {
  CloudProviderAdapter,
  CloudProviderContext,
  ProviderFirewallRule,
  ProviderMachine,
  ProviderMachineMetrics,
} from './cloudProvider'

function credentials(context: CloudProviderContext) {
  const accessKeyId = context.profile.configuration.accessKeyId
  const secretAccessKey = context.secrets.secretAccessKey
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('The credential profile is incomplete.')
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: context.secrets.sessionToken || undefined,
  }
}

function ec2(context: CloudProviderContext, region: string) {
  return new EC2Client({ region, credentials: credentials(context) })
}

function machineState(value: string | undefined): ProviderMachine['state'] {
  switch (value) {
    case 'pending':
    case 'running':
    case 'stopping':
    case 'stopped':
      return value
    default:
      return 'unknown'
  }
}

function nameTag(instance: Instance) {
  return instance.Tags?.find((tag) => tag.Key === 'Name')?.Value?.trim() || instance.InstanceId || 'Unnamed machine'
}

function toMachine(instance: Instance, region: string): ProviderMachine | undefined {
  if (!instance.InstanceId || ['terminated', 'shutting-down'].includes(instance.State?.Name ?? '')) return undefined
  return {
    nativeId: instance.InstanceId,
    location: region,
    zone: instance.Placement?.AvailabilityZone,
    name: nameTag(instance),
    state: machineState(instance.State?.Name),
    publicIp: instance.PublicIpAddress,
    privateIp: instance.PrivateIpAddress,
    machineType: instance.InstanceType,
    imageId: instance.ImageId,
    launchedAt: instance.LaunchTime?.toISOString(),
    monitoring: instance.Monitoring?.State,
    vpcId: instance.VpcId,
    subnetId: instance.SubnetId,
    networkType: instance.VpcId ? 'VPC' : 'EC2-Classic',
    firewalls: (instance.SecurityGroups ?? [])
      .filter((group): group is { GroupId: string; GroupName?: string } => Boolean(group.GroupId))
      .map((group) => ({ nativeId: group.GroupId, name: group.GroupName || 'Firewall' })),
  }
}

function configuredRegions(context: CloudProviderContext) {
  return (context.profile.configuration.regions ?? '')
    .split(',')
    .map((region) => region.trim())
    .filter(Boolean)
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.name : 'UnknownError'
}

async function describeRegion(context: CloudProviderContext, region: string) {
  const client = ec2(context, region)
  try {
    const machines: ProviderMachine[] = []
    let nextToken: string | undefined
    do {
      const page = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const machine = toMachine(instance, region)
          if (machine) machines.push(machine)
        }
      }
      nextToken = page.NextToken
    } while (nextToken)
    return machines
  } finally {
    // destroy() closes the client's keep-alive sockets; it must run on error paths too,
    // otherwise every failed call leaks connections in this long-lived process.
    client.destroy()
  }
}

async function withConcurrency<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>) {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function metricQuery(id: string, metricName: string, stat: string): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/EC2', MetricName: metricName, Dimensions: [] },
      Period: 300,
      Stat: stat,
    },
    ReturnData: true,
  }
}

export class AwsCloudAdapter implements CloudProviderAdapter {
  async listMachines(context: CloudProviderContext) {
    const defaultRegion = context.profile.configuration.region || 'us-east-1'
    let regions = configuredRegions(context)
    if (!regions.length) {
      const client = ec2(context, defaultRegion)
      try {
        const result = await client.send(new DescribeRegionsCommand({ AllRegions: false }))
        regions = (result.Regions ?? []).map((region) => region.RegionName).filter((region): region is string => Boolean(region))
      } finally {
        client.destroy()
      }
    }
    regions = [...new Set(regions)].sort()
    const settled = await withConcurrency(regions, 4, (region) => describeRegion(context, region))
    const machines: ProviderMachine[] = []
    const warnings: string[] = []
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') machines.push(...result.value)
      else warnings.push(`${regions[index]} inventory failed (${errorCode(result.reason)}).`)
    })
    return { machines, warnings }
  }

  async listFirewallRules(context: CloudProviderContext, machine: ProviderMachine) {
    if (!machine.firewalls.length) return []
    const client = ec2(context, machine.location)
    try {
      const output: ProviderFirewallRule[] = []
      for (const firewall of machine.firewalls) {
        let nextToken: string | undefined
        do {
          const page = await client.send(new DescribeSecurityGroupRulesCommand({
            Filters: [{ Name: 'group-id', Values: [firewall.nativeId] }],
            NextToken: nextToken,
          }))
          for (const rule of page.SecurityGroupRules ?? []) {
            if (!rule.SecurityGroupRuleId) continue
            output.push({
              nativeId: rule.SecurityGroupRuleId,
              firewallNativeId: firewall.nativeId,
              firewallName: firewall.name,
              direction: rule.IsEgress ? 'egress' : 'ingress',
              protocol: rule.IpProtocol ?? 'all',
              fromPort: rule.FromPort,
              toPort: rule.ToPort,
              source:
                rule.CidrIpv4 ??
                rule.CidrIpv6 ??
                rule.PrefixListId ??
                rule.ReferencedGroupInfo?.GroupId ??
                'unknown',
              description: rule.Description,
              removable: !rule.IsEgress,
              readOnlyReason: rule.IsEgress ? 'Outbound rules are read-only in Grove.' : undefined,
            })
          }
          nextToken = page.NextToken
        } while (nextToken)
      }
      return output
    } finally {
      client.destroy()
    }
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
    const client = ec2(context, machine.location)
    const range = { CidrIp: input.cidr, Description: input.description?.trim() || 'Managed by Grove' }
    const range6 = { CidrIpv6: input.cidr, Description: input.description?.trim() || 'Managed by Grove' }
    try {
      await client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: firewallNativeId,
        IpPermissions: [{
          IpProtocol: input.protocol,
          FromPort: input.fromPort,
          ToPort: input.toPort,
          ...(input.cidr.includes(':') ? { Ipv6Ranges: [range6] } : { IpRanges: [range] }),
        }],
      }))
    } finally {
      client.destroy()
    }
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
    const client = ec2(context, machine.location)
    try {
      await client.send(new RevokeSecurityGroupIngressCommand({
        GroupId: firewallNativeId,
        SecurityGroupRuleIds: [ruleNativeId],
      }))
    } finally {
      client.destroy()
    }
  }

  async getMetrics(context: CloudProviderContext, machine: ProviderMachine, hours: number): Promise<ProviderMachineMetrics> {
    const end = new Date()
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
    const queries = [
      metricQuery('cpu', 'CPUUtilization', 'Average'),
      metricQuery('networkin', 'NetworkIn', 'Sum'),
      metricQuery('networkout', 'NetworkOut', 'Sum'),
      metricQuery('statusfailed', 'StatusCheckFailed', 'Maximum'),
    ]
    for (const query of queries) {
      query.MetricStat!.Metric!.Dimensions = [{ Name: 'InstanceId', Value: machine.nativeId }]
    }
    const client = new CloudWatchClient({ region: machine.location, credentials: credentials(context) })
    let result: GetMetricDataCommandOutput
    try {
      result = await client.send(new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: queries,
        ScanBy: 'TimestampAscending',
      }))
    } finally {
      client.destroy()
    }
    const definitions = {
      cpu: { key: 'cpuPercent' as const, label: 'CPU utilization', unit: 'Percent' },
      networkin: { key: 'networkInBytes' as const, label: 'Network in', unit: 'Bytes' },
      networkout: { key: 'networkOutBytes' as const, label: 'Network out', unit: 'Bytes' },
      statusfailed: { key: 'statusCheckFailed' as const, label: 'Failed status checks', unit: 'Count' },
    }
    const series = (result.MetricDataResults ?? []).flatMap((item) => {
      const definition = item.Id ? definitions[item.Id as keyof typeof definitions] : undefined
      if (!definition) return []
      return [{
        ...definition,
        points: (item.Timestamps ?? []).map((timestamp, index) => ({
          timestamp: timestamp.toISOString(),
          value: item.Values?.[index] ?? 0,
        })),
      }]
    })
    return {
      periodSeconds: 300,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      series,
    }
  }

  async power(context: CloudProviderContext, machine: ProviderMachine, action: CloudMachinePowerAction) {
    const client = ec2(context, machine.location)
    try {
      switch (action) {
        case 'start':
          await client.send(new StartInstancesCommand({ InstanceIds: [machine.nativeId] }))
          break
        case 'stop':
          await client.send(new StopInstancesCommand({ InstanceIds: [machine.nativeId] }))
          break
        case 'reboot':
          await client.send(new RebootInstancesCommand({ InstanceIds: [machine.nativeId] }))
          break
      }
    } finally {
      client.destroy()
    }
  }
}
