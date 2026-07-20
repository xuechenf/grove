import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vms } from '../data/fixtures'
import type { VmOverviewTelemetry } from '../types'
import { OverviewTab } from './OverviewTab'

const getVmOverview = vi.fn()

vi.mock('../lib/api', () => ({
  apiDisabled: () => false,
  getVmOverview: (...args: unknown[]) => getVmOverview(...args),
}))

describe('VM Overview telemetry', () => {
  beforeEach(() => {
    getVmOverview.mockReset()
  })

  it('renders live AWS status, network metadata, and CloudWatch metrics', async () => {
    const vm = vms[0]
    const telemetry: VmOverviewTelemetry = {
      vm,
      source: 'aws',
      sourceLabel: 'AWS EC2 + CloudWatch',
      sampledAt: '2026-07-20T01:00:00.000Z',
      warnings: [],
      cloudMachine: {
        id: 'cloud-machine-one',
        provider: 'aws',
        credentialProfileId: 'credential-one',
        credentialProfileName: 'AWS production',
        name: vm.name,
        location: 'ap-northeast-1',
        zone: 'ap-northeast-1a',
        state: 'running',
        publicIp: vm.ipAddress,
        privateIp: '10.0.0.8',
        machineType: 't3.small',
        vpcId: 'vpc-123',
        subnetId: 'subnet-123',
        networkType: 'VPC',
        firewalls: [{ id: 'firewall-one', name: 'web' }],
      },
      cloudMetrics: {
        machineId: 'cloud-machine-one',
        periodSeconds: 300,
        startTime: '2026-07-20T00:00:00.000Z',
        endTime: '2026-07-20T01:00:00.000Z',
        series: [
          { key: 'cpuPercent', label: 'CPU', unit: 'Percent', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 12 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 18 }] },
          { key: 'networkInBytes', label: 'Network in', unit: 'Bytes', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 1_000 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 2_000 }] },
          { key: 'networkOutBytes', label: 'Network out', unit: 'Bytes', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 500 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 800 }] },
          { key: 'statusCheckFailed', label: 'Status', unit: 'Count', points: [{ timestamp: '2026-07-20T01:00:00.000Z', value: 0 }] },
        ],
      },
    }
    getVmOverview.mockResolvedValue(telemetry)

    render(<OverviewTab vm={vm} />)

    await waitFor(() => expect(screen.getAllByText('AWS EC2 + CloudWatch').length).toBeGreaterThan(0))
    expect(screen.getByTestId('network-panel')).toHaveTextContent('vpc-123')
    expect(screen.getByTestId('network-panel')).toHaveTextContent('10.0.0.8')
    expect(screen.getByTestId('metrics-panel')).toHaveTextContent('CloudWatch')
    expect(screen.getByTestId('metrics-panel')).toHaveTextContent('18%')
    expect(screen.getByTestId('metrics-panel')).toHaveTextContent('EC2 status check: passing')
    expect(screen.getAllByText('running').length).toBeGreaterThan(0)
  })

  it('shows SSH as the data source for a non-cloud machine', async () => {
    const vm = vms[1]
    getVmOverview.mockResolvedValue({
      vm,
      source: 'host',
      sourceLabel: 'Host over SSH',
      sampledAt: vm.metrics.sampledAt,
      warnings: [],
    } satisfies VmOverviewTelemetry)

    render(<OverviewTab vm={vm} />)

    await waitFor(() => expect(screen.getAllByText('Host over SSH').length).toBeGreaterThan(0))
    expect(screen.getByTestId('network-panel')).toHaveTextContent('Host interface')
    expect(screen.getByTestId('metrics-panel')).toHaveTextContent('SSH')
  })
})
