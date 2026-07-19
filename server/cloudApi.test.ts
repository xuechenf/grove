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
})
