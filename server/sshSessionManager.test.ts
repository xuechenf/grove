import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it } from 'vitest'
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
})
