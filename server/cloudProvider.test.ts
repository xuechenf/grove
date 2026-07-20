import { describe, expect, it, vi } from 'vitest'
import { ApplicationWorkspace } from './applicationWorkspace'
import { CloudProviderManager, type CloudProviderAdapter } from './cloudProvider'
import { CredentialManager } from './credentialManager'
import { MemoryCredentialVault } from './credentialVault'
import { ProviderCredentialTester } from './providerCredentialTester'

function credentialManager() {
  const workspace = new ApplicationWorkspace({ persist: false })
  const vault = new MemoryCredentialVault()
  const tester = { test: vi.fn() } as unknown as ProviderCredentialTester
  return { manager: new CredentialManager(workspace, vault, undefined, tester), vault }
}

describe('AWS credential CSV import', () => {
  it('stores secret material only in the vault and returns a redacted profile', () => {
    const { manager, vault } = credentialManager()
    const profile = manager.importAwsCsv({
      name: 'Production account',
      region: 'ap-northeast-1',
      csvText: 'Access key ID,Secret access key\nAKIATESTVALUE,super-secret-value\n',
    })

    expect(profile.kind).toBe('aws')
    expect(profile.configuration).toEqual({ accessKeyId: 'AKIATESTVALUE', region: 'ap-northeast-1' })
    expect(JSON.stringify(profile)).not.toContain('super-secret-value')
    expect(vault.get(profile.id)).toEqual({ secretAccessKey: 'super-secret-value' })
  })

  it('accepts quoted AWS console CSV values and rejects missing columns', () => {
    const { manager } = credentialManager()
    expect(() => manager.importAwsCsv({
      name: 'Quoted',
      csvText: 'Access key ID,Secret access key\r\n"AKIATEST","secret,with,commas"\r\n',
    })).not.toThrow()
    expect(() => manager.importAwsCsv({ name: 'Broken', csvText: 'Name,Value\nfoo,bar\n' }))
      .toThrow(/Access key ID and Secret access key/)
  })
})

describe('Alibaba Cloud credential CSV import', () => {
  it('accepts the Alibaba export headers and stores the secret only in the vault', () => {
    const { manager, vault } = credentialManager()
    const profile = manager.importAlicloudCsv({
      name: 'China account',
      region: 'cn-beijing',
      csvText: 'AccessKey ID,AccessKey Secret\nLTAITESTVALUE,alicloud-secret-value\n',
    })

    expect(profile.kind).toBe('alicloud')
    expect(profile.configuration).toEqual({ accessKeyId: 'LTAITESTVALUE', region: 'cn-beijing' })
    expect(JSON.stringify(profile)).not.toContain('alicloud-secret-value')
    expect(vault.get(profile.id)).toEqual({ accessKeySecret: 'alicloud-secret-value' })
  })
})

describe('provider-neutral cloud control', () => {
  it('uses opaque ids and exposes only the allowed existing-resource operations', async () => {
    const { manager } = credentialManager()
    const profile = manager.create({
      kind: 'aws',
      name: 'Cloud account',
      configuration: { accessKeyId: 'AKIATEST', region: 'ap-northeast-1' },
      secrets: { secretAccessKey: 'secret' },
    })
    const adapter: CloudProviderAdapter = {
      listMachines: vi.fn().mockResolvedValue({
        warnings: [],
        machines: [{
          nativeId: 'i-0123456789',
          location: 'ap-northeast-1',
          name: 'aws-nrt',
          state: 'running',
          publicIp: '203.0.113.10',
          firewalls: [{ nativeId: 'sg-0123456789', name: 'default' }],
        }],
      }),
      listFirewallRules: vi.fn().mockResolvedValue([{
        nativeId: 'sgr-0123456789',
        firewallNativeId: 'sg-0123456789',
        firewallName: 'default',
        direction: 'ingress',
        protocol: 'tcp',
        fromPort: 22,
        toPort: 22,
        source: '0.0.0.0/0',
      }]),
      addFirewallRule: vi.fn().mockResolvedValue(undefined),
      removeFirewallRule: vi.fn().mockResolvedValue(undefined),
      getMetrics: vi.fn().mockResolvedValue({
        periodSeconds: 300,
        startTime: '2026-07-20T00:00:00.000Z',
        endTime: '2026-07-20T01:00:00.000Z',
        series: [],
      }),
      power: vi.fn().mockResolvedValue(undefined),
    }
    const cloud = new CloudProviderManager(manager, { aws: adapter })
    const inventory = await cloud.listMachines(profile.id)

    expect(inventory.machines).toHaveLength(1)
    expect(inventory.machines[0].id).toMatch(/^cloud-machine-/)
    expect(inventory.machines[0].id).not.toContain('i-0123456789')
    expect(inventory.machines[0].firewalls[0].id).not.toContain('sg-0123456789')
    const rules = await cloud.listFirewallRules(inventory.machines[0].id)
    expect(rules[0].id).toMatch(/^cloud-rule-/)
    expect(rules[0].id).not.toContain('sgr-0123456789')

    await cloud.addFirewallRule(inventory.machines[0].id, {
      firewallId: inventory.machines[0].firewalls[0].id,
      protocol: 'tcp',
      fromPort: 45678,
      toPort: 45678,
      cidr: '127.0.0.1/32',
    })
    await cloud.removeFirewallRule(inventory.machines[0].id, rules[0].id)
    await cloud.getMetrics(inventory.machines[0].id)
    await cloud.power(inventory.machines[0].id, 'reboot')

    expect(adapter.addFirewallRule).toHaveBeenCalledOnce()
    expect(adapter.removeFirewallRule).toHaveBeenCalledOnce()
    expect(adapter.getMetrics).toHaveBeenCalledOnce()
    expect(adapter.power).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'reboot')
    expect(Object.keys(adapter).some((key) => /create|terminate|delete/i.test(key))).toBe(false)
  })

  it('invalidates cached cloud ids as soon as their credential profile is deleted', async () => {
    const { manager } = credentialManager()
    const profile = manager.create({
      kind: 'aws',
      name: 'Temporary account',
      configuration: { accessKeyId: 'AKIATEST', region: 'us-west-1' },
      secrets: { secretAccessKey: 'secret' },
    })
    const adapter = {
      listMachines: vi.fn().mockResolvedValue({
        warnings: [],
        machines: [{ nativeId: 'i-temporary', location: 'us-west-1', name: 'temporary', state: 'running', firewalls: [] }],
      }),
      listFirewallRules: vi.fn(),
      addFirewallRule: vi.fn(),
      removeFirewallRule: vi.fn(),
      getMetrics: vi.fn().mockResolvedValue({ periodSeconds: 300, startTime: '', endTime: '', series: [] }),
      power: vi.fn(),
    } as unknown as CloudProviderAdapter
    const cloud = new CloudProviderManager(manager, { aws: adapter })
    const machine = (await cloud.listMachines(profile.id)).machines[0]

    manager.delete(profile.id)

    await expect(cloud.getMetrics(machine.id)).rejects.toThrow('Credential profile not found')
    expect(adapter.getMetrics).not.toHaveBeenCalled()
  })
})
