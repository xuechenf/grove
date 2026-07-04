import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { VM } from '../src/types'
import { vms as fixtureVms } from '../src/data/fixtures'
import { buildFleetAgentsDoc, buildVmAgentsDoc, CopilotSupervisor, mcpProxyLaunchEnv, resolveProxyPath } from './copilotSupervisor'
import type { CopilotDriver, CopilotToolHost, PromptRequest } from './copilotTypes'

class CapturingDriver implements CopilotDriver {
  readonly name = 'mock' as const
  request?: PromptRequest

  async start() {}

  async prompt(request: PromptRequest) {
    this.request = request
    return { text: 'ok', stopReason: 'end_turn' }
  }

  cancel() {}

  async stop() {}

  status() {
    return { driver: 'mock' as const, state: 'ready' as const }
  }
}

const host: CopilotToolHost = {
  listVms: () => fixtureVms,
  getVm: (vmId) => fixtureVms.find((vm) => vm.id === vmId),
  runScopedCommand: async () => ({ ok: true, summary: 'ok' }),
  readRemoteLogs: async () => ({ ok: true, summary: 'ok' }),
  listRemoteFiles: async () => ({ ok: true, summary: 'ok' }),
  serviceStatus: async () => ({ ok: true, summary: 'ok' }),
  inspectVm: async () => ({ ok: true, summary: 'ok' }),
  diagnoseService: async () => ({ ok: true, summary: 'ok' }),
  fleetRunCommand: async () => ({ ok: true, summary: 'ok' }),
  recordNote: () => ({ ok: true, summary: 'ok' }),
  getHistory: () => ({ ok: true, summary: 'ok' }),
}

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

describe('MCP proxy launch config', () => {
  it('uses the checked-in proxy script during local development', () => {
    expect(resolveProxyPath().replace(/\\/g, '/')).toMatch(/server\/mcp\/groveStdioProxy\.mjs$/)
  })

  it('runs the app executable as Node when the backend is hosted by Electron', () => {
    expect(mcpProxyLaunchEnv({ GROVE_MCP_URL: 'http://127.0.0.1:1' }, { electron: '42.0.0' })).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(mcpProxyLaunchEnv({ GROVE_MCP_URL: 'http://127.0.0.1:1' }, {})).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('uses the actual bound backend URL when generating an MCP config', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'grove-supervisor-'))
    try {
      const driver = new CapturingDriver()
      const supervisor = new CopilotSupervisor({
        host,
        driver,
        rootDir,
        backendUrl: 'http://127.0.0.1:8787',
      })
      supervisor.setBackendUrl('http://127.0.0.1:54321')

      await supervisor.prompt('fleet', 'hello', () => {})

      expect(driver.request?.mcp.env.GROVE_MCP_URL).toBe('http://127.0.0.1:54321')
      const config = JSON.parse(readFileSync(driver.request!.mcp.configPath, 'utf8'))
      expect(config.mcpServers.grove.env.GROVE_MCP_URL).toBe('http://127.0.0.1:54321')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
