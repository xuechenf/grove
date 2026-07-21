import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroveApplication, GroveSettings, VmConfig } from '../src/types'
import { initializeSqliteState } from './sqliteStateMigration'

const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'grove-sqlite-migration-test-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function writeLegacyState(root: string) {
  const state = join(root, 'state')
  const workspace = join(root, 'workspace')
  const applicationDirectory = join(workspace, 'sample')
  mkdirSync(join(applicationDirectory, '.grove'), { recursive: true })
  const vms: VmConfig[] = [
    { id: 'vm-legacy', name: 'Legacy VM', host: '203.0.113.20', user: 'ubuntu', port: 22, useAgent: true },
  ]
  const settings: GroveSettings = {
    schemaVersion: 2,
    workspacePath: workspace,
    workspaceStatus: 'healthy',
    credentialProfiles: [
      {
        id: 'credential-legacy',
        kind: 'aws',
        name: 'Legacy AWS',
        isDefault: true,
        secretConfigured: true,
        configuration: { accessKeyId: 'SAFE_LEGACY_IDENTIFIER', region: 'us-east-1' },
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    ],
  }
  const application: GroveApplication = {
    id: 'app-legacy',
    slug: 'sample',
    name: 'Sample',
    source: { type: 'local', path: join(root, 'source') },
    managedSourcePath: join(applicationDirectory, 'source'),
    configuration: {
      artifactPath: 'dist',
      startCommand: 'node app.js',
      port: 3000,
      healthCheckPath: '/',
      healthCheckTimeoutSeconds: 30,
      environment: {},
    },
    health: 'not_deployed',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    versions: [],
    deployments: [],
    instances: [],
    environments: [],
  }
  mkdirSync(join(state, 'copilot', 'journal'), { recursive: true })
  mkdirSync(join(state, 'keys'), { recursive: true })
  writeFileSync(join(state, 'inventory.yaml'), stringify({ vms }))
  writeFileSync(join(state, 'settings.yaml'), stringify(settings))
  writeFileSync(join(state, 'apprunner.yaml'), stringify({ services: [] }))
  writeFileSync(join(applicationDirectory, '.grove', 'application.yaml'), stringify({ schemaVersion: 2, application }))
  writeFileSync(
    join(state, 'copilot', 'journal', 'fleet.jsonl'),
    `${JSON.stringify({
      kind: 'message',
      scope: 'fleet',
      at: 1,
      data: { id: 'legacy-message', role: 'user', content: 'hello', timestamp: '2026-07-20T00:00:00.000Z', scope: 'fleet', createdAt: 1 },
    })}\n`,
  )
  writeFileSync(join(state, 'copilot', 'policy.yaml'), stringify({ rules: [{ scope: 'fleet', prefix: 'systemctl restart' }] }))
  const secret = 'MIGRATION_SECRET_MUST_NOT_ENTER_SQLITE'
  writeFileSync(join(state, '.env.local'), `GROVE_COPILOT_API_KEY=${secret}\n`)
  writeFileSync(join(state, 'credentials.os-vault.json'), JSON.stringify({ ciphertext: secret }))
  writeFileSync(join(state, 'keys', 'legacy.pem'), `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`)
  return { state, application, settings, vms, secret }
}

describe('initializeSqliteState', () => {
  it('atomically imports v0.3 state while excluding credentials and preserving legacy files', () => {
    const legacy = writeLegacyState(temporaryDirectory())
    const inventoryBefore = readFileSync(join(legacy.state, 'inventory.yaml'), 'utf8')
    const settingsBefore = readFileSync(join(legacy.state, 'settings.yaml'), 'utf8')

    const result = initializeSqliteState(legacy.state)
    expect(result.migrated).toBe(true)
    expect(result.database.loadVmConfigs()).toEqual(legacy.vms)
    expect(result.database.loadSettings()).toEqual(legacy.settings)
    expect(result.database.loadApplications()).toEqual([legacy.application])
    expect(result.database.loadCopilotState().messages.map((message) => message.id)).toEqual(['legacy-message'])
    expect(result.database.loadPolicyRules()).toEqual([{ scope: 'fleet', prefix: 'systemctl restart' }])
    expect(result.database.quickCheck()).toBe('ok')
    result.database.close()

    expect(readFileSync(join(legacy.state, 'inventory.yaml'), 'utf8')).toBe(inventoryBefore)
    expect(readFileSync(join(legacy.state, 'settings.yaml'), 'utf8')).toBe(settingsBefore)
    expect(existsSync(join(legacy.state, 'migrations', 'v3.json'))).toBe(true)
    expect(existsSync(join(result.backupDirectory!, 'legacy-state', 'inventory.yaml'))).toBe(true)
    expect(existsSync(join(result.backupDirectory!, 'legacy-state', '.env.local'))).toBe(false)
    expect(existsSync(join(result.backupDirectory!, 'legacy-state', 'credentials.os-vault.json'))).toBe(false)
    expect(existsSync(join(result.backupDirectory!, 'legacy-state', 'keys', 'legacy.pem'))).toBe(false)
    expect(readFileSync(join(legacy.state, 'grove.db')).includes(Buffer.from(legacy.secret))).toBe(false)

    const reopened = initializeSqliteState(legacy.state)
    expect(reopened.migrated).toBe(false)
    expect(reopened.database.loadVmConfigs()).toEqual(legacy.vms)
    reopened.database.close()
  })

  it('does not publish a database when legacy application metadata is invalid', () => {
    const legacy = writeLegacyState(temporaryDirectory())
    const metadata = join(legacy.settings.workspacePath, 'sample', '.grove', 'application.yaml')
    writeFileSync(metadata, 'schemaVersion: 2\napplication:\n  id: truncated\n')

    expect(() => initializeSqliteState(legacy.state)).toThrow()
    expect(existsSync(join(legacy.state, 'grove.db'))).toBe(false)
    expect(readFileSync(metadata, 'utf8')).toContain('id: truncated')
  })
})
