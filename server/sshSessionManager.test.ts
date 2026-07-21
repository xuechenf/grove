import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
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

class ExecClient extends EventEmitter {
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

class SftpClient extends EventEmitter {
  private readonly sftpImpl: unknown

  constructor(sftpImpl: unknown) {
    super()
    this.sftpImpl = sftpImpl
  }

  connect() {
    queueMicrotask(() => this.emit('ready'))
    return this
  }

  sftp(callback: (error: Error | undefined, sftp: unknown) => void) {
    callback(undefined, this.sftpImpl)
  }

  end() {}
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

  it('completes a run when the channel reports exit status 0', async () => {
    const client = new ExecClient()
    const manager = new RealSshSessionManager(() => client as unknown as Client)

    const pending = manager.executeCommand({ vm: vms[0], command: 'uptime', actor: 'system', mutating: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.stream.emit('data', Buffer.from('up 2 days'))
    client.stream.emit('exit', 0)
    client.stream.emit('close', 0)
    const run = await pending

    expect(run.status).toBe('completed')
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe('up 2 days')
  })

  it('fails a run whose channel closes without an exit status', async () => {
    const client = new ExecClient()
    const manager = new RealSshSessionManager(() => client as unknown as Client)

    const pending = manager.executeCommand({ vm: vms[0], command: 'apt upgrade -y', actor: 'user', mutating: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.stream.emit('data', Buffer.from('partial output'))
    // The connection drops mid-command: ssh2 emits 'close' with no code and no preceding 'exit'.
    client.stream.emit('close')
    const run = await pending

    expect(run.status).toBe('failed')
    expect(run.summary).toBe('Connection closed before the command finished.')
    expect(run.exitCode).toBeUndefined()
    expect(run.stdout).toBe('partial output')
  })

  it('fails a run killed by a remote signal instead of reporting exit code 0', async () => {
    const client = new ExecClient()
    const manager = new RealSshSessionManager(() => client as unknown as Client)

    const pending = manager.executeCommand({ vm: vms[0], command: 'OOM victim', actor: 'user', mutating: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // ssh2 reports a signal kill as a null exit code on both 'exit' and 'close'.
    client.stream.emit('exit', null, 'SIGKILL')
    client.stream.emit('close', null, 'SIGKILL')
    const run = await pending

    expect(run.status).toBe('failed')
    expect(run.summary).toContain('SIGKILL')
    expect(run.exitCode).toBeUndefined()
  })

  it('closeVmConnection ends the cached client, evicts it, and ignores unknown VMs', async () => {
    const clients: ReadyClient[] = []
    const manager = new RealSshSessionManager(() => {
      const client = new ReadyClient()
      clients.push(client)
      return client as unknown as Client
    })

    await manager.openTerminal(vms[0])
    expect(clients).toHaveLength(1)
    const endSpy = vi.spyOn(clients[0], 'end')

    manager.closeVmConnection('vm-never-connected')
    manager.closeVmConnection(vms[0].id)
    await vi.waitFor(() => expect(endSpy).toHaveBeenCalled())

    // The next operation dials a fresh connection.
    await manager.openTerminal(vms[0])
    expect(clients).toHaveLength(2)
  })

  it('removes the partial file and ends the sftp channel when a download read fails', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'grove-dl-')), 'partial.bin')
    const sftp = {
      createReadStream: () => {
        const stream = new PassThrough()
        setTimeout(() => stream.destroy(new Error('No such file')), 10)
        return stream
      },
      end: vi.fn(),
    }
    const manager = new RealSshSessionManager(() => new SftpClient(sftp) as unknown as Client)

    await expect(
      manager.transferFile({ vm: vms[0], direction: 'download', source: '/remote/partial.bin', target, fileName: 'partial.bin' }),
    ).rejects.toThrow('No such file')
    // The write stream is destroyed first; the partial target is unlinked on its 'close'.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(existsSync(target)).toBe(false)
    expect(sftp.end).toHaveBeenCalled()
  })

  it('writes downloads to disk and reports a completed job', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'grove-dl-')), 'done.bin')
    const sftp = {
      createReadStream: () => Readable.from(['hello world']),
      end: vi.fn(),
    }
    const manager = new RealSshSessionManager(() => new SftpClient(sftp) as unknown as Client)

    const job = await manager.transferFile({ vm: vms[0], direction: 'download', source: '/remote/done.bin', target, fileName: 'done.bin' })

    expect(job.status).toBe('completed')
    expect(job.progress).toBe(100)
    expect(readFileSync(target, 'utf8')).toBe('hello world')
    expect(sftp.end).toHaveBeenCalled()
  })

  it('propagates upload errors without touching the local source', async () => {
    const source = join(mkdtempSync(join(tmpdir(), 'grove-ul-')), 'upload.txt')
    writeFileSync(source, 'payload')
    const sftp = {
      mkdir: (_path: string, callback: () => void) => callback(),
      fastPut: (_local: string, _remote: string, callback: (error?: Error) => void) => callback(new Error('remote disk full')),
      end: vi.fn(),
    }
    const manager = new RealSshSessionManager(() => new SftpClient(sftp) as unknown as Client)

    await expect(
      manager.transferFile({ vm: vms[0], direction: 'upload', source, target: '/remote/upload.txt', fileName: 'upload.txt' }),
    ).rejects.toThrow('remote disk full')

    expect(readFileSync(source, 'utf8')).toBe('payload')
    expect(sftp.end).toHaveBeenCalled()
  })
})
