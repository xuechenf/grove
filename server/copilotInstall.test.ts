import { describe, expect, it, vi } from 'vitest'
import { installKimiCli, type InstallLog } from './copilotInstall'

/** A run() spy that records the command + argv it was invoked with and succeeds by default. */
function recordingRun(exitCode = 0) {
  const calls: { command: string; args: string[] }[] = []
  const run = vi.fn(async (command: string, args: string[], onLog: InstallLog) => {
    calls.push({ command, args })
    onLog(`$ ${command} ${args.join(' ')}`)
    return exitCode
  })
  return { calls, run }
}

describe('installKimiCli', () => {
  it('installs kimi-cli with an existing uv and does not bootstrap uv', async () => {
    const { calls, run } = recordingRun()
    const result = await installKimiCli(() => undefined, {
      platform: 'linux',
      home: '/home/op',
      run,
      findUv: () => '/home/op/.local/bin/uv',
      findKimi: () => '/home/op/.local/bin/kimi',
    })

    expect(result).toEqual({ ok: true, binary: '/home/op/.local/bin/kimi' })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/home/op/.local/bin/uv')
    expect(calls[0].args).toEqual(['tool', 'install', '--force', 'kimi-cli'])
  })

  it('bootstraps uv from astral.sh first when uv is missing (Unix)', async () => {
    const { calls, run } = recordingRun()
    let uvReady = false
    const wrapped = vi.fn(async (command: string, args: string[], onLog: InstallLog) => {
      const code = await run(command, args, onLog)
      if (command === 'sh') {
        uvReady = true // the astral installer has now placed uv
      }
      return code
    })

    const result = await installKimiCli(() => undefined, {
      platform: 'linux',
      home: '/home/op',
      run: wrapped,
      findUv: () => (uvReady ? '/home/op/.local/bin/uv' : undefined),
      findKimi: () => '/home/op/.local/bin/kimi',
    })

    expect(result.ok).toBe(true)
    expect(calls[0].command).toBe('sh')
    expect(calls[0].args.join(' ')).toContain('astral.sh/uv/install.sh')
    expect(calls[1].args).toEqual(['tool', 'install', '--force', 'kimi-cli'])
  })

  it('uses the PowerShell installer to bootstrap uv on Windows', async () => {
    const { calls, run } = recordingRun()
    let uvReady = false
    const wrapped = vi.fn(async (command: string, args: string[], onLog: InstallLog) => {
      const code = await run(command, args, onLog)
      uvReady = true
      return code
    })

    const result = await installKimiCli(() => undefined, {
      platform: 'win32',
      home: 'C:\\Users\\op',
      run: wrapped,
      findUv: () => (uvReady ? 'C:\\Users\\op\\.local\\bin\\uv.exe' : undefined),
      findKimi: () => 'C:\\Users\\op\\.local\\bin\\kimi.exe',
    })

    expect(result.ok).toBe(true)
    expect(calls[0].command).toBe('powershell.exe')
    expect(calls[0].args.join(' ')).toContain('astral.sh/uv/install.ps1')
  })

  it('reports an error when `uv tool install` exits non-zero', async () => {
    const { run } = recordingRun(1)
    const result = await installKimiCli(() => undefined, {
      platform: 'linux',
      home: '/home/op',
      run,
      findUv: () => '/home/op/.local/bin/uv',
      findKimi: () => undefined,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('uv tool install')
  })

  it('reports an error when kimi is still missing after a successful install', async () => {
    const result = await installKimiCli(() => undefined, {
      platform: 'linux',
      home: '/home/op',
      run: async () => 0,
      findUv: () => '/home/op/.local/bin/uv',
      findKimi: () => undefined,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/kimi/i)
  })
})
