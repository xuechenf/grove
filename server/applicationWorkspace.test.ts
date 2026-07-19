import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { vms as fixtureVms } from '../src/data/fixtures'
import type { GroveApplicationInput, VmConfig } from '../src/types'
import { ApplicationManager } from './applicationManager'
import { ApplicationWorkspace } from './applicationWorkspace'
import { MockSshSessionManager } from './sshSessionManager'
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
})
