import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { CommandRun, FileNode, TerminalSession, TransferJob, VM } from '../src/types'
import { collectLocalProjectFiles } from './localProjectFiles'
import { resolveProjectStateReference } from './projectState'

export interface CommandExecutionRequest {
  vm: VM
  command: string
  actor: CommandRun['actor']
  mutating: boolean
}

export interface SshSessionManager {
  executeCommand(request: CommandExecutionRequest): Promise<CommandRun>
  openTerminal(vm: VM): Promise<TerminalSession>
  openTerminalShell?(vm: VM, options: TerminalShellOptions): Promise<TerminalShell>
  listFiles(vm: VM, path: string): Promise<FileNode[]>
  transferFile?(request: FileTransferExecutionRequest): Promise<TransferJob>
  uploadDirectory?(request: DirectoryUploadExecutionRequest): Promise<DirectoryUploadResult>
}

export interface TerminalShellOptions {
  cols: number
  rows: number
}

export interface TerminalShell {
  session: TerminalSession
  stream: ClientChannel
}

export interface FileTransferExecutionRequest {
  vm: VM
  direction: TransferJob['direction']
  source: string
  target: string
  fileName: string
  conflict?: TransferJob['conflict']
}

export interface DirectoryUploadExecutionRequest {
  vm: VM
  sourcePath: string
  targetPath: string
}

export interface DirectoryUploadResult {
  fileCount: number
}

function nowIso() {
  return new Date().toISOString()
}

function outputFor(command: string, vm: VM) {
  if (vm.lifecycle !== 'running') {
    return {
      stdout: '',
      stderr: `ssh: connect to host ${vm.connection.host} port ${vm.connection.port}: VM is not running`,
      exitCode: 255,
      summary: 'SSH connection failed because the VM is not running.',
    }
  }

  if (command.includes('__GROVE_PROCESSES__') && command.includes('__GROVE_SERVICES__')) {
    return {
      stdout: [
        `HOSTNAME=${vm.hostname}`,
        `OS=${vm.os}`,
        `UPTIME=${vm.metrics.uptime}`,
        `LOAD=${vm.metrics.loadAverage.join(',')}`,
        `CPUS=${vm.resources.cpuCores}`,
        `MEM_TOTAL_MB=${vm.resources.memoryGb * 1024}`,
        `MEM_USED_MB=${Math.round((vm.resources.memoryGb * 1024 * vm.metrics.memoryPercent) / 100)}`,
        `DISK_TOTAL_KB=${vm.resources.diskGb * 1024 * 1024}`,
        `DISK_USED_KB=${Math.round((vm.resources.diskGb * 1024 * 1024 * vm.metrics.diskPercent) / 100)}`,
        `DISK_PCT=${vm.metrics.diskPercent}%`,
        '__GROVE_PROCESSES__',
        ...vm.processes.map((process) =>
          `${process.pid} ${process.user} ${process.cpuPercent} ${process.memoryMb * 1024} ${process.command}`,
        ),
        '__GROVE_SERVICES__',
        ...vm.services.map((service) =>
          [
            service.name,
            service.state,
            service.port ?? '',
            service.cpuPercent,
            service.memoryMb * 1024,
          ].join('\t'),
        ),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'Runtime inventory collected over SSH.',
    }
  }

  if (command.includes('__GROVE_SHADOWSOCKS_INSTALLED_DIAGNOSTIC__')) {
    return {
      stdout: [
        '__GROVE_SHADOWSOCKS_INSTALLED_DIAGNOSTIC__',
        'binaries:',
        'packages:',
        'python-packages:',
        'unit-files:',
        'config-paths:',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'Shadowsocks installation diagnostic collected over SSH.',
    }
  }

  if (command.includes('__GROVE_SHADOWSOCKS_DIAGNOSTIC__')) {
    const serviceLines = vm.services
      .filter((service) => /shadowsocks|ssserver|ss-local|ss-redir|ss-manager/i.test(service.name))
      .map((service) => `${service.name}.service loaded ${service.state}`)
    const processLines = vm.processes
      .filter((process) => /shadowsocks|ssserver|ss-local|ss-redir|ss-manager/i.test(process.command))
      .map((process) => `${process.pid} ${process.user} ${process.command}`)
    return {
      stdout: [
        '__GROVE_SHADOWSOCKS_DIAGNOSTIC__',
        'services:',
        ...serviceLines,
        'processes:',
        ...processLines,
        'listeners:',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'Shadowsocks diagnostic collected over SSH.',
    }
  }

  if (command.includes('__GROVE_HOME__')) {
    return {
      stdout: ['__GROVE_HOME__', `/home/${vm.connection.user}`].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'Remote home resolved over SSH.',
    }
  }

  if (command.includes('__GROVE_APPRUNNER_STATUS__')) {
    const unitName = command.match(/UNIT='([^']+)'/)?.[1] ?? ''
    const port = Number(command.match(/PORT='?(\d+)'?/)?.[1]) || undefined
    const service = vm.appServices.find((item) => item.unitName === unitName)
    return {
      stdout: [
        '__GROVE_APPRUNNER_STATUS__',
        `state=${service?.state ?? 'running'}`,
        `pid=${service?.pid ?? 4242}`,
        `cpu=${service?.cpuPercent ?? 1.5}`,
        `rss=${(service?.memoryMb ?? 96) * 1024}`,
        `listening=${(service?.listening ?? Boolean(port)) ? 1 : 0}`,
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'AppRunner service status collected over SSH.',
    }
  }

  if (command.includes('df')) {
    return {
      stdout: `/dev/vda1   ${vm.resources.diskGb}G  ${Math.round(
        (vm.resources.diskGb * vm.metrics.diskPercent) / 100,
      )}G  ${Math.round(vm.resources.diskGb * (1 - vm.metrics.diskPercent / 100))}G  ${vm.metrics.diskPercent}% /`,
      stderr: '',
      exitCode: 0,
      summary: 'Disk usage collected over SSH.',
    }
  }

  if (command.includes('free')) {
    return {
      stdout: `Mem: ${vm.resources.memoryGb}Gi ${Math.round(
        (vm.resources.memoryGb * vm.metrics.memoryPercent) / 100,
      )}Gi ${Math.round(vm.resources.memoryGb * (1 - vm.metrics.memoryPercent / 100))}Gi`,
      stderr: '',
      exitCode: 0,
      summary: 'Memory usage collected over SSH.',
    }
  }

  if (command.includes('systemctl --failed')) {
    const failed = vm.services.filter((service) => service.state !== 'running')
    return {
      stdout: failed.map((service) => `${service.name}.service ${service.state}`).join('\n') || '0 loaded units listed.',
      stderr: '',
      exitCode: 0,
      summary: 'Service status collected over SSH.',
    }
  }

  if (command.includes('journalctl') || command.includes('tail')) {
    return {
      stdout: 'Jun 07 11:17 sshd[3912]: session opened for user\nJun 07 11:17 grove-agent: heartbeat ok',
      stderr: '',
      exitCode: 0,
      summary: 'Recent logs collected over SSH.',
    }
  }

  if (command.trim() === 'ls') {
    return {
      stdout: 'README.md\npackage.json\nserver\nsrc',
      stderr: '',
      exitCode: 0,
      summary: 'Root folder listing collected over SSH.',
    }
  }

  if (command.includes('reboot')) {
    return {
      stdout: 'Reboot requested. SSH connection will drop shortly.',
      stderr: '',
      exitCode: 0,
      summary: 'Reboot command sent over SSH.',
    }
  }

  if (command.includes('grove-apprunner-') || command.includes('planter-apprunner-') || command.includes('systemctl enable --now')) {
    return {
      stdout: 'active',
      stderr: '',
      exitCode: 0,
      summary: 'AppRunner service command completed over SSH.',
    }
  }

  return {
    stdout: `${vm.hostname} up ${vm.metrics.uptime}, load average: ${vm.metrics.loadAverage.join(', ')}`,
    stderr: '',
    exitCode: 0,
    summary: 'Command completed over SSH.',
  }
}

export class MockSshSessionManager implements SshSessionManager {
  async executeCommand({ vm, command, actor, mutating }: CommandExecutionRequest): Promise<CommandRun> {
    const startedAt = nowIso()
    const output = outputFor(command, vm)

    return {
      id: `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      vmId: vm.id,
      actor,
      command,
      status: output.exitCode === 0 ? 'completed' : 'failed',
      startedAt,
      completedAt: nowIso(),
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
      summary: output.summary,
      mutating,
    }
  }

  async openTerminal(vm: VM): Promise<TerminalSession> {
    const timestamp = nowIso()

    return {
      id: `term-${vm.id}-${Date.now()}`,
      vmId: vm.id,
      status: vm.lifecycle === 'running' ? 'open' : 'failed',
      createdAt: timestamp,
      lastActivityAt: timestamp,
    }
  }

  async openTerminalShell(vm: VM, options: TerminalShellOptions): Promise<TerminalShell> {
    const session = await this.openTerminal(vm)
    throw new Error(`Interactive shell is unavailable in mock mode (${options.cols}x${options.rows}, ${session.id}).`)
  }

  async listFiles(vm: VM, path: string): Promise<FileNode[]> {
    const { remoteFilesByVm } = await import('../src/data/fixtures')
    const files = remoteFilesByVm[vm.id] ?? []
    return files.filter((file) => file.path.startsWith(path === '/' ? '/' : path) || path === '/remote/path')
  }

  async uploadDirectory({ sourcePath }: DirectoryUploadExecutionRequest): Promise<DirectoryUploadResult> {
    return { fileCount: collectLocalProjectFiles(sourcePath).length }
  }
}

function expandPath(path: string) {
  return resolveProjectStateReference(path)
}

function fileTypeFromMode(mode: number): FileNode['type'] {
  return (mode & 0o170000) === 0o040000 ? 'folder' : 'file'
}

function formatModifiedTime(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

async function mkdirRemote(sftp: SFTPWrapper, path: string) {
  const normalized = path.replace(/\/+$/, '').replace(/\/+/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  let current = normalized.startsWith('/') ? '' : '.'

  for (const part of parts) {
    current = current === '' ? `/${part}` : posix.join(current, part)
    await new Promise<void>((resolveMkdir) => {
      sftp.mkdir(current, () => resolveMkdir())
    })
  }
}

async function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string) {
  await new Promise<void>((resolvePut, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolvePut()
    })
  })
}

export class RealSshSessionManager implements SshSessionManager {
  private readonly clients = new Map<string, Promise<Client>>()
  private readonly clientFactory: () => Client

  constructor(clientFactory: () => Client = () => new Client()) {
    this.clientFactory = clientFactory
  }

  async executeCommand(request: CommandExecutionRequest): Promise<CommandRun> {
    const startedAt = nowIso()
    const firstRun = await this.executeCommandOnce(request, startedAt)
    const errorText = `${firstRun.stderr ?? ''} ${firstRun.summary}`.toLowerCase()
    const retryableChannelFailure =
      firstRun.status === 'failed' &&
      (errorText.includes('channel open failure') || errorText.includes('open failed') || errorText.includes('session open refused'))

    if (!retryableChannelFailure) {
      return firstRun
    }

    await this.resetClient(request.vm.id)
    return this.executeCommandOnce(request, startedAt)
  }

  private async executeCommandOnce({ vm, command, actor, mutating }: CommandExecutionRequest, startedAt: string): Promise<CommandRun> {
    let client: Client
    try {
      client = await this.getClient(vm)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SSH connection failed.'
      return this.failedCommandRun({ vm, command, actor, mutating, startedAt, message })
    }

    return new Promise((resolveCommand) => {
      client.exec(command, (error, stream) => {
        if (error) {
          resolveCommand(this.failedCommandRun({ vm, command, actor, mutating, startedAt, message: error.message }))
          return
        }

        let stdout = ''
        let stderr = ''
        let exitCode = 0
        stream
          .on('close', (code?: number) => {
            exitCode = code ?? exitCode
            const outputSummary = command.includes('__GROVE_SHADOWSOCKS_INSTALLED_DIAGNOSTIC__')
              ? 'Shadowsocks installation diagnostic collected over SSH.'
              : command.includes('__GROVE_SHADOWSOCKS_DIAGNOSTIC__')
                ? 'Shadowsocks diagnostic collected over SSH.'
                : stdout.trim().split('\n')[0] || stderr.trim().split('\n')[0] || 'Command completed.'
            resolveCommand({
              id: `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              vmId: vm.id,
              actor,
              command,
              status: exitCode === 0 ? 'completed' : 'failed',
              startedAt,
              completedAt: nowIso(),
              stdout,
              stderr,
              exitCode,
              summary: command.trim() === 'ls' || command.trim() === 'ls -la' ? 'Root folder listing collected over SSH.' : outputSummary,
              mutating,
            })
          })
          .on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          .stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })
      })
    })
  }

  async openTerminal(vm: VM): Promise<TerminalSession> {
    await this.getClient(vm)
    const timestamp = nowIso()
    return {
      id: `term-${vm.id}-${Date.now()}`,
      vmId: vm.id,
      status: 'open',
      createdAt: timestamp,
      lastActivityAt: timestamp,
    }
  }

  async openTerminalShell(vm: VM, options: TerminalShellOptions): Promise<TerminalShell> {
    const client = await this.getClient(vm)
    const timestamp = nowIso()
    const session: TerminalSession = {
      id: `term-${vm.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      vmId: vm.id,
      status: 'open',
      createdAt: timestamp,
      lastActivityAt: timestamp,
    }

    const stream = await new Promise<ClientChannel>((resolveShell, reject) => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          width: Math.max(options.cols * 8, 640),
          height: Math.max(options.rows * 16, 480),
        },
        (error, channel) => {
          if (error) {
            reject(error)
            return
          }

          resolveShell(channel)
        },
      )
    })

    return { session, stream }
  }

  async listFiles(vm: VM, path: string): Promise<FileNode[]> {
    const sftp = await this.getSftp(vm)

    try {
      return await new Promise((resolveFiles, reject) => {
        sftp.readdir(path, (error, list) => {
          if (error) {
            reject(error)
            return
          }

          resolveFiles(
            list
              .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
              .map((entry) => ({
                id: `remote-${vm.id}-${path}-${entry.filename}`,
                scope: 'remote' as const,
                type: fileTypeFromMode(entry.attrs.mode),
                name: entry.filename,
                path: path === '/' ? `/${entry.filename}` : `${path.replace(/\/$/, '')}/${entry.filename}`,
                size: entry.attrs.size,
                modified: formatModifiedTime(new Date(entry.attrs.mtime * 1000)),
                permissions: entry.longname.split(/\s+/)[0],
                owner: String(entry.attrs.uid),
              })),
          )
        })
      })
    } finally {
      sftp.end()
    }
  }

  async transferFile({ vm, direction, source, target, fileName, conflict }: FileTransferExecutionRequest): Promise<TransferJob> {
    const sftp = await this.getSftp(vm)

    try {
      if (direction === 'download') {
        mkdirSync(dirname(target), { recursive: true })
        await new Promise<void>((resolveTransfer, reject) => {
          const readStream = sftp.createReadStream(source)
          const writeStream = createWriteStream(target)
          readStream.on('error', reject)
          writeStream.on('error', reject)
          writeStream.on('finish', () => resolveTransfer())
          readStream.pipe(writeStream)
        })
      }

      if (direction === 'upload') {
        const sourcePath = expandPath(source)
        if (!existsSync(sourcePath)) {
          throw new Error(`Local source file does not exist: ${source}`)
        }
        await new Promise<void>((resolveTransfer, reject) => {
          sftp.fastPut(sourcePath, target, (error) => {
            if (error) {
              reject(error)
              return
            }
            resolveTransfer()
          })
        })
      }
    } finally {
      sftp.end()
    }

    return {
      id: `job-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      vmId: vm.id,
      direction,
      source,
      target,
      fileName,
      status: 'completed',
      progress: 100,
      speed: 'complete',
      conflict,
    }
  }

  async uploadDirectory({ vm, sourcePath, targetPath }: DirectoryUploadExecutionRequest): Promise<DirectoryUploadResult> {
    const files = collectLocalProjectFiles(sourcePath)
    const sftp = await this.getSftp(vm)

    try {
      await mkdirRemote(sftp, targetPath)
      const directories = Array.from(new Set(files.map((file) => posix.dirname(file.relativePath)).filter((path) => path !== '.')))
      for (const directory of directories) {
        await mkdirRemote(sftp, posix.join(targetPath, directory))
      }

      for (const file of files) {
        await fastPut(sftp, file.localPath, posix.join(targetPath, file.relativePath))
      }
    } finally {
      sftp.end()
    }

    return { fileCount: files.length }
  }

  private async getSftp(vm: VM) {
    const client = await this.getClient(vm)
    return new Promise<SFTPWrapper>((resolveSftp, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(error)
          return
        }
        resolveSftp(sftp)
      })
    })
  }

  private getClient(vm: VM) {
    const existing = this.clients.get(vm.id)
    if (existing) {
      return existing
    }

    const promise = this.createClient(vm)
    this.clients.set(vm.id, promise)
    return promise
  }

  private createClient(vm: VM) {
    const keyPath = vm.connection.keyLabel && vm.connection.keyLabel !== 'ssh-agent' ? expandPath(vm.connection.keyLabel) : undefined
    const config: ConnectConfig = {
      host: vm.connection.host,
      port: vm.connection.port,
      username: vm.connection.user,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      privateKey: keyPath && existsSync(keyPath) ? readFileSync(keyPath) : undefined,
    }

    return new Promise<Client>((resolveClient, reject) => {
      const client = this.clientFactory()
      let ready = false
      let settled = false

      const rejectConnection = (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        this.clients.delete(vm.id)
        reject(error)
      }

      const handleError = (error: Error) => {
        this.clients.delete(vm.id)
        if (!ready) {
          rejectConnection(error)
        }
      }

      const handleCloseBeforeReady = () => {
        this.clients.delete(vm.id)
        if (!ready) {
          rejectConnection(new Error('SSH connection closed before it was ready.'))
        }
      }

      client
        .once('ready', () => {
          ready = true
          settled = true
          resolveClient(client)
        })
        .on('error', handleError)
        .once('end', handleCloseBeforeReady)
        .once('close', handleCloseBeforeReady)

      try {
        client.connect(config)
      } catch (error) {
        rejectConnection(error instanceof Error ? error : new Error('SSH connection failed.'))
      }
    })
  }

  private async resetClient(vmId: string) {
    const existing = this.clients.get(vmId)
    this.clients.delete(vmId)
    if (!existing) {
      return
    }

    try {
      const client = await existing
      client.end()
    } catch {
      // A failed client is already unusable and has been removed from the cache.
    }
  }

  private failedCommandRun({
    vm,
    command,
    actor,
    mutating,
    startedAt,
    message,
  }: CommandExecutionRequest & { startedAt: string; message: string }): CommandRun {
    return {
      id: `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      vmId: vm.id,
      actor,
      command,
      status: 'failed',
      startedAt,
      completedAt: nowIso(),
      stderr: message,
      exitCode: 1,
      summary: message,
      mutating,
    }
  }
}
