import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { vms } from '../src/data/fixtures'
import { RealSshSessionManager } from './sshSessionManager'

class FailingClient extends EventEmitter {
  connect() {
    queueMicrotask(() => {
      this.emit('error', new Error('Connection lost before handshake'))
      this.emit('error', new Error('late protocol failure'))
    })
    return this
  }

  end() {
    this.emit('end')
  }
}

class ReadyClient extends EventEmitter {
  connect() {
    queueMicrotask(() => this.emit('ready'))
    return this
  }

  end() {
    this.emit('end')
  }
}

describe('RealSshSessionManager', () => {
  it('turns repeated handshake errors into a failed command run', async () => {
    const client = new FailingClient()
    const manager = new RealSshSessionManager(() => client as unknown as Client)

    const run = await manager.executeCommand({
      vm: vms[0],
      command: 'uptime',
      actor: 'system',
      mutating: false,
    })

    expect(run.status).toBe('failed')
    expect(run.stderr).toContain('Connection lost before handshake')
    expect(client.emit('error', new Error('post-failure protocol error'))).toBe(true)
  })

  it('evicts a ready client after a late SSH client error', async () => {
    const clients: ReadyClient[] = []
    const manager = new RealSshSessionManager(() => {
      const client = new ReadyClient()
      clients.push(client)
      return client as unknown as Client
    })

    await expect(manager.openTerminal(vms[0])).resolves.toMatchObject({ vmId: vms[0].id, status: 'open' })
    expect(clients).toHaveLength(1)

    expect(clients[0].emit('error', new Error('connection lost after ready'))).toBe(true)

    await expect(manager.openTerminal(vms[0])).resolves.toMatchObject({ vmId: vms[0].id, status: 'open' })
    expect(clients).toHaveLength(2)
  })

  it('does not let a stale client\'s late close evict its replacement', async () => {
    const clients: ReadyClient[] = []
    const manager = new RealSshSessionManager(() => {
      const client = new ReadyClient()
      clients.push(client)
      return client as unknown as Client
    })

    await manager.openTerminal(vms[0])
    expect(clients).toHaveLength(1)

    // Drop the first client, reconnect, then let the stale client emit a late close.
    clients[0].emit('error', new Error('connection lost after ready'))
    await manager.openTerminal(vms[0])
    expect(clients).toHaveLength(2)

    clients[0].emit('close')
    clients[0].emit('end')

    // The replacement must still be cached: no third connection.
    await manager.openTerminal(vms[0])
    expect(clients).toHaveLength(2)
  })

  it('warms a connection ahead of the first command and swallows failures', async () => {
    const readyClients: ReadyClient[] = []
    const manager = new RealSshSessionManager(() => {
      const client = new ReadyClient()
      readyClients.push(client)
      return client as unknown as Client
    })

    await manager.warmConnection(vms[0])
    expect(readyClients).toHaveLength(1)
    // The warmed client is reused: no new connection for the next operation.
    await manager.openTerminal(vms[0])
    expect(readyClients).toHaveLength(1)

    const failing = new RealSshSessionManager(() => new FailingClient() as unknown as Client)
    await expect(failing.warmConnection(vms[0])).resolves.toBeUndefined()
  })

  it('times out a hung command and resolves a failed run', async () => {
    class HangingExecClient extends EventEmitter {
      stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: vi.fn(),
        signal: vi.fn(),
      })

      connect() {
        queueMicrotask(() => this.emit('ready'))
        return this
      }

      exec(_command: string, callback: (error: Error | undefined, stream: unknown) => void) {
        callback(undefined, this.stream)
        return true
      }

      end() {}
    }

    vi.useFakeTimers()
    try {
      const client = new HangingExecClient()
      const manager = new RealSshSessionManager(() => client as unknown as Client)
      const pending = manager.executeCommand({ vm: vms[0], command: 'sleep infinity', actor: 'copilot', mutating: false })

      await vi.advanceTimersByTimeAsync(120_000)
      const run = await pending

      expect(run.status).toBe('failed')
      expect(run.summary).toContain('timed out after 120s')
      expect(client.stream.signal).toHaveBeenCalledWith('KILL')
      expect(client.stream.close).toHaveBeenCalled()
      // A late close after the timeout must not double-settle or throw.
      client.stream.emit('close', 0)
    } finally {
      vi.useRealTimers()
    }
  })
})
