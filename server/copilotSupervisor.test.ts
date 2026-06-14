import { describe, expect, it } from 'vitest'
import type { VM } from '../src/types'
import { vms as fixtureVms } from '../src/data/fixtures'
import { buildFleetAgentsDoc, buildVmAgentsDoc } from './copilotSupervisor'

/** Flip the volatile fields that used to leak into AGENTS.md and bust the prompt cache. */
function withVolatileChange(vm: VM): VM {
  const next = structuredClone(vm)
  next.health = next.health === 'healthy' ? 'critical' : 'healthy'
  next.lifecycle = next.lifecycle === 'running' ? 'stopped' : 'running'
  next.services = next.services.map((service) => ({
    ...service,
    state: service.state === 'running' ? 'degraded' : 'running',
  }))
  return next
}

describe('AGENTS.md is a cache-stable prefix', () => {
  const fleet = fixtureVms
  const vm = fixtureVms[0]

  it('VM doc is unchanged when only live state changes', () => {
    const before = buildVmAgentsDoc(vm, fleet)
    const after = buildVmAgentsDoc(withVolatileChange(vm), fleet.map(withVolatileChange))
    expect(after).toBe(before)
    expect(before).not.toContain('## Tracked services')
  })

  it('fleet doc is unchanged when only lifecycle/health change', () => {
    const before = buildFleetAgentsDoc(fleet)
    const after = buildFleetAgentsDoc(fleet.map(withVolatileChange))
    expect(after).toBe(before)
    // Stable identifiers stay; volatile status does not.
    expect(before).toContain(vm.id)
    expect(before).not.toMatch(/running\/healthy|stopped\/critical/)
  })
})
