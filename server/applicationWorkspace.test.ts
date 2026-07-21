import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { vms as fixtureVms } from '../src/data/fixtures'
import type { AppRunnerService, GroveApplicationInput, VmConfig } from '../src/types'
import { ApplicationManager, runProcess } from './applicationManager'
import { ApplicationWorkspace } from './applicationWorkspace'
import { loadInventory } from './inventory'
import { MockSshSessionManager, type DirectoryUploadExecutionRequest } from './sshSessionManager'
import { ensureV2StateMigration } from './stateMigration'

const temporaryDirectories: string[] = []

function temporaryDirectory(name: string) {
  const path = mkdtempSync(join(tmpdir(), `${name}-`))
  temporaryDirectories.push(path)
  return path
}

function applicationInput(sourcePath: string): GroveApplicationInput {
  return {
    name: 'Example API',
    source: { type: 'local', path: sourcePath },
    configuration: {
      artifactPath: 'dist',
      startCommand: 'node index.js',
      port: 8080,
      healthCheckPath: '/healthz',
      healthCheckTimeoutSeconds: 20,
      environment: { NODE_ENV: 'production' },
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ApplicationWorkspace', () => {
  it('persists managed application metadata inside the selected workspace', () => {
    const root = temporaryDirectory('grove-workspace')
    const state = join(root, 'state')
    const workspacePath = join(root, 'workspace')
    const sourcePath = join(root, 'selected-source')
    mkdirSync(join(sourcePath, 'dist'), { recursive: true })
    writeFileSync(join(sourcePath, 'dist', 'index.js'), 'console.log("ok")\n')

    const repository = new ApplicationWorkspace({
      settingsPath: join(state, 'settings.yaml'),
      workspacePath,
    })
    const application = repository.createApplication(applicationInput(sourcePath))

    expect(application.slug).toBe('example-api')
    expect(application.managedSourcePath).toBe(join(workspacePath, 'example-api', 'source'))
    expect(existsSync(join(workspacePath, 'example-api', '.grove', 'application.yaml'))).toBe(true)

    const reloaded = new ApplicationWorkspace({ settingsPath: join(state, 'settings.yaml') })
    expect(reloaded.listApplications()).toHaveLength(1)
    expect(reloaded.listApplications()[0]?.id).toBe(application.id)
  })

  it('relocates the workspace atomically and keeps application metadata readable', () => {
    const root = temporaryDirectory('grove-relocate')
    const statePath = join(root, 'settings.yaml')
    const repository = new ApplicationWorkspace({ settingsPath: statePath, workspacePath: join(root, 'old') })
    const sourcePath = join(root, 'source')
    mkdirSync(sourcePath, { recursive: true })
    writeFileSync(join(sourcePath, 'index.js'), 'ok')
    repository.createApplication({
      ...applicationInput(sourcePath),
      configuration: { ...applicationInput(sourcePath).configuration, artifactPath: '.' },
    })

    const nextPath = join(root, 'new')
    const settings = repository.relocateWorkspace(nextPath)

    expect(settings.workspacePath).toBe(nextPath)
    expect(settings.workspaceStatus).toBe('healthy')
    expect(repository.listApplications()).toHaveLength(1)
    expect(existsSync(join(nextPath, 'example-api', '.grove', 'application.yaml'))).toBe(true)
  })
})

describe('ApplicationManager', () => {
  it('clones a Git source and records the exact commit in its immutable version', async () => {
    const root = temporaryDirectory('grove-git-source')
    const repositoryPath = join(root, 'repository')
    mkdirSync(join(repositoryPath, 'dist'), { recursive: true })
    writeFileSync(join(repositoryPath, 'dist', 'index.js'), 'console.log("git source")\n')
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repositoryPath })
    execFileSync('git', ['config', 'user.email', 'grove@example.test'], { cwd: repositoryPath })
    execFileSync('git', ['config', 'user.name', 'Grove Test'], { cwd: repositoryPath })
    execFileSync('git', ['add', '.'], { cwd: repositoryPath })
    execFileSync('git', ['commit', '-m', 'Initial source'], { cwd: repositoryPath })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath, encoding: 'utf8' }).trim()
    const workspace = new ApplicationWorkspace({
      settingsPath: join(root, 'state', 'settings.yaml'),
      workspacePath: join(root, 'workspace'),
    })
    const manager = new ApplicationManager(workspace, new MockSshSessionManager(), () => undefined)
    const application = await manager.createApplication({
      ...applicationInput(repositoryPath),
      source: { type: 'git', repoUrl: repositoryPath, ref: 'main' },
    })

    const version = await manager.buildApplication(application.id)

    expect(version.status).toBe('succeeded')
    expect(version.sourceRevision).toBe(commit)
    expect(existsSync(join(application.managedSourcePath, '.git'))).toBe(true)
    expect(existsSync(join(workspace.versionDirectory(application, version.id), 'artifact', '.git'))).toBe(false)
  })

  it('copies local source, creates an immutable version, and deploys it to an existing VM', async () => {
    const root = temporaryDirectory('grove-application-manager')
    const sourcePath = join(root, 'selected-source')
    mkdirSync(join(sourcePath, 'dist'), { recursive: true })
    writeFileSync(join(sourcePath, 'dist', 'index.js'), 'console.log("healthy")\n')
    writeFileSync(join(sourcePath, 'README.md'), 'source')
    writeFileSync(join(sourcePath, '.env'), 'SECRET=do-not-copy')
    writeFileSync(join(sourcePath, 'deploy.pem'), 'do-not-copy')
    mkdirSync(join(sourcePath, 'node_modules', 'ignored'), { recursive: true })
    writeFileSync(join(sourcePath, 'node_modules', 'ignored', 'package.js'), 'ignored')

    const repository = new ApplicationWorkspace({
      settingsPath: join(root, 'state', 'settings.yaml'),
      workspacePath: join(root, 'workspace'),
    })
    const vm = fixtureVms[0]!
    const manager = new ApplicationManager(repository, new MockSshSessionManager(), (vmId) =>
      vmId === vm.id ? vm : undefined,
    )

    const application = await manager.createApplication(applicationInput(sourcePath))
    expect(existsSync(join(application.managedSourcePath, 'README.md'))).toBe(true)
    expect(existsSync(join(application.managedSourcePath, 'node_modules'))).toBe(false)
    expect(existsSync(join(application.managedSourcePath, '.env'))).toBe(false)
    expect(existsSync(join(application.managedSourcePath, 'deploy.pem'))).toBe(false)

    const version = await manager.buildApplication(application.id)
    expect(version.status).toBe('succeeded')
    expect(version.artifactDigest).toMatch(/^sha256:/)
    expect(version.artifactSizeBytes).toBeGreaterThan(0)

    const result = await manager.deployApplication(application.id, version.id, [vm.id])
    expect(result.deployment.status).toBe('succeeded')
    expect(result.application.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vmId: vm.id, versionId: version.id, status: 'healthy' }),
      ]),
    )
    expect(result.application.instances[0]?.remotePath).toBe('~/grove/example-api')
  })

  it('records a failed build without replacing a prior successful version', async () => {
    const root = temporaryDirectory('grove-build-failure')
    const sourcePath = join(root, 'source')
    mkdirSync(join(sourcePath, 'dist'), { recursive: true })
    writeFileSync(join(sourcePath, 'dist', 'index.js'), 'ok')
    const repository = new ApplicationWorkspace({
      settingsPath: join(root, 'state', 'settings.yaml'),
      workspacePath: join(root, 'workspace'),
    })
    const vm = fixtureVms[0]!
    const manager = new ApplicationManager(repository, new MockSshSessionManager(), () => vm)
    const application = await manager.createApplication(applicationInput(sourcePath))
    const successful = await manager.buildApplication(application.id)
    const updated = manager.updateConfiguration(application.id, {
      ...applicationInput(sourcePath),
      configuration: { ...applicationInput(sourcePath).configuration, artifactPath: 'missing' },
    })

    const failed = await manager.buildApplication(updated.id)
    const stored = manager.getApplication(updated.id)!
    expect(failed.status).toBe('failed')
    expect(stored.versions.find((version) => version.id === successful.id)?.status).toBe('succeeded')
    expect(stored.versions.find((version) => version.id === failed.id)?.failure).toMatch(/not found/i)
  })

  it('keeps a configuration PATCH made while a deploy is in flight', async () => {
    const root = temporaryDirectory('grove-concurrent-deploy')
    const sourcePath = join(root, 'selected-source')
    mkdirSync(join(sourcePath, 'dist'), { recursive: true })
    writeFileSync(join(sourcePath, 'dist', 'index.js'), 'console.log("ok")\n')
    const repository = new ApplicationWorkspace({
      settingsPath: join(root, 'state', 'settings.yaml'),
      workspacePath: join(root, 'workspace'),
    })
    const vm = fixtureVms[0]!

    // Gate the artifact upload so the test can PATCH the configuration mid-deploy.
    let releaseUpload!: () => void
    let uploadStarted!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    const uploadEntered = new Promise<void>((resolve) => { uploadStarted = resolve })
    class GatedSsh extends MockSshSessionManager {
      override async uploadDirectory(request: DirectoryUploadExecutionRequest) {
        uploadStarted()
        await uploadGate
        return super.uploadDirectory(request)
      }
    }
    const manager = new ApplicationManager(repository, new GatedSsh(), (vmId) => (vmId === vm.id ? vm : undefined))
    const application = await manager.createApplication(applicationInput(sourcePath))
    const version = await manager.buildApplication(application.id)
    expect(version.status).toBe('succeeded')

    const deploy = manager.deployApplication(application.id, version.id, [vm.id])
    await uploadEntered

    manager.updateConfiguration(application.id, {
      ...applicationInput(sourcePath),
      configuration: { ...applicationInput(sourcePath).configuration, startCommand: 'node patched.js' },
    })
    expect(manager.getApplication(application.id)?.configuration.startCommand).toBe('node patched.js')

    releaseUpload()
    const result = await deploy
    expect(result.deployment.status).toBe('succeeded')
    // Regression: the deploy's pre-await whole-record snapshot used to overwrite the PATCH.
    expect(manager.getApplication(application.id)?.configuration.startCommand).toBe('node patched.js')
  })

  it('runProcess closes stdin so stdin-reading children get EOF instead of blocking', async () => {
    // Without the fix this child waits on the open pipe forever and the test times out.
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdin.on("end", () => process.exit(0)); process.stdin.resume()',
    ], { cwd: process.cwd() })
    expect(result.exitCode).toBe(0)
  })

  it('imports legacy AppRunner services at most once, even after a rename and a restart', () => {
    const root = temporaryDirectory('grove-legacy-import')
    const settingsPath = join(root, 'state', 'settings.yaml')
    const repository = new ApplicationWorkspace({ settingsPath, workspacePath: join(root, 'workspace') })
    const manager = new ApplicationManager(repository, new MockSshSessionManager(), () => undefined)
    const service: AppRunnerService = {
      id: 'svc-1',
      vmId: 'vm-1',
      name: 'blog',
      source: { type: 'github', repoUrl: 'https://github.com/acme/blog' },
      port: 3000,
      remotePath: '~/services/blog',
      unitName: 'grove-apprunner-blog.service',
      accessUrl: 'http://192.0.2.10:3000/',
      state: 'running',
      cpuPercent: 0,
      memoryMb: 0,
      listening: true,
      startCommand: 'node server.js',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastDeployStatus: 'completed',
      lastDeploySummary: 'ok',
    }

    const first = manager.migrateLegacyAppRunnerServices([service])
    expect(first).toHaveLength(1)

    // Rename the imported application, then simulate the next boot with a fresh
    // workspace + manager over the same settings file.
    const current = manager.getApplication(first[0]!.id)!
    manager.updateConfiguration(current.id, {
      name: 'blog-renamed',
      source: current.source,
      configuration: current.configuration,
    })

    const rebooted = new ApplicationWorkspace({ settingsPath })
    const rebootedManager = new ApplicationManager(rebooted, new MockSshSessionManager(), () => undefined)
    expect(rebootedManager.migrateLegacyAppRunnerServices([service])).toEqual([])
    expect(rebootedManager.listApplications()).toHaveLength(1)
    expect(rebootedManager.listApplications()[0]?.name).toBe('blog-renamed')
  })
})

describe('v2 state migration', () => {
  it('backs up and records every legacy VM id without rewriting inventory.yaml', () => {
    const stateDirectory = temporaryDirectory('grove-v2-migration')
    const inventoryText = 'vms:\n  - id: vm-one\n    name: one\n'
    writeFileSync(join(stateDirectory, 'inventory.yaml'), inventoryText)
    const configs: VmConfig[] = [
      { id: 'vm-one', name: 'one', host: '192.0.2.1', user: 'root', port: 22, useAgent: true },
      { id: 'vm-two', name: 'two', host: '192.0.2.2', user: 'ubuntu', port: 22, useAgent: true },
    ]

    const migration = ensureV2StateMigration(configs, { stateDirectory })!

    expect(migration.legacyVmIds).toEqual(['vm-one', 'vm-two'])
    expect(readFileSync(join(stateDirectory, 'inventory.yaml'), 'utf8')).toBe(inventoryText)
    expect(readFileSync(join(migration.backupDirectory, 'inventory.yaml'), 'utf8')).toBe(inventoryText)
    expect(ensureV2StateMigration(configs, { stateDirectory })).toEqual(migration)
  })

  it('quarantines a corrupt migration marker and rebuilds the snapshot', () => {
    const stateDirectory = temporaryDirectory('grove-v2-corrupt-marker')
    mkdirSync(join(stateDirectory, 'migrations'), { recursive: true })
    writeFileSync(join(stateDirectory, 'migrations', 'v2.json'), '{"schemaVersion": 2, "trunca')

    const migration = ensureV2StateMigration([], { stateDirectory })!

    expect(migration.schemaVersion).toBe(2)
    expect(readdirSync(join(stateDirectory, 'migrations')).some((name) => name.startsWith('v2.json.corrupt-'))).toBe(true)
    // The rebuilt marker is valid, so the next boot reads it back normally.
    expect(ensureV2StateMigration([], { stateDirectory })).toEqual(migration)
  })

  it('backs up .env.local with owner-only permissions', () => {
    const stateDirectory = temporaryDirectory('grove-v2-env-backup')
    writeFileSync(join(stateDirectory, '.env.local'), 'GROVE_COPILOT_API_KEY=sk-secret\n')

    const migration = ensureV2StateMigration([], { stateDirectory })!

    expect(migration.backedUpFiles).toContain('.env.local')
    const backupPath = join(migration.backupDirectory, '.env.local')
    expect(readFileSync(backupPath, 'utf8')).toContain('sk-secret')
    if (process.platform !== 'win32') {
      expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    }
  })
})

describe('corrupt state recovery', () => {
  it('quarantines a truncated application.yaml and boots with the remaining applications', () => {
    const root = temporaryDirectory('grove-corrupt-app')
    const state = join(root, 'state')
    const workspacePath = join(root, 'workspace')
    const sourcePath = join(root, 'source')
    mkdirSync(sourcePath, { recursive: true })
    writeFileSync(join(sourcePath, 'index.js'), 'ok')
    const repository = new ApplicationWorkspace({ settingsPath: join(state, 'settings.yaml'), workspacePath })
    const application = repository.createApplication(applicationInput(sourcePath))

    // Simulate a crash mid-write: a truncated application.yaml in a second app directory.
    const corruptDirectory = join(workspacePath, 'broken-app', '.grove')
    const corruptMetadata = join(corruptDirectory, 'application.yaml')
    mkdirSync(corruptDirectory, { recursive: true })
    writeFileSync(corruptMetadata, 'schemaVersion: 2\napplication:\n  id: "app-trunca\n  slug: broken-app\n')

    const reloaded = new ApplicationWorkspace({ settingsPath: join(state, 'settings.yaml') })
    expect(reloaded.listApplications().map((item) => item.id)).toEqual([application.id])
    expect(existsSync(corruptMetadata)).toBe(false)
    expect(readdirSync(corruptDirectory).some((name) => name.startsWith('application.yaml.corrupt-'))).toBe(true)
  })

  it('quarantines a truncated settings.yaml and boots with defaults', () => {
    const root = temporaryDirectory('grove-corrupt-settings')
    const stateDirectory = join(root, 'state')
    const settingsPath = join(stateDirectory, 'settings.yaml')
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(settingsPath, 'schemaVersion: 2\nworkspacePath: "unterminated\n')

    const workspace = new ApplicationWorkspace({ settingsPath, workspacePath: join(root, 'workspace') })

    expect(workspace.settings().workspacePath).toBe(join(root, 'workspace'))
    expect(existsSync(settingsPath)).toBe(true) // a fresh settings.yaml was written
    expect(readdirSync(stateDirectory).some((name) => name.startsWith('settings.yaml.corrupt-'))).toBe(true)
  })

  it('quarantines a truncated inventory.yaml and falls back to the default inventory', () => {
    const root = temporaryDirectory('grove-corrupt-inventory')
    const inventoryPath = join(root, 'inventory.yaml')
    writeFileSync(inventoryPath, 'vms:\n  - id: "vm-trunca\n    name: demo\n')
    const previousFixtures = process.env.GROVE_USE_FIXTURES
    delete process.env.GROVE_USE_FIXTURES
    try {
      const configs = loadInventory(inventoryPath)
      expect(configs).toHaveLength(fixtureVms.length)
    } finally {
      if (previousFixtures !== undefined) process.env.GROVE_USE_FIXTURES = previousFixtures
    }
    expect(existsSync(inventoryPath)).toBe(false)
    expect(readdirSync(root).some((name) => name.startsWith('inventory.yaml.corrupt-'))).toBe(true)
  })
})
