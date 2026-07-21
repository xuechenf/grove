import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startGroveServer, type GroveServerHandle } from './start'

/**
 * The HTTP token middleware never sees WebSocket upgrades, so server/start.ts re-checks the
 * per-boot UI token (and the Origin, when present) in its own upgrade handler. These tests
 * boot a real server and drive it with a real WS client: without this gate any web page
 * could open a cross-origin socket straight into an interactive SSH shell on every VM.
 */
describe('Grove server transport auth', () => {
  const originalStateDir = process.env.GROVE_STATE_DIR
  const originalFixtures = process.env.GROVE_USE_FIXTURES
  let stateDir: string
  let server: GroveServerHandle | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'grove-start-test-'))
    process.env.GROVE_STATE_DIR = stateDir
    process.env.GROVE_USE_FIXTURES = 'true'
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (originalStateDir === undefined) delete process.env.GROVE_STATE_DIR
    else process.env.GROVE_STATE_DIR = originalStateDir
    if (originalFixtures === undefined) delete process.env.GROVE_USE_FIXTURES
    else process.env.GROVE_USE_FIXTURES = originalFixtures
    rmSync(stateDir, { recursive: true, force: true })
  })

  function tryConnect(path: string, headers?: Record<string, string>) {
    return new Promise<{ opened: boolean; firstMessage?: string }>((resolve) => {
      let settled = false
      let opened = false
      const done = (result: { opened: boolean; firstMessage?: string }) => {
        if (!settled) {
          settled = true
          resolve(result)
        }
      }
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}${path}`, { headers })
      socket.on('open', () => {
        opened = true
      })
      socket.on('message', (data) => {
        socket.close()
        done({ opened, firstMessage: String(data) })
      })
      socket.on('error', () => {
        // A rejected upgrade surfaces as an error followed by close; nothing to do.
      })
      socket.on('close', () => done({ opened }))
      setTimeout(() => {
        socket.close()
        done({ opened })
      }, 3000)
    })
  }

  it('serves bootstrap runtime status without disclosing the UI token', async () => {
    server = await startGroveServer({ port: 0 })

    const response = await fetch(`${server.url}/api/bootstrap`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.runtime).toBeDefined()
    expect(body.token).toBeUndefined()
  })

  it('rejects events WebSocket upgrades without the UI token', async () => {
    server = await startGroveServer({ port: 0 })

    expect((await tryConnect('/api/events')).opened).toBe(false)
    expect((await tryConnect('/api/events?token=wrong')).opened).toBe(false)
  })

  it('accepts events WebSocket upgrades carrying the UI token', async () => {
    server = await startGroveServer({ port: 0 })

    const result = await tryConnect(`/api/events?token=${server.uiToken}`)
    expect(result.opened).toBe(true)
    expect(result.firstMessage).toContain('"snapshot"')
  })

  it('rejects upgrades from non-loopback browser origins even with a valid token', async () => {
    server = await startGroveServer({ port: 0 })

    const result = await tryConnect(`/api/events?token=${server.uiToken}`, { origin: 'https://evil.example.com' })
    expect(result.opened).toBe(false)
  })

  it('rejects terminal WebSocket upgrades without the UI token', async () => {
    server = await startGroveServer({ port: 0 })

    expect((await tryConnect('/api/vms/any-vm/terminal')).opened).toBe(false)
  })

  /** Drive a raw TCP socket through the WS upgrade so malformed frames can be sent by hand. */
  function rawUpgrade(path: string) {
    return new Promise<Socket>((resolve, reject) => {
      const socket = connect(server!.port, '127.0.0.1')
      socket.on('error', reject)
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${server!.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
      socket.once('data', (data) => {
        if (data.toString().includes(' 101 ')) {
          resolve(socket)
        } else {
          reject(new Error(`upgrade refused: ${data.toString().split('\r\n')[0]}`))
        }
      })
    })
  }

  // Masked text frame whose payload [0xC3, 0x28] is invalid UTF-8. ws reports this as an
  // 'error' event; without a listener that throws and used to crash the whole backend.
  function malformedUtf8Frame() {
    const mask = Buffer.from([1, 2, 3, 4])
    const payload = Buffer.from([0xc3 ^ 1, 0x28 ^ 2])
    return Buffer.concat([Buffer.from([0x81, 0x82]), mask, payload])
  }

  async function expectServerSurvivesMalformedFrame(path: string) {
    const socket = await rawUpgrade(path)
    socket.write(malformedUtf8Frame())
    await Promise.race([
      once(socket, 'close'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('server kept the malformed socket open')), 3000)),
    ])
    // The process survived and the backend still answers HTTP.
    const response = await fetch(`${server!.url}/api/bootstrap`)
    expect(response.status).toBe(200)
  }

  it('closes events sockets that send malformed frames and keeps serving', async () => {
    server = await startGroveServer({ port: 0 })

    await expectServerSurvivesMalformedFrame(`/api/events?token=${server.uiToken}`)
  })

  it('closes terminal sockets that send malformed frames and keeps serving', async () => {
    server = await startGroveServer({ port: 0 })

    await expectServerSurvivesMalformedFrame(`/api/vms/any-vm/terminal?token=${server.uiToken}`)
  })

  it('ends the PTY when the browser disconnects while the shell is opening', async () => {
    server = await startGroveServer({ port: 0 })
    const streamEnd = vi.fn()
    let resolveShell!: (shell: unknown) => void
    server.store.openTerminalShell = (() =>
      new Promise((resolve) => {
        resolveShell = resolve
      })) as never

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/vms/any-vm/terminal?token=${server.uiToken}`)
    await new Promise<void>((resolve) => socket.on('open', () => resolve()))
    socket.close()
    // Let the close reach the server while the SSH handshake is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 100))

    resolveShell({
      session: { id: 'term-test', vmId: 'any-vm', status: 'open', createdAt: '', lastActivityAt: '' },
      stream: { end: streamEnd },
    })
    await vi.waitFor(() => expect(streamEnd).toHaveBeenCalled())
    socket.terminate()
  })
})
