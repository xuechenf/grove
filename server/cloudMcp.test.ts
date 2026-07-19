import { describe, expect, it, vi } from 'vitest'
import { vms } from '../src/data/fixtures'
import type { CopilotToolHost } from './copilotTypes'
import { buildToolsForScope } from './mcp/tools'

function host(): CopilotToolHost {
  return {
    listVms: () => vms,
    getVm: (vmId) => vms.find((vm) => vm.id === vmId),
    runScopedCommand: vi.fn(),
    readRemoteLogs: vi.fn(),
    listRemoteFiles: vi.fn(),
    serviceStatus: vi.fn(),
    inspectVm: vi.fn(),
    diagnoseService: vi.fn(),
    fleetRunCommand: vi.fn(),
    inspectCloudMachines: vi.fn().mockResolvedValue({ ok: true, summary: 'three machines' }),
    inspectCloudFirewallRules: vi.fn(),
    inspectCloudMetrics: vi.fn(),
    cloudPowerFromCopilot: vi.fn(),
    addCloudFirewallRuleFromCopilot: vi.fn(),
    removeCloudFirewallRuleFromCopilot: vi.fn(),
    recordNote: vi.fn(),
    getHistory: vi.fn(),
  }
}

describe('Kimi cloud tools', () => {
  it('exposes provider-neutral existing-resource controls only in fleet scope', async () => {
    const toolHost = host()
    const fleetTools = buildToolsForScope('fleet', toolHost)
    const names = fleetTools.map((tool) => tool.name)

    expect(names).toEqual(expect.arrayContaining([
      'list_cloud_machines',
      'list_cloud_firewall_rules',
      'get_cloud_metrics',
      'change_cloud_power',
      'add_cloud_firewall_rule',
      'remove_cloud_firewall_rule',
    ]))
    expect(names.some((name) => /aws|azure|ali|create_cloud|terminate/i.test(name))).toBe(false)
    await fleetTools.find((tool) => tool.name === 'list_cloud_machines')!.run({})
    expect(toolHost.inspectCloudMachines).toHaveBeenCalledWith({ scope: 'fleet' })

    const vmTools = buildToolsForScope(`vm:${vms[0].id}`, toolHost)
    expect(vmTools.some((tool) => tool.name.includes('cloud'))).toBe(false)
  })
})
