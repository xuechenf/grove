import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { CloudControlService } from './cloudProvider'
import { createGroveApp } from './app'
import { GroveStore } from './store'

function cloudService(): CloudControlService {
  return {
    listMachines: vi.fn().mockResolvedValue({
      scannedAt: '2026-07-20T01:00:00.000Z',
      warnings: [],
      machines: [{
        id: 'cloud-machine-one',
        provider: 'aws',
        credentialProfileId: 'credential-one',
        credentialProfileName: 'Cloud account',
        name: 'nrt',
        location: 'region-one',
        state: 'running',
        firewalls: [{ id: 'cloud-firewall-one', name: 'web' }],
      }],
    }),
    listFirewallRules: vi.fn().mockResolvedValue([]),
    addFirewallRule: vi.fn().mockResolvedValue([]),
    removeFirewallRule: vi.fn().mockResolvedValue([]),
    getMetrics: vi.fn().mockResolvedValue({
      machineId: 'cloud-machine-one',
      periodSeconds: 300,
      startTime: '2026-07-20T00:00:00.000Z',
      endTime: '2026-07-20T01:00:00.000Z',
      series: [],
    }),
    power: vi.fn().mockResolvedValue({
      id: 'cloud-machine-one',
      provider: 'aws',
      credentialProfileId: 'credential-one',
      credentialProfileName: 'Cloud account',
      name: 'nrt',
      location: 'region-one',
      state: 'running',
      firewalls: [],
    }),
  }
}

describe('provider-neutral cloud API', () => {
  it('supports inventory, metrics, firewall modification, and power but has no creation route', async () => {
    const cloud = cloudService()
    const { app } = createGroveApp(new GroveStore(undefined, { cloudControl: cloud }))

    expect((await request(app).get('/api/cloud/machines').expect(200)).body.machines).toHaveLength(1)
    await request(app).get('/api/cloud/machines/cloud-machine-one/metrics?hours=2').expect(200)
    await request(app).post('/api/cloud/machines/cloud-machine-one/firewall-rules').send({
      firewallId: 'cloud-firewall-one',
      protocol: 'tcp',
      fromPort: 45678,
      toPort: 45678,
      cidr: '127.0.0.1/32',
    }).expect(201)
    await request(app).delete('/api/cloud/machines/cloud-machine-one/firewall-rules/cloud-rule-one').expect(200)
    await request(app).post('/api/cloud/machines/cloud-machine-one/power').send({ action: 'reboot' }).expect(200)
    await request(app).post('/api/cloud/machines').send({ name: 'forbidden' }).expect(404)

    expect(cloud.addFirewallRule).toHaveBeenCalledOnce()
    expect(cloud.removeFirewallRule).toHaveBeenCalledOnce()
    expect(cloud.getMetrics).toHaveBeenCalledWith('cloud-machine-one', 2)
    expect(cloud.power).toHaveBeenCalledWith('cloud-machine-one', 'reboot')
  })

  it('matches an inventory VM by IP and returns provider-backed Overview telemetry', async () => {
    const originalFixtures = process.env.GROVE_USE_FIXTURES
    process.env.GROVE_USE_FIXTURES = 'true'
    try {
      const cloud = cloudService()
      const store = new GroveStore(undefined, { cloudControl: cloud })
      const vm = store.listVms()[0]
      vi.mocked(cloud.listMachines).mockResolvedValue({
        scannedAt: '2026-07-20T01:00:00.000Z',
        warnings: [],
        machines: [{
          id: 'cloud-machine-one',
          provider: 'aws',
          credentialProfileId: 'credential-one',
          credentialProfileName: 'AWS account',
          name: vm.name,
          location: 'ap-northeast-1',
          state: 'running',
          publicIp: vm.connection.host,
          firewalls: [],
        }],
      })
      const { app } = createGroveApp(store)

      const overview = (await request(app).get(`/api/vms/${vm.id}/overview`).expect(200)).body

      expect(overview.source).toBe('aws')
      expect(overview.sourceLabel).toBe('AWS EC2 + CloudWatch')
      expect(overview.cloudMachine.state).toBe('running')
      expect(cloud.getMetrics).toHaveBeenCalledWith('cloud-machine-one', 1)
    } finally {
      if (originalFixtures === undefined) delete process.env.GROVE_USE_FIXTURES
      else process.env.GROVE_USE_FIXTURES = originalFixtures
    }
  })

  it('returns Azure-backed Overview telemetry through the provider-neutral API', async () => {
    const originalFixtures = process.env.GROVE_USE_FIXTURES
    process.env.GROVE_USE_FIXTURES = 'true'
    try {
      const cloud = cloudService()
      const store = new GroveStore(undefined, { cloudControl: cloud })
      const vm = store.listVms()[0]
      vi.mocked(cloud.listMachines).mockResolvedValue({
        scannedAt: '2026-07-21T01:00:00.000Z', warnings: [], machines: [{
          id: 'azure-machine-one', provider: 'azure', credentialProfileId: 'azure-credential', credentialProfileName: 'Azure subscription',
          name: vm.name, location: 'eastus', state: 'running', publicIp: vm.connection.host, firewalls: [],
        }],
      })
      vi.mocked(cloud.getMetrics).mockResolvedValue({
        machineId: 'azure-machine-one', periodSeconds: 60, startTime: '2026-07-21T00:00:00.000Z', endTime: '2026-07-21T01:00:00.000Z', series: [],
      })

      const overview = (await request(createGroveApp(store).app).get(`/api/vms/${vm.id}/overview`).expect(200)).body

      expect(overview.source).toBe('azure')
      expect(overview.sourceLabel).toBe('Azure VM + Azure Monitor')
      expect(cloud.getMetrics).toHaveBeenCalledWith('azure-machine-one', 1)
    } finally {
      if (originalFixtures === undefined) delete process.env.GROVE_USE_FIXTURES
      else process.env.GROVE_USE_FIXTURES = originalFixtures
    }
  })
})
