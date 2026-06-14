import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultInventoryPath, validateInventoryText } from './inventory'
import { createGroveApp } from './app'
import { defaultAppRunnerPath } from './appRunnerMetadata'
import { collectLocalProjectFiles } from './localProjectFiles'
import { GroveStore } from './store'
import { CopilotJournal } from './copilotJournal'
import { localEnvPath, saveMoonshotLocalEnv } from './env'
import { resolveProjectStateReference } from './projectState'
import { MockDriver, type MockScripter } from './drivers/mockDriver'
import { OPENUI_OPERATOR_BRIEF_PROMPT } from '../src/openui/operatorBriefPrompt'
import type { CommandRun, FileNode, TerminalSession, VM } from '../src/types'
import type {
  CommandExecutionRequest,
  DirectoryUploadExecutionRequest,
  DirectoryUploadResult,
  SshSessionManager,
} from './sshSessionManager'

const originalStateDir = process.env.GROVE_STATE_DIR
const originalUseFixtures = process.env.GROVE_USE_FIXTURES
const originalMoonshotApiKey = process.env.GROVE_MOONSHOT_API_KEY
const originalMoonshotBaseUrl = process.env.GROVE_MOONSHOT_BASE_URL
const originalMoonshotModel = process.env.GROVE_MOONSHOT_MODEL

function appWithMockCopilot(scripter?: MockScripter) {
  return createGroveApp(new GroveStore(undefined, { driver: new MockDriver(scripter) }))
}

class RuntimeSampleSsh implements SshSessionManager {
  async executeCommand({ vm, command, actor, mutating }: CommandExecutionRequest): Promise<CommandRun> {
    return {
      id: 'run-runtime-sample',
      vmId: vm.id,
      actor,
      command,
      status: 'completed',
      startedAt: '00:00',
      completedAt: '00:00',
      stdout: [
        'CPU_PCT=37',
        'NET_RX_MBPS=12.5',
        'NET_TX_MBPS=3.4',
        'HOSTNAME=real-host',
        'OS=Ubuntu 24.04 LTS',
        'UPTIME=up 2 days',
        'LOAD=0.10,0.20,0.30',
        'CPUS=2',
        'MEM_TOTAL_MB=2048',
        'MEM_USED_MB=512',
        'DISK_TOTAL_KB=102400',
        'DISK_USED_KB=51200',
        'DISK_PCT=50%',
        '__GROVE_PROCESSES__',
        '123 root 12.5 20480 /usr/bin/node /srv/app.js',
        '456 www-data 2.0 10240 nginx: worker process',
        '__GROVE_SERVICES__',
        'nginx.service\trunning\t80\t1.2\t34816',
        'postgresql.service\tfailed\t5432\t0\t0',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      summary: 'Runtime sampled.',
      mutating,
    }
  }

  async openTerminal(vm: VM): Promise<TerminalSession> {
    return {
      id: 'term-runtime-sample',
      vmId: vm.id,
      status: 'open',
      createdAt: '00:00',
      lastActivityAt: '00:00',
    }
  }

  async listFiles(): Promise<FileNode[]> {
    return []
  }
}

class AppRunnerSsh implements SshSessionManager {
  commands: string[] = []
  uploads: DirectoryUploadExecutionRequest[] = []

  async executeCommand({ vm, command, actor, mutating }: CommandExecutionRequest): Promise<CommandRun> {
    this.commands.push(command)
    const startedAt = '00:00'
    let stdout = 'ok'
    let summary = 'Command completed.'

    if (command.includes('__GROVE_HOME__')) {
      stdout = '__GROVE_HOME__\n/home/deployer\n'
      summary = 'Remote home resolved over SSH.'
    }

    if (command.includes('__GROVE_APPRUNNER_STATUS__')) {
      stdout = [
        '__GROVE_APPRUNNER_STATUS__',
        'state=active',
        'pid=4211',
        'cpu=2.5',
        'rss=98304',
        'listening=1',
      ].join('\n')
      summary = 'AppRunner service status collected over SSH.'
    }

    return {
      id: `run-${this.commands.length}`,
      vmId: vm.id,
      actor,
      command,
      status: 'completed',
      startedAt,
      completedAt: startedAt,
      stdout,
      stderr: '',
      exitCode: 0,
      summary,
      mutating,
    }
  }

  async openTerminal(vm: VM): Promise<TerminalSession> {
    return {
      id: 'term-apprunner',
      vmId: vm.id,
      status: 'open',
      createdAt: '00:00',
      lastActivityAt: '00:00',
    }
  }

  async listFiles(): Promise<FileNode[]> {
    return []
  }

  async uploadDirectory(request: DirectoryUploadExecutionRequest): Promise<DirectoryUploadResult> {
    this.uploads.push(request)
    return { fileCount: collectLocalProjectFiles(request.sourcePath).length }
  }
}

beforeEach(() => {
  delete process.env.GROVE_STATE_DIR
  process.env.GROVE_USE_FIXTURES = 'true'
  delete process.env.GROVE_MOONSHOT_API_KEY
  delete process.env.GROVE_MOONSHOT_BASE_URL
  delete process.env.GROVE_MOONSHOT_MODEL
})

afterAll(() => {
  if (originalStateDir) {
    process.env.GROVE_STATE_DIR = originalStateDir
  } else {
    delete process.env.GROVE_STATE_DIR
  }
  if (originalUseFixtures) {
    process.env.GROVE_USE_FIXTURES = originalUseFixtures
  } else {
    delete process.env.GROVE_USE_FIXTURES
  }
  if (originalMoonshotApiKey) {
    process.env.GROVE_MOONSHOT_API_KEY = originalMoonshotApiKey
  } else {
    delete process.env.GROVE_MOONSHOT_API_KEY
  }
  if (originalMoonshotBaseUrl) {
    process.env.GROVE_MOONSHOT_BASE_URL = originalMoonshotBaseUrl
  } else {
    delete process.env.GROVE_MOONSHOT_BASE_URL
  }
  if (originalMoonshotModel) {
    process.env.GROVE_MOONSHOT_MODEL = originalMoonshotModel
  } else {
    delete process.env.GROVE_MOONSHOT_MODEL
  }
})

describe('Grove backend', () => {
  it('rejects inventory files that include secret material', () => {
    expect(() =>
      validateInventoryText(`
vms:
  - id: vm-secret
    name: bad
    host: 127.0.0.1
    user: root
    port: 22
    password: no
`),
    ).toThrow(/must not contain/i)
  })

  it('lists VMs from the local inventory fallback', async () => {
    const { app } = createGroveApp()
    const response = await request(app).get('/api/vms').expect(200)

    expect(response.body.length).toBeGreaterThan(0)
    expect(response.body[0]).toHaveProperty('connection')
  })

  it('uses project-local storage paths by default', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-state-'))

    try {
      process.env.GROVE_STATE_DIR = tempDir
      const { app } = createGroveApp()
      const defaults = await request(app).get('/api/local/defaults').expect(200)

      expect(defaultInventoryPath()).toBe(join(tempDir, 'inventory.yaml'))
      expect(defaultAppRunnerPath()).toBe(join(tempDir, 'apprunner.yaml'))
      expect(localEnvPath()).toBe(join(tempDir, '.env.local'))
      expect(defaults.body.downloadsPath).toBe(join(tempDir, 'downloads'))
      expect(defaults.body.localFilesPath).toBe(join(tempDir, 'local-files'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('lists a missing local folder as empty without creating it', async () => {
    const { app } = createGroveApp()
    const missing = join(tmpdir(), `grove-does-not-exist-${Date.now()}`)

    const response = await request(app)
      .get(`/api/local/files?path=${encodeURIComponent(missing)}`)
      .expect(200)

    expect(response.body).toEqual([])
    expect(existsSync(missing)).toBe(false)
  })

  it('resolves relative SSH key paths from the project state directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-state-'))

    try {
      process.env.GROVE_STATE_DIR = tempDir
      expect(resolveProjectStateReference('keys/edge.pem')).toBe(join(tempDir, 'keys', 'edge.pem'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('adds, modifies, and removes VMs in the local inventory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-'))
    const inventoryPath = join(tempDir, 'inventory.yaml')

    try {
      process.env.GROVE_USE_FIXTURES = 'false'
      process.env.GROVE_STATE_DIR = tempDir
      writeFileSync(inventoryPath, 'vms: []\n', 'utf8')

      const { app } = createGroveApp()
      const created = await request(app)
        .post('/api/vms')
        .send({
          name: 'edge-lab',
          ipAddress: '192.168.56.10',
          user: 'ubuntu',
          port: 2222,
          pemPath: 'keys/edge.pem',
        })
        .expect(201)

      expect(created.body.name).toBe('edge-lab')
      expect(created.body.connection.host).toBe('192.168.56.10')
      expect(created.body.connection.port).toBe(2222)
      expect(created.body.lifecycle).toBe('running')
      expect(created.body.health).toBe('warning')
      expect(readFileSync(inventoryPath, 'utf8')).toContain('keyPath:')

      const updated = await request(app)
        .patch(`/api/vms/${created.body.id}`)
        .send({
          name: 'edge-updated',
          ipAddress: '192.168.56.11',
          user: 'root',
          port: 2200,
          pemPath: 'keys/edge-updated.pem',
        })
        .expect(200)

      expect(updated.body.name).toBe('edge-updated')
      expect(updated.body.connection.host).toBe('192.168.56.11')
      expect(updated.body.connection.keyLabel).toBe('keys/edge-updated.pem')

      await request(app).delete(`/api/vms/${created.body.id}`).expect(200)

      expect(readFileSync(inventoryPath, 'utf8')).toContain('vms: []')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('returns readable JSON errors for invalid VM connection profiles', async () => {
    const { app } = createGroveApp()
    const response = await request(app)
      .post('/api/vms')
      .send({
        name: 'edge-lab',
        ipAddress: 'edge.internal',
        user: 'ubuntu',
        port: 2222,
        pemPath: 'keys/edge.pem',
      })
      .expect(400)

    expect(response.body).toEqual({ error: 'Enter a valid IP address.' })
  })

  it('hydrates services and top processes from SSH runtime output', async () => {
    const { app } = createGroveApp(new GroveStore(new RuntimeSampleSsh()))
    const response = await request(app).get('/api/vms/vm-orchid').expect(200)

    expect(response.body.hostname).toBe('real-host')
    // Rates come from the two-sample /proc diff, not hardcoded zeros.
    expect(response.body.metrics.cpuPercent).toBe(37)
    expect(response.body.metrics.networkInMbps).toBe(12.5)
    expect(response.body.metrics.networkOutMbps).toBe(3.4)
    // Alerts derive from the live sample: the degraded service surfaces, health follows.
    expect(response.body.alerts).toContain('Service postgresql.service is degraded')
    expect(response.body.health).toBe('warning')
    expect(response.body.services).toEqual([
      expect.objectContaining({
        name: 'nginx.service',
        state: 'running',
        port: 80,
        cpuPercent: 1.2,
        memoryMb: 34,
      }),
      expect.objectContaining({
        name: 'postgresql.service',
        state: 'degraded',
        port: 5432,
      }),
    ])
    expect(response.body.processes[0]).toEqual(
      expect.objectContaining({
        pid: 123,
        user: 'root',
        cpuPercent: 12.5,
        memoryMb: 20,
        command: '/usr/bin/node /srv/app.js',
      }),
    )
  })

  it('derives threshold alerts from a live sample and clears them when healthy', async () => {
    class HighDiskSsh extends RuntimeSampleSsh {
      async executeCommand(request: CommandExecutionRequest): Promise<CommandRun> {
        const run = await super.executeCommand(request)
        return { ...run, stdout: (run.stdout ?? '').replace('DISK_PCT=50%', 'DISK_PCT=93%').replace('DISK_USED_KB=51200', 'DISK_USED_KB=95232') }
      }
    }
    const { app } = createGroveApp(new GroveStore(new HighDiskSsh()))
    const response = await request(app).get('/api/vms/vm-orchid').expect(200)

    expect(response.body.alerts.some((alert: string) => alert.startsWith('Disk usage at 93%'))).toBe(true)
    expect(response.body.health).toBe('warning')
    expect(response.body.alerts).not.toContain('No active alerts')
  })

  it('marks an unreachable VM with an alert on refresh failure', async () => {
    class UnreachableSsh extends RuntimeSampleSsh {
      async executeCommand(request: CommandExecutionRequest): Promise<CommandRun> {
        const run = await super.executeCommand(request)
        return { ...run, status: 'failed', stderr: 'connect ETIMEDOUT', summary: 'SSH connection failed.' }
      }
    }
    const { app } = createGroveApp(new GroveStore(new UnreachableSsh()))
    const response = await request(app).get('/api/vms/vm-orchid').expect(200)

    expect(response.body.alerts).toEqual(['VM is unreachable over SSH'])
    expect(response.body.health).toBe('critical')
  })

  it('runs a confirmed reboot action through the command path', async () => {
    const { app } = createGroveApp()
    const response = await request(app).post('/api/vms/vm-orchid/actions/reboot').expect(200)

    expect(response.body.commandRun.command).toBe('sudo reboot')
    expect(response.body.vm.activity[0].title).toBe('Reboot requested')
  })

  it('creates transfer jobs with conflict metadata', async () => {
    const { app } = createGroveApp()
    const response = await request(app)
      .post('/api/transfers')
      .send({
        vmId: 'vm-orchid',
        direction: 'upload',
        source: '/workspace/grove/.grove/downloads/compose-prod.yml',
        target: '/srv/build/compose-prod.yml',
        fileName: 'compose-prod.yml',
        conflict: 'overwrite',
      })
      .expect(201)

    expect(response.body.status).toBe('in_progress')
    expect(response.body.conflict).toBe('overwrite')
  })

  it('creates, updates, and removes AppRunner services', async () => {
    const ssh = new AppRunnerSsh()
    const { app, store } = createGroveApp(new GroveStore(ssh))
    const created = await request(app)
      .post('/api/vms/vm-orchid/app-services')
      .send({
        name: 'demo-api',
        source: {
          type: 'github',
          repoUrl: 'https://github.com/acme/demo-api.git',
          ref: 'main',
        },
        port: 3009,
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        startCommand: 'npm start',
      })
      .expect(201)

    expect(created.body).toEqual(
      expect.objectContaining({
        name: 'demo-api',
        port: 3009,
        unitName: 'grove-apprunner-demo-api.service',
        state: 'running',
        accessUrl: 'http://10.4.12.21:3009/',
        listening: true,
      }),
    )
    expect(ssh.commands.some((command) => command.includes('git clone --depth 1 --branch'))).toBe(true)
    expect(ssh.commands.some((command) => command.includes('systemctl enable --now'))).toBe(true)
    expect(store.snapshot().vms.find((vm) => vm.id === 'vm-orchid')?.appServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'demo-api' })]),
    )

    const updated = await request(app)
      .patch('/api/vms/vm-orchid/app-services/demo-api')
      .send({
        name: 'demo-api',
        source: {
          type: 'github',
          repoUrl: 'https://github.com/acme/demo-api.git',
          ref: 'release',
        },
        port: 3010,
        startCommand: 'npm run serve',
      })
      .expect(200)

    expect(updated.body.port).toBe(3010)
    expect(updated.body.startCommand).toBe('npm run serve')

    await request(app).delete('/api/vms/vm-orchid/app-services/demo-api').expect(200)
    expect(store.snapshot().vms.find((vm) => vm.id === 'vm-orchid')?.appServices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'demo-api' })]),
    )
    expect(ssh.commands.some((command) => command.includes('systemctl disable'))).toBe(true)
  })

  it('rejects invalid AppRunner services before deployment', async () => {
    const { app } = createGroveApp(new GroveStore(new AppRunnerSsh()))

    const duplicatePort = await request(app)
      .post('/api/vms/vm-orchid/app-services')
      .send({
        name: 'duplicate-port',
        source: { type: 'github', repoUrl: 'https://github.com/acme/demo.git' },
        port: 4173,
        startCommand: 'npm start',
      })
      .expect(400)

    expect(duplicatePort.body.error).toContain('already assigned')

    const credentials = await request(app)
      .post('/api/vms/vm-orchid/app-services')
      .send({
        name: 'bad-repo',
        source: { type: 'github', repoUrl: 'https://token@github.com/acme/demo.git' },
        port: 3011,
        startCommand: 'npm start',
      })
      .expect(400)

    expect(credentials.body.error).toContain('embedded credentials')
  })

  it('filters generated folders and gitignored files from local AppRunner uploads', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-project-'))

    try {
      mkdirSync(join(tempDir, 'src'), { recursive: true })
      mkdirSync(join(tempDir, 'node_modules', 'pkg'), { recursive: true })
      mkdirSync(join(tempDir, 'dist'), { recursive: true })
      mkdirSync(join(tempDir, '.git'), { recursive: true })
      writeFileSync(join(tempDir, '.gitignore'), 'secret.txt\nlogs/\n', 'utf8')
      writeFileSync(join(tempDir, 'src', 'index.ts'), 'console.log("ok")\n', 'utf8')
      writeFileSync(join(tempDir, 'secret.txt'), 'nope\n', 'utf8')
      writeFileSync(join(tempDir, 'node_modules', 'pkg', 'index.js'), 'nope\n', 'utf8')
      writeFileSync(join(tempDir, 'dist', 'bundle.js'), 'nope\n', 'utf8')

      expect(collectLocalProjectFiles(tempDir).map((file) => file.relativePath).sort()).toEqual([
        '.gitignore',
        'src/index.ts',
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('persists AppRunner metadata outside the VM inventory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-'))
    const inventoryPath = join(tempDir, 'inventory.yaml')
    const appRunnerPath = join(tempDir, 'apprunner.yaml')

    try {
      process.env.GROVE_USE_FIXTURES = 'false'
      process.env.GROVE_STATE_DIR = tempDir
      writeFileSync(
        inventoryPath,
        [
          'vms:',
          '  - id: vm-edge',
          '    name: edge',
          '    host: 192.168.56.10',
          '    user: deployer',
          '    port: 22',
          '    useAgent: true',
        ].join('\n'),
        'utf8',
      )

      const { app } = createGroveApp(new GroveStore(new AppRunnerSsh()))
      await request(app)
        .post('/api/vms/vm-edge/app-services')
        .send({
          name: 'edge-api',
          source: { type: 'github', repoUrl: 'https://github.com/acme/edge-api.git' },
          port: 3020,
          startCommand: 'node server.js',
        })
        .expect(201)

      expect(readFileSync(appRunnerPath, 'utf8')).toContain('edge-api')

      const reloaded = new GroveStore(new AppRunnerSsh())
      expect(reloaded.snapshot().vms[0].appServices).toEqual([
        expect.objectContaining({
          name: 'edge-api',
          accessUrl: 'http://192.168.56.10:3020/',
        }),
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('saves Grove Moonshot settings in the project state directory', () => {
    const originalCwd = process.cwd()
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-env-'))

    try {
      process.chdir(tempDir)
      mkdirSync(join(tempDir, '.grove'), { recursive: true })
      writeFileSync(
        join(tempDir, '.grove', '.env.local'),
        [
          'OTHER_VALUE=keep-me',
        ].join('\n'),
        'utf8',
      )

      saveMoonshotLocalEnv({
        apiKey: 'new-key',
        baseUrl: 'https://new.example/v1',
        model: 'new-model',
      })

      const saved = readFileSync(join(tempDir, '.grove', '.env.local'), 'utf8')
      expect(saved).toContain('OTHER_VALUE=keep-me')
      expect(saved).toContain('GROVE_MOONSHOT_API_KEY=new-key')
      expect(saved).toContain('GROVE_MOONSHOT_BASE_URL=https://new.example/v1')
      expect(saved).toContain('GROVE_MOONSHOT_MODEL=new-model')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      delete process.env.GROVE_MOONSHOT_API_KEY
      delete process.env.GROVE_MOONSHOT_BASE_URL
      delete process.env.GROVE_MOONSHOT_MODEL
    }
  })

  it('runs a confirmed suggestion proposal through the command path', async () => {
    const { app } = createGroveApp()
    const proposal = await request(app)
      .post('/api/copilot/proposals')
      .send({ vmId: 'vm-orchid', activeTab: 'overview', actionType: 'inspect_logs' })
      .expect(201)
    const confirmation = await request(app)
      .post(`/api/copilot/proposals/${proposal.body.id}/decision`)
      .send({ decision: 'allow_once' })
      .expect(200)

    expect(confirmation.body.proposal.status).toBe('executed')
  })

  it('streams a scoped assistant message from the kimi driver', async () => {
    const scripter: MockScripter = (promptRequest) => [
      { type: 'update', update: { type: 'message_delta', text: 'Looking at ' } },
      { type: 'update', update: { type: 'message_delta', text: promptRequest.message } },
      { type: 'final', text: `Checked: ${promptRequest.message}` },
    ]
    const { app } = appWithMockCopilot(scripter)
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ scope: 'vm:vm-orchid', message: 'disk usage' })
      .expect(201)

    expect(response.body.messages[0].role).toBe('user')
    expect(response.body.messages[1].role).toBe('assistant')
    expect(response.body.messages[1].content).toBe('Checked: disk usage')
    expect(response.body.messages[1].scope).toBe('vm:vm-orchid')
  })

  it('prepends referenced history to the model prompt only when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-journal-'))
    try {
      const journal = new CopilotJournal(dir, true)
      journal.recordMessage('fleet', {
        id: 'h1',
        role: 'user',
        content: 'earlier question about disk',
        timestamp: '00:00',
        scope: 'fleet',
        createdAt: 1,
      })
      journal.recordToolCall('fleet', {
        id: 't1',
        scope: 'fleet',
        title: 'inspect_vm',
        kind: 'read',
        status: 'completed',
        detail: 'orchid metrics',
        createdAt: 2,
        updatedAt: 2,
      })

      let captured = ''
      const scripter: MockScripter = (promptRequest) => {
        captured = promptRequest.message
        return [{ type: 'final', text: 'ok' }]
      }
      const store = new GroveStore(undefined, { driver: new MockDriver(scripter), journal })
      const { app } = createGroveApp(store)

      const withHistory = await request(app)
        .post('/api/copilot/messages')
        .send({ scope: 'fleet', message: 'follow up please', referenceHistory: true })
        .expect(201)
      expect(captured).toContain('recent operation history')
      expect(captured).toContain('earlier question about disk')
      expect(captured).toContain('follow up please')
      // The stored/displayed user message stays the original text, not the augmented prompt.
      expect(withHistory.body.messages[0].content).toBe('follow up please')

      captured = ''
      await request(app)
        .post('/api/copilot/messages')
        .send({ scope: 'fleet', message: 'plain ask' })
        .expect(201)
      expect(captured).toBe('plain ask')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces agent execution steps, thinking, and plans as timeline state', async () => {
    const scripter: MockScripter = () => [
      { type: 'update', update: { type: 'thought', text: 'Need to look at the VM first.' } },
      {
        type: 'update',
        update: {
          type: 'plan',
          entries: [
            { title: 'Inspect VM', status: 'in_progress' },
            { title: 'Report', status: 'pending' },
          ],
        },
      },
      {
        type: 'update',
        update: { type: 'tool_call', id: 'call-1', title: 'get_vm', kind: 'read', status: 'running', detail: '{}' },
      },
      {
        type: 'update',
        update: {
          type: 'tool_call',
          id: 'call-1',
          title: 'get_vm',
          kind: 'read',
          status: 'completed',
          output: 'lifecycle: running\nhealth: ok',
        },
      },
      {
        type: 'update',
        update: {
          type: 'plan',
          entries: [
            { title: 'Inspect VM', status: 'completed' },
            { title: 'Report', status: 'in_progress' },
          ],
        },
      },
      { type: 'final', text: 'All good.' },
    ]
    const { app, store } = appWithMockCopilot(scripter)
    const planEvents: unknown[] = []
    const unsubscribe = store.onEvent((event) => {
      if (event.type === 'copilot.plan') {
        planEvents.push(event.payload)
      }
    })

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'health?' }).expect(201)
    unsubscribe()

    const snapshot = store.snapshot()
    const thought = snapshot.toolCalls.find((item) => item.kind === 'think')
    expect(thought?.status).toBe('completed')
    expect(thought?.output).toContain('Need to look at the VM first.')

    const agentStep = snapshot.toolCalls.find((item) => item.title === 'get_vm')
    expect(agentStep?.origin).toBe('agent')
    expect(agentStep?.status).toBe('completed')
    expect(agentStep?.output).toBe('lifecycle: running\nhealth: ok')

    expect(planEvents.length).toBe(2)
    expect(snapshot.plans).toHaveLength(1)
    expect(snapshot.plans[0].entries.map((entry) => entry.status)).toEqual(['completed', 'in_progress'])
  })

  it('drops the agent-side view of tools Grove instruments itself', async () => {
    const scripter: MockScripter = () => [
      {
        type: 'update',
        update: {
          type: 'tool_call',
          id: 'call-1',
          title: 'mcp__grove__run_command',
          kind: 'execute',
          status: 'running',
          detail: 'uptime',
        },
      },
      { type: 'final', text: 'done' },
    ]
    const { app, store } = appWithMockCopilot(scripter)

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'uptime?' }).expect(201)

    expect(store.snapshot().toolCalls.find((item) => item.id.startsWith('agent-'))).toBeUndefined()
  })

  it('anchors the assistant answer after the steps that produced it', async () => {
    const scripter: MockScripter = () => [
      {
        type: 'update',
        update: { type: 'tool_call', id: 'call-1', title: 'get_vm', kind: 'read', status: 'completed', output: 'ok' },
      },
      { type: 'update', update: { type: 'message_delta', text: 'Answer text.' } },
      { type: 'final', text: 'Answer text.' },
    ]
    const { app, store } = appWithMockCopilot(scripter)

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'check' }).expect(201)

    const snapshot = store.snapshot()
    const step = snapshot.toolCalls.find((item) => item.title === 'get_vm')
    const answer = snapshot.messages.find((item) => item.content === 'Answer text.')
    expect(step).toBeDefined()
    expect(answer?.createdAt).toBeGreaterThanOrEqual(step!.createdAt)
  })

  it('keeps agent tool calls distinct across turns even when the driver reuses ids', async () => {
    // The print driver spawns a fresh kimi per turn, so its tool-call ids restart; the same
    // 'call-1' must not collapse turn 2's step onto turn 1's card.
    const scripter: MockScripter = () => [
      { type: 'update', update: { type: 'tool_call', id: 'call-1', title: 'cat_file', kind: 'read', status: 'completed', output: 'data' } },
      { type: 'update', update: { type: 'message_delta', text: 'Done.' } },
      { type: 'final', text: 'Done.' },
    ]
    const { app, store } = appWithMockCopilot(scripter)

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'first' }).expect(201)
    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'second' }).expect(201)

    const agentSteps = store.snapshot().toolCalls.filter((item) => item.title === 'cat_file')
    expect(agentSteps).toHaveLength(2)
    expect(new Set(agentSteps.map((item) => item.id)).size).toBe(2)
  })

  it('assigns strictly increasing timeline stamps within a turn', async () => {
    const scripter: MockScripter = () => [
      { type: 'update', update: { type: 'tool_call', id: 'call-1', title: 'cat_file', kind: 'read', status: 'completed', output: 'a' } },
      { type: 'update', update: { type: 'tool_call', id: 'call-2', title: 'cat_file', kind: 'read', status: 'completed', output: 'b' } },
      { type: 'update', update: { type: 'message_delta', text: 'Answer.' } },
      { type: 'final', text: 'Answer.' },
    ]
    const { app, store } = appWithMockCopilot(scripter)

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'go' }).expect(201)

    const snapshot = store.snapshot()
    const user = snapshot.messages.find((item) => item.content === 'go')
    const steps = snapshot.toolCalls.filter((item) => item.title === 'cat_file')
    const answer = snapshot.messages.find((item) => item.content === 'Answer.')
    const stamps = [user!.createdAt!, ...steps.map((item) => item.createdAt), answer!.createdAt!]
    // Every stamp is unique and strictly increasing in creation order.
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  })

  it('answers a fleet-scoped chat request', async () => {
    const { app } = appWithMockCopilot()
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ scope: 'fleet', message: 'which VMs need attention' })
      .expect(201)

    expect(response.body.messages[1].scope).toBe('fleet')
    expect(response.body.messages[1].content).toContain('which VMs need attention')
  })

  it('extracts OpenUI operator briefs from final assistant messages', async () => {
    const scripter: MockScripter = () => [
      {
        type: 'final',
        text: [
          'Fleet needs one follow-up.',
          '',
          '```openui',
          'root = OperatorBrief("Fleet attention", "fleet", "warning", "One VM needs attention")',
          '```',
        ].join('\n'),
      },
    ]
    const { app } = appWithMockCopilot(scripter)
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ scope: 'fleet', message: 'fleet status' })
      .expect(201)

    expect(response.body.messages[1].content).toBe('Fleet needs one follow-up.')
    expect(response.body.messages[1].openUi).toEqual({
      type: 'openui',
      content: 'root = OperatorBrief("Fleet attention", "fleet", "warning", "One VM needs attention")',
    })
  })

  it('adds OpenUI operator brief guidance to generated scope workspaces', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'grove-openui-workspace-'))

    try {
      process.env.GROVE_STATE_DIR = tempDir
      const store = new GroveStore(undefined, { driver: new MockDriver() })

      await store.sendCopilotMessage({ scope: 'fleet', message: 'fleet status' })
      await store.sendCopilotMessage({ scope: 'vm:vm-orchid', message: 'diagnose services' })

      expect(readFileSync(join(store.copilotWorkspaceDir('fleet'), 'AGENTS.md'), 'utf8')).toContain(
        OPENUI_OPERATOR_BRIEF_PROMPT,
      )
      expect(readFileSync(join(store.copilotWorkspaceDir('vm:vm-orchid'), 'AGENTS.md'), 'utf8')).toContain(
        OPENUI_OPERATOR_BRIEF_PROMPT,
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      delete process.env.GROVE_STATE_DIR
    }
  })

  it('runs a read-only copilot command immediately and records activity', async () => {
    const { store } = appWithMockCopilot()
    const result = await store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'uptime',
      reason: 'health check',
    })

    expect(result.ok).toBe(true)
    const vm = store.snapshot().vms.find((item) => item.id === 'vm-orchid')
    expect(vm?.activity[0].title).toBe('Copilot inspection')
    const toolCall = store.snapshot().toolCalls.at(-1)
    expect(toolCall?.status).toBe('completed')
    // The step carries the full SSH console dump for the on-demand "console log" view.
    expect(toolCall?.consoleLog).toContain('$ uptime')
    expect(toolCall?.consoleLog).toContain('[exit 0]')
  })

  it('gates a mutating copilot command behind an awaiting-confirmation proposal', async () => {
    const { store } = appWithMockCopilot()
    const pending = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo systemctl restart nginx',
      reason: 'restart web',
    })

    const proposal = store.snapshot().proposals.find((item) => item.status === 'awaiting_confirmation')
    expect(proposal).toBeDefined()
    expect(proposal?.command).toBe('sudo systemctl restart nginx')

    await store.decideProposal(proposal!.id, 'allow_once')
    const result = await pending
    expect(result.ok).toBe(true)
    expect(store.snapshot().proposals.find((item) => item.id === proposal!.id)?.status).toBe('executed')
  })

  it('refuses a mutating copilot command when the user denies it', async () => {
    const { store } = appWithMockCopilot()
    const pending = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo rm -rf /tmp/cache',
      reason: 'cleanup',
    })

    const proposal = store.snapshot().proposals.find((item) => item.status === 'awaiting_confirmation')
    expect(proposal).toBeDefined()

    await store.decideProposal(proposal!.id, 'deny')
    const result = await pending
    expect(result.ok).toBe(false)
    expect(store.snapshot().proposals.find((item) => item.id === proposal!.id)?.status).toBe('dismissed')
  })

  it('surfaces parallel gated commands one confirmation at a time, in arrival order', async () => {
    const { store } = appWithMockCopilot()
    const first = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo systemctl restart nginx',
      reason: 'restart web',
    })
    const second = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo rm -rf /tmp/cache',
      reason: 'cleanup',
    })

    let awaiting = store.snapshot().proposals.filter((item) => item.status === 'awaiting_confirmation')
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].command).toBe('sudo systemctl restart nginx')

    await store.decideProposal(awaiting[0].id, 'allow_once')
    const firstResult = await first

    awaiting = store.snapshot().proposals.filter((item) => item.status === 'awaiting_confirmation')
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].command).toBe('sudo rm -rf /tmp/cache')

    await store.decideProposal(awaiting[0].id, 'deny')
    const secondResult = await second
    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(false)
  })

  it('skips the queued confirmation when always-allow already covers the same command', async () => {
    const { store } = appWithMockCopilot()
    const first = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo systemctl restart nginx',
      reason: 'restart web',
    })
    const second = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo systemctl restart nginx',
      reason: 'restart web again',
    })

    const awaiting = store.snapshot().proposals.filter((item) => item.status === 'awaiting_confirmation')
    expect(awaiting).toHaveLength(1)

    await store.decideProposal(awaiting[0].id, 'always_allow')
    const results = await Promise.all([first, second])
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(true)
    // The second command never surfaced its own card.
    const restartProposals = store
      .snapshot()
      .proposals.filter((item) => item.command === 'sudo systemctl restart nginx')
    expect(restartProposals).toHaveLength(1)
  })

  it('fans fleet commands out in parallel with bounded concurrency and stable result order', async () => {
    class GatedFleetSsh implements SshSessionManager {
      inFlight = 0
      maxInFlight = 0

      async executeCommand({ vm, command, actor, mutating }: CommandExecutionRequest): Promise<CommandRun> {
        this.inFlight += 1
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        this.inFlight -= 1
        return {
          id: `run-${vm.id}`,
          vmId: vm.id,
          actor,
          command,
          status: 'completed',
          startedAt: '00:00',
          completedAt: '00:00',
          stdout: `ok ${vm.name}`,
          stderr: '',
          exitCode: 0,
          summary: `ok ${vm.name}`,
          mutating,
        }
      }

      async openTerminal(vm: VM): Promise<TerminalSession> {
        return { id: `term-${vm.id}`, vmId: vm.id, status: 'open', createdAt: '00:00', lastActivityAt: '00:00' }
      }

      async listFiles(): Promise<FileNode[]> {
        return []
      }
    }

    process.env.GROVE_FLEET_CONCURRENCY = '2'
    try {
      const ssh = new GatedFleetSsh()
      const store = new GroveStore(ssh, { driver: new MockDriver() })
      const vms = store.snapshot().vms
      expect(vms.length).toBeGreaterThan(2)

      const pending = store.fleetRunCommand({
        scope: 'fleet',
        command: 'sudo apt-get -y upgrade',
        reason: 'patch everything',
        targetVmIds: vms.map((vm) => vm.id),
      })
      const proposal = store.snapshot().proposals.find((item) => item.status === 'awaiting_confirmation')
      expect(proposal).toBeDefined()
      await store.decideProposal(proposal!.id, 'allow_once')

      const result = await pending
      expect(result.ok).toBe(true)
      expect(ssh.maxInFlight).toBe(2)
      const lines = result.data as string[]
      expect(lines).toHaveLength(vms.length)
      vms.forEach((vm, index) => {
        expect(lines[index]).toContain(vm.name)
      })
    } finally {
      delete process.env.GROVE_FLEET_CONCURRENCY
    }
  })

  it('releases an awaiting confirmation when the scope turn is cancelled', async () => {
    const { store } = appWithMockCopilot()
    const pending = store.runScopedCommand({
      scope: 'vm:vm-orchid',
      vmId: 'vm-orchid',
      command: 'sudo systemctl restart nginx',
      reason: 'restart web',
    })

    const proposal = store.snapshot().proposals.find((item) => item.status === 'awaiting_confirmation')
    expect(proposal).toBeDefined()

    store.cancelCopilot('vm:vm-orchid')
    const result = await pending
    expect(result.ok).toBe(false)
    const after = store.snapshot().proposals.find((item) => item.id === proposal!.id)
    expect(after?.status).toBe('dismissed')
    expect(after?.result).toBe('Cancelled.')
  })

  it('publishes queued and ready progress events during a turn', async () => {
    const { app, store } = appWithMockCopilot()
    const progressTitles: string[] = []
    const unsubscribe = store.onEvent((event) => {
      if (event.type === 'copilot.progress') {
        progressTitles.push(event.payload.title)
      }
    })

    await request(app).post('/api/copilot/messages').send({ scope: 'vm:vm-orchid', message: 'check' }).expect(201)
    unsubscribe()

    expect(progressTitles).toContain('Queued copilot request')
    expect(progressTitles).toContain('Copilot response ready')
  })

  it('cancels an in-flight copilot run for a scope', async () => {
    const { app } = appWithMockCopilot()
    const response = await request(app).post('/api/copilot/cancel').send({ scope: 'fleet' }).expect(200)
    expect(response.body.scope).toBe('fleet')
  })

  it('exposes scoped MCP tools through the scope token', async () => {
    const store = new GroveStore(undefined, { driver: new MockDriver() })
    const { app } = createGroveApp(store)
    const token = store.scopeTokens.tokenForScope('vm:vm-orchid')

    const tools = await request(app).get('/api/mcp/tools').set('x-grove-scope', token).expect(200)
    const names = tools.body.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('run_command')
    expect(names).toContain('inspect_vm')
    expect(names).toContain('diagnose_service')
    expect(names).not.toContain('fleet_run_command')

    const call = await request(app)
      .post('/api/mcp/call')
      .set('x-grove-scope', token)
      .send({ name: 'get_vm', arguments: {} })
      .expect(200)
    expect(call.body.result.ok).toBe(true)

    await request(app).get('/api/mcp/tools').expect(401)
  })

  it('limits fleet-only MCP tools to the fleet scope', async () => {
    const store = new GroveStore(undefined, { driver: new MockDriver() })
    const { app } = createGroveApp(store)
    const token = store.scopeTokens.tokenForScope('fleet')

    const tools = await request(app).get('/api/mcp/tools').set('x-grove-scope', token).expect(200)
    const names = tools.body.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('fleet_run_command')
    expect(names).toContain('list_vms')
    expect(names).toContain('inspect_vm')
    expect(names).not.toContain('run_command')
    expect(names).not.toContain('diagnose_service')

    const inspectTool = tools.body.tools.find((tool: { name: string }) => tool.name === 'inspect_vm')
    expect(inspectTool.inputSchema.required).toContain('vmId')
  })

  it('inspects a VM with one composite SSH round-trip', async () => {
    const { store } = appWithMockCopilot()
    const result = await store.inspectVm({ scope: 'vm:vm-orchid', vmId: 'vm-orchid' })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('orchid-build-01')
    const data = result.data as { services: unknown[]; processes: unknown[]; metrics: { memoryPercent: number } }
    expect(data.services.length).toBeGreaterThan(0)
    expect(data.processes.length).toBeGreaterThan(0)
    expect(data.metrics.memoryPercent).toBeGreaterThan(0)
    const toolCall = store.snapshot().toolCalls.at(-1)
    expect(toolCall?.title).toBe('inspect_vm')
    expect(toolCall?.status).toBe('completed')

    const missing = await store.inspectVm({ scope: 'vm:vm-orchid', vmId: 'vm-nope' })
    expect(missing.ok).toBe(false)
  })

  it('diagnoses a service with one composite SSH round-trip', async () => {
    const { store } = appWithMockCopilot()
    const result = await store.diagnoseService({ scope: 'vm:vm-orchid', vmId: 'vm-orchid', unit: 'docker', lines: 50 })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('docker')
    const data = result.data as { status: string; logs: string; ports: string }
    expect(data.status).toContain('docker')
    expect(data.logs).toContain('started')
    const toolCall = store.snapshot().toolCalls.at(-1)
    expect(toolCall?.title).toBe('diagnose_service')
    expect(toolCall?.status).toBe('completed')
  })

  it('requires the UI token for mutating routes when configured', async () => {
    const store = new GroveStore(undefined, { driver: new MockDriver() })
    const { app } = createGroveApp(store, { uiToken: 'boot-secret' })

    await request(app).post('/api/copilot/messages').send({ scope: 'fleet', message: 'hi' }).expect(401)
    await request(app)
      .post('/api/copilot/messages')
      .set('x-grove-token', 'boot-secret')
      .send({ scope: 'fleet', message: 'hi' })
      .expect(201)
    await request(app).get('/api/snapshot').expect(200)
  })
})
