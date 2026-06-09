import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultInventoryPath, validateInventoryText } from './inventory'
import { createGroveApp } from './app'
import { defaultAppRunnerPath } from './appRunnerMetadata'
import { collectLocalProjectFiles } from './localProjectFiles'
import { GroveStore } from './store'
import { localEnvPath, saveMoonshotLocalEnv } from './env'
import { resolveProjectStateReference } from './projectState'
import type { CopilotAgentInput } from './copilotAgent'
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

function appWithFakeCopilot(respond: (input: CopilotAgentInput) => Promise<string> | string) {
  return createGroveApp(
    new GroveStore(undefined, {
      async respond(input) {
        return {
          content: await respond(input),
          provider: 'moonshot',
        }
      },
    }),
  )
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

  it('hydrates services and top processes from SSH runtime output', async () => {
    const { app } = createGroveApp(new GroveStore(new RuntimeSampleSsh()))
    const response = await request(app).get('/api/vms/vm-orchid').expect(200)

    expect(response.body.hostname).toBe('real-host')
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

  it('confirms copilot proposals through a separate non-terminal command run', async () => {
    const { app } = createGroveApp()
    const proposal = await request(app)
      .post('/api/copilot/proposals')
      .send({ vmId: 'vm-orchid', activeTab: 'overview', actionType: 'inspect_logs' })
      .expect(201)
    const confirmation = await request(app).post(`/api/copilot/proposals/${proposal.body.id}/confirm`).expect(200)

    expect(confirmation.body.commandRun.actor).toBe('copilot')
    expect(confirmation.body.proposal.status).toBe('executed')
  })

  it('requires Moonshot configuration for free-form copilot chat', async () => {
    const { app } = createGroveApp()
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ vmId: 'vm-orchid', activeTab: 'terminal', message: 'patch all vms' })
      .expect(400)

    expect(response.body.error).toContain('Moonshot API key is not configured')
  })

  it('lets the configured copilot create a high-risk fleet patch proposal from chat', async () => {
    const { app } = appWithFakeCopilot((input) => {
      const result = input.runtime.createKnownProposal('patch_vms')
      return `Kimi prepared a confirmed fleet patch proposal. ${result.summary}`
    })
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ vmId: 'vm-orchid', activeTab: 'terminal', message: 'patch all vms' })
      .expect(201)

    expect(response.body.proposals[0].actionType).toBe('patch_vms')
    expect(response.body.proposals[0].risk).toBe('high')
    expect(response.body.proposals[0].status).toBe('pending_confirmation')
    expect(response.body.proposals[0].command).toContain('apt-get update')
    expect(response.body.messages[1].content).toContain('confirmed fleet patch proposal')
  })

  it('lets the configured copilot run a Shadowsocks status diagnostic', async () => {
    const { app, store } = appWithFakeCopilot(async (input) => {
      const result = await input.runtime.inspectSystem('shadowsocks_running')
      return `Kimi checked runtime status: ${result.summary}`
    })
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ vmId: 'vm-orchid', activeTab: 'overview', message: 'is there a shadowsocks server running' })
      .expect(201)

    expect(response.body.proposals).toHaveLength(0)
    expect(response.body.messages[1].content).toContain('Kimi checked runtime status')
    expect(response.body.messages[1].content).not.toContain('I am running locally with the full context')

    const vm = store.snapshot().vms.find((item) => item.id === 'vm-orchid')
    expect(vm?.activity[0].title).toBe('Copilot SSH inspection')
    expect(vm?.activity[0].detail).toBe('Shadowsocks diagnostic collected over SSH.')
  })

  it('lets the configured copilot run a Shadowsocks installation diagnostic', async () => {
    const { app, store } = appWithFakeCopilot(async (input) => {
      const result = await input.runtime.inspectSystem('shadowsocks_installed')
      return `Kimi checked installation evidence: ${result.summary}`
    })
    const response = await request(app)
      .post('/api/copilot/messages')
      .send({ vmId: 'vm-orchid', activeTab: 'overview', message: 'is shadowsocks server installed on this machine' })
      .expect(201)

    expect(response.body.proposals).toHaveLength(0)
    expect(response.body.messages[1].content).toContain('Kimi checked installation evidence')
    expect(response.body.messages[1].content).not.toContain('server running')

    const vm = store.snapshot().vms.find((item) => item.id === 'vm-orchid')
    expect(vm?.activity[0].detail).toBe('Shadowsocks installation diagnostic collected over SSH.')
  })

  it('publishes copilot progress events while the configured agent works', async () => {
    const { app, store } = appWithFakeCopilot((input) => {
      input.onProgress?.({ title: 'Kimi is choosing tools', detail: 'test step', status: 'running' })
      input.onProgress?.({ title: 'Kimi finished', status: 'completed' })
      return 'Kimi finished the request.'
    })
    const progressTitles: string[] = []
    const unsubscribe = store.onEvent((event) => {
      if (event.type === 'copilot.progress') {
        progressTitles.push(event.payload.title)
      }
    })

    await request(app)
      .post('/api/copilot/messages')
      .send({ vmId: 'vm-orchid', activeTab: 'overview', message: 'check something slowly' })
      .expect(201)
    unsubscribe()

    expect(progressTitles).toContain('Queued copilot request')
    expect(progressTitles).toContain('Kimi is choosing tools')
    expect(progressTitles).toContain('Kimi finished')
    expect(progressTitles).toContain('Copilot response ready')
  })
})
