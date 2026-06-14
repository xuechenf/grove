import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CopilotScope } from '../../src/types'
import type { PromptRequest } from '../copilotTypes'
import { AcpDriver } from './acpDriver'
import { formatKimiLaunchError, kimiBinaryFromEnv, resolveKimiBinary } from './kimiBinary'
import { PrintDriver } from './printDriver'

const missingBinary = 'grove-missing-kimi-binary'
const originalKimiBin = process.env.GROVE_KIMI_BIN
const originalSessionTurns = process.env.GROVE_KIMI_SESSION_TURNS

afterEach(() => {
  if (originalKimiBin === undefined) {
    delete process.env.GROVE_KIMI_BIN
  } else {
    process.env.GROVE_KIMI_BIN = originalKimiBin
  }
  if (originalSessionTurns === undefined) {
    delete process.env.GROVE_KIMI_SESSION_TURNS
  } else {
    process.env.GROVE_KIMI_SESSION_TURNS = originalSessionTurns
  }
})

function promptRequest(scope: CopilotScope = 'fleet'): PromptRequest {
  return {
    scope,
    cwd: process.cwd(),
    mcp: {
      name: 'grove',
      command: process.execPath,
      args: [],
      env: {},
      configPath: 'missing-mcp-config.json',
    },
    message: 'status?',
    onUpdate: vi.fn(),
  }
}

/** A spawn stub that records argv and resolves the turn immediately (empty output, exit 0). */
function recordingSpawn() {
  const calls: string[][] = []
  const spawnStub = ((_command: string, args: string[]) => {
    calls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable }
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    setImmediate(() => child.emit('close', 0))
    return child
  }) as unknown as typeof spawn
  return { calls, spawnStub }
}

function sessionArg(args: string[]): string | undefined {
  const index = args.indexOf('--session')
  return index >= 0 ? args[index + 1] : undefined
}

describe('kimi binary configuration', () => {
  it('uses GROVE_KIMI_BIN when set', () => {
    process.env.GROVE_KIMI_BIN = 'C:\\tools\\kimi.exe'

    expect(kimiBinaryFromEnv()).toBe('C:\\tools\\kimi.exe')
  })

  it('keeps the bare name when kimi already resolves on PATH', () => {
    const onPath = resolveKimiBinary({
      env: undefined,
      platform: 'linux',
      home: '/home/op',
      pathEnv: '/usr/bin:/usr/local/bin',
      exists: (path) => path === '/usr/local/bin/kimi',
    })

    expect(onPath).toBe('kimi')
  })

  it('discovers the uv-installed binary in ~/.local/bin when it is not on PATH', () => {
    const discovered = resolveKimiBinary({
      env: undefined,
      platform: 'win32',
      home: 'C:\\Users\\op',
      pathEnv: 'C:\\Windows;C:\\Windows\\System32',
      exists: (path) => path === join('C:\\Users\\op', '.local', 'bin', 'kimi.exe'),
    })

    expect(discovered).toBe(join('C:\\Users\\op', '.local', 'bin', 'kimi.exe'))
  })

  it('discovers a Homebrew/uv kimi on macOS when it is not on PATH', () => {
    // join() uses the host separator, like the production code, so the expected paths match
    // regardless of which OS runs the test.
    const brewPath = join('/opt/homebrew/bin', 'kimi')
    const brew = resolveKimiBinary({
      env: undefined,
      platform: 'darwin',
      home: '/Users/op',
      pathEnv: '/usr/bin:/bin',
      exists: (path) => path === brewPath,
    })
    expect(brew).toBe(brewPath)

    const uvPath = join('/Users/op', '.local', 'bin', 'kimi')
    const uv = resolveKimiBinary({
      env: undefined,
      platform: 'darwin',
      home: '/Users/op',
      pathEnv: '/usr/bin:/bin',
      exists: (path) => path === uvPath,
    })
    expect(uv).toBe(uvPath)
  })

  it('falls back to the bare name when kimi is nowhere, so the ENOENT guidance fires', () => {
    const fallback = resolveKimiBinary({
      env: undefined,
      platform: 'linux',
      home: '/home/op',
      pathEnv: '/usr/bin',
      exists: () => false,
    })

    expect(fallback).toBe('kimi')
  })

  it('formats missing binary errors with setup guidance', () => {
    const error = Object.assign(new Error('spawn kimi ENOENT'), { code: 'ENOENT' })

    expect(formatKimiLaunchError(error, 'kimi')).toContain('uv tool install kimi-cli')
    expect(formatKimiLaunchError(error, 'kimi')).toContain('GROVE_KIMI_BIN')
  })
})

describe('PrintDriver session lifecycle', () => {
  it('runs stateless by default — no --session, so kimi never re-sends history', async () => {
    const { calls, spawnStub } = recordingSpawn()
    const driver = new PrintDriver({ binary: 'kimi', spawn: spawnStub })

    await driver.prompt(promptRequest())
    await driver.prompt(promptRequest())

    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toContain('--session')
    expect(calls[1]).not.toContain('--session')
  })

  it('rotates the session id every GROVE_KIMI_SESSION_TURNS turns', async () => {
    process.env.GROVE_KIMI_SESSION_TURNS = '3'
    const { calls, spawnStub } = recordingSpawn()
    const driver = new PrintDriver({ binary: 'kimi', spawn: spawnStub })

    for (let i = 0; i < 4; i += 1) {
      await driver.prompt(promptRequest())
    }

    const ids = calls.map(sessionArg)
    expect(ids[0]).toBeDefined()
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2]) // turns 1-3 share one session
    expect(ids[3]).not.toBe(ids[2]) // turn 4 rotates to a fresh session
  })

  it('keeps per-scope turn counters independent', async () => {
    process.env.GROVE_KIMI_SESSION_TURNS = '2'
    const { calls, spawnStub } = recordingSpawn()
    const driver = new PrintDriver({ binary: 'kimi', spawn: spawnStub })

    await driver.prompt(promptRequest('fleet'))
    await driver.prompt(promptRequest('vm:vm-orchid'))

    const fleetId = sessionArg(calls[0])
    const vmId = sessionArg(calls[1])
    expect(fleetId).toContain('grove-fleet')
    expect(vmId).toContain('grove-vm-vm-orchid')
  })
})

describe('PrintDriver', () => {
  it('returns actionable setup guidance when kimi is missing', async () => {
    const driver = new PrintDriver({ binary: missingBinary })

    const result = await driver.prompt(promptRequest())

    expect(result.stopReason).toBe('error')
    expect(result.text).toContain(`"${missingBinary}" was not found`)
    expect(result.text).toContain('uv tool install kimi-cli')
    expect(result.text).toContain('GROVE_KIMI_BIN')
    expect(driver.status().state).toBe('error')
    expect(driver.status().detail).toBe(result.text)
  })
})

describe('AcpDriver', () => {
  it('reports actionable setup guidance when kimi is missing', async () => {
    const driver = new AcpDriver({ binary: missingBinary })

    await expect(driver.start()).rejects.toThrow(`"${missingBinary}" was not found`)

    expect(driver.status().state).toBe('error')
    expect(driver.status().detail).toContain('uv tool install kimi-cli')
    await driver.stop()
  })
})
