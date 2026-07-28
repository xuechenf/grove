import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { vms } from '../data/fixtures'
import type { VmOverviewTelemetry } from '../types'
import { MonitoringTab } from './MonitoringTab'
import { OverviewTab } from './OverviewTab'

function awsTelemetry(): VmOverviewTelemetry {
  const vm = vms[0]
  return {
    vm,
    source: 'aws',
    sourceLabel: 'AWS EC2 + CloudWatch',
    sampledAt: '2026-07-20T01:00:00.000Z',
    warnings: [],
    cloudMachine: {
      id: 'cloud-machine-one', provider: 'aws', credentialProfileId: 'credential-one', credentialProfileName: 'AWS production', name: vm.name, location: 'ap-northeast-1', zone: 'ap-northeast-1a', state: 'running', publicIp: vm.ipAddress, privateIp: '10.0.0.8', machineType: 't3.small', vpcId: 'vpc-123', subnetId: 'subnet-123', networkType: 'VPC', firewalls: [{ id: 'firewall-one', name: 'web' }],
    },
    cloudMetrics: {
      machineId: 'cloud-machine-one', periodSeconds: 300, startTime: '2026-07-20T00:00:00.000Z', endTime: '2026-07-20T01:00:00.000Z',
      series: [
        { key: 'cpuPercent', label: 'CPU', unit: 'Percent', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 12 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 18 }] },
        { key: 'networkInBytes', label: 'Network in', unit: 'Bytes', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 1_000 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 2_000 }] },
        { key: 'networkOutBytes', label: 'Network out', unit: 'Bytes', points: [{ timestamp: '2026-07-20T00:55:00.000Z', value: 500 }, { timestamp: '2026-07-20T01:00:00.000Z', value: 800 }] },
        { key: 'statusCheckFailed', label: 'Status', unit: 'Count', points: [{ timestamp: '2026-07-20T01:00:00.000Z', value: 0 }] },
      ],
    },
  }
}

describe('VM telemetry tabs', () => {
  it('keeps Overview concise and labels hybrid cloud and SSH data', () => {
    const telemetry = awsTelemetry()
    render(<OverviewTab vm={telemetry.vm} telemetry={telemetry} />)

    expect(screen.getByTestId('overview-tab')).toHaveTextContent('CloudWatch + SSH')
    expect(screen.getByTestId('overview-tab')).toHaveTextContent('Traffic now')
    expect(screen.queryByTestId('network-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('metrics-panel')).not.toBeInTheDocument()
  })

  it('owns detailed network and resource data in Monitoring', () => {
    const telemetry = awsTelemetry()
    render(<MonitoringTab vm={telemetry.vm} telemetry={telemetry} />)

    expect(screen.getByTestId('monitoring-tab')).toHaveTextContent('CloudWatch + SSH')
    expect(screen.getByTestId('monitoring-tab')).toHaveTextContent('Network in')
    expect(screen.getByTestId('monitoring-tab')).toHaveTextContent('Network out')
    expect(screen.getByTestId('monitoring-tab')).toHaveTextContent('EC2 status check: passing')
  })

  it('shows SSH as the data source for a non-cloud machine', () => {
    const vm = vms[1]
    const telemetry = { vm, source: 'host', sourceLabel: 'Host over SSH', sampledAt: vm.metrics.sampledAt, warnings: [] } satisfies VmOverviewTelemetry
    render(<OverviewTab vm={vm} telemetry={telemetry} />)
    expect(screen.getByTestId('overview-tab')).toHaveTextContent('Host managed')
    expect(screen.getByTestId('overview-tab')).toHaveTextContent('SSH')
  })

  it('labels Azure VM and network metrics as Azure Monitor data', () => {
    const telemetry = awsTelemetry()
    const azureTelemetry = {
      ...telemetry,
      source: 'azure',
      sourceLabel: 'Azure VM + Azure Monitor',
      cloudMachine: { ...telemetry.cloudMachine!, provider: 'azure', location: 'eastus' },
      cloudMetrics: { ...telemetry.cloudMetrics!, series: telemetry.cloudMetrics!.series.filter((series) => series.key !== 'statusCheckFailed') },
    } satisfies VmOverviewTelemetry

    render(<MonitoringTab vm={azureTelemetry.vm} telemetry={azureTelemetry} />)

    expect(screen.getByTestId('monitoring-tab')).toHaveTextContent('Azure Monitor + SSH')
    expect(screen.getAllByText('Azure Monitor').length).toBeGreaterThan(0)
    expect(screen.queryByText(/EC2 status check/)).not.toBeInTheDocument()
  })
})
