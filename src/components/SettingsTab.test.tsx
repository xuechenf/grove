import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vms } from '../data/fixtures'
import type { CloudFirewallRule, VmOverviewTelemetry } from '../types'
import { SettingsTab } from './SettingsTab'

const listRules = vi.fn()
const addRule = vi.fn()
const removeRule = vi.fn()

vi.mock('../lib/api', () => ({
  listCloudFirewallRules: (...args: unknown[]) => listRules(...args),
  addCloudFirewallRule: (...args: unknown[]) => addRule(...args),
  removeCloudFirewallRule: (...args: unknown[]) => removeRule(...args),
}))

const initialRule: CloudFirewallRule = { id: 'rule-1', firewallId: 'sg-1', firewallName: 'web', direction: 'ingress', protocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0' }

function telemetry(): VmOverviewTelemetry {
  const vm = vms[0]
  return { vm, source: 'aws', sourceLabel: 'AWS EC2 + CloudWatch', sampledAt: '2026-07-20T01:00:00Z', warnings: [], cloudMachine: { id: 'machine-1', provider: 'aws', credentialProfileId: 'credential-1', credentialProfileName: 'AWS production', name: vm.name, location: 'ap-northeast-1', zone: 'ap-northeast-1a', state: 'running', publicIp: vm.ipAddress, privateIp: '10.0.0.8', vpcId: 'vpc-1', subnetId: 'subnet-1', firewalls: [{ id: 'sg-1', name: 'web' }] } }
}

describe('VM Settings', () => {
  beforeEach(() => {
    listRules.mockReset().mockResolvedValue([initialRule])
    addRule.mockReset().mockResolvedValue([initialRule, { ...initialRule, id: 'rule-2', fromPort: 443, toPort: 443 }])
    removeRule.mockReset().mockResolvedValue([])
  })

  it('uses the cloud binding and adjusts ingress rules for an imported VM', async () => {
    const user = userEvent.setup()
    const vmTelemetry = telemetry()
    render(<SettingsTab vm={vmTelemetry.vm} telemetry={vmTelemetry} applications={[]} onRefreshCloud={() => undefined} onTestConnection={() => undefined} onEditVm={() => undefined} onOpenInfrastructure={() => undefined} onRemoveVm={() => undefined} />)

    expect(screen.getByText('AWS production')).toBeInTheDocument()
    expect(await screen.findByText('tcp 22-22')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add ingress' }))
    await user.click(screen.getByRole('button', { name: 'Add rule' }))

    await waitFor(() => expect(addRule).toHaveBeenCalledWith('machine-1', expect.objectContaining({ firewallId: 'sg-1', fromPort: 443, toPort: 443 })))
    expect(screen.getByText('tcp 443-443')).toBeInTheDocument()
  })
})
