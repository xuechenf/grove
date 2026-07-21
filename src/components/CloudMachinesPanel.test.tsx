import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudFirewallRule, CloudInventory, CloudMachine, CloudMachineMetrics } from '../types'
import { CloudMachinesPanel } from './CloudMachinesPanel'

const api = vi.hoisted(() => ({
  listCloudMachines: vi.fn(),
  listCloudFirewallRules: vi.fn(),
  getCloudMachineMetrics: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  apiDisabled: () => false,
  listCloudMachines: api.listCloudMachines,
  listCloudFirewallRules: api.listCloudFirewallRules,
  getCloudMachineMetrics: api.getCloudMachineMetrics,
  addCloudFirewallRule: vi.fn(),
  changeCloudMachinePower: vi.fn(),
  removeCloudFirewallRule: vi.fn(),
}))

function machine(id: string, name: string): CloudMachine {
  return {
    id,
    provider: 'aws',
    credentialProfileId: 'cred-1',
    credentialProfileName: 'lab',
    name,
    location: 'us-east-1',
    state: 'running',
    publicIp: '203.0.113.10',
    firewalls: [],
  }
}

const ruleB: CloudFirewallRule = {
  id: 'rule-b',
  firewallId: 'fw-b',
  firewallName: 'edge',
  direction: 'ingress',
  protocol: 'tcp',
  fromPort: 443,
  toPort: 443,
  source: '0.0.0.0/0',
}

function metricsFor(machineId: string): CloudMachineMetrics {
  return { machineId, periodSeconds: 60, startTime: 't0', endTime: 't1', series: [] }
}

const inventory: CloudInventory = {
  machines: [machine('machine-a', 'alpha'), machine('machine-b', 'bravo')],
  scannedAt: 't0',
  warnings: [],
}

beforeEach(() => {
  api.listCloudMachines.mockResolvedValue(inventory)
  api.listCloudFirewallRules.mockImplementation((machineId: string) =>
    machineId === 'machine-a' ? Promise.reject(new Error('firewall boom')) : Promise.resolve([ruleB]),
  )
  api.getCloudMachineMetrics.mockImplementation((machineId: string) =>
    machineId === 'machine-a' ? Promise.reject(new Error('metrics boom')) : Promise.resolve(metricsFor(machineId)),
  )
})

describe('CloudMachinesPanel error state', () => {
  it('clears a previous machine error when switching to a machine whose details load', async () => {
    const user = userEvent.setup()
    render(<CloudMachinesPanel />)

    // The first machine is auto-selected and its detail fetch fails.
    expect(await screen.findByText('firewall boom')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /bravo/ }))

    // The error clears at the start of the new fetch, and the new rules replace the stale ones.
    await waitFor(() => expect(screen.queryByText('firewall boom')).not.toBeInTheDocument())
    expect(await screen.findByText(/edge/)).toBeInTheDocument()
  })
})
