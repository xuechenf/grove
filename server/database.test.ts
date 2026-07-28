import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroveApplication, GroveSettings, TransferJob, VmConfig } from '../src/types'
import { GroveDatabase } from './database'

const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'grove-database-test-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function application(root: string): GroveApplication {
  return {
    id: 'app-one',
    slug: 'one',
    name: 'One',
    source: { type: 'local', path: join(root, 'source-input') },
    managedSourcePath: join(root, 'workspace', 'one', 'source'),
    configuration: {
      artifactPath: 'dist',
      startCommand: 'node server.js',
      port: 3000,
      healthCheckPath: '/health',
      healthCheckTimeoutSeconds: 30,
      environment: { NODE_ENV: 'production' },
    },
    health: 'healthy',
    activeVersionId: 'version-one',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:01:00.000Z',
    versions: [
      {
        id: 'version-one',
        label: 'v1',
        sequence: 1,
        status: 'succeeded',
        createdAt: '2026-07-21T00:00:00.000Z',
        completedAt: '2026-07-21T00:00:30.000Z',
        artifactRelativePath: '.grove/versions/version-one/artifact',
        artifactDigest: 'sha256:test',
        artifactSizeBytes: 42,
        buildLogRelativePath: '.grove/versions/version-one/build.log',
      },
    ],
    deployments: [
      {
        id: 'deployment-one',
        applicationId: 'app-one',
        versionId: 'version-one',
        environment: 'production',
        strategy: 'rolling',
        status: 'succeeded',
        createdAt: '2026-07-21T00:01:00.000Z',
        targetVmIds: ['vm-one'],
        targets: [{ vmId: 'vm-one', status: 'healthy', completedAt: '2026-07-21T00:01:20.000Z' }],
      },
    ],
    instances: [
      {
        vmId: 'vm-one',
        versionId: 'version-one',
        status: 'healthy',
        remotePath: '~/grove/one',
        unitName: 'grove-one',
        updatedAt: '2026-07-21T00:01:20.000Z',
      },
    ],
    domain: {
      hostname: 'one.example.com',
      nameComCredentialProfileId: 'credential-namecom',
      vmId: 'vm-one',
      dnsStatus: 'ready',
      dnsRecordId: '42',
      dnsDetail: 'one.example.com points to 203.0.113.10 with TTL 300.',
      updatedAt: '2026-07-21T00:01:30.000Z',
    },
    environments: [
      {
        id: 'environment-one',
        slug: 'production',
        name: 'Production',
        provider: 'aws',
        region: 'us-west-1',
        providerCredentialProfileId: 'credential-aws',
        sshCredentialProfileId: 'credential-ssh',
        vmName: 'one-production',
        instanceType: 't3.nano',
        imageId: 'ami-test',
        systemUser: 'ec2-user',
        diskSizeGb: 8,
        assignPublicIp: true,
        ingressRules: [{ description: 'HTTP', protocol: 'tcp', fromPort: 80, toPort: 80, cidrs: ['0.0.0.0/0'] }],
        dnsStatus: 'not_configured',
        status: 'planned',
        vmIds: ['vm-one'],
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:01:00.000Z',
        operations: [
          {
            id: 'operation-one',
            kind: 'plan',
            status: 'succeeded',
            createdAt: '2026-07-21T00:00:40.000Z',
            completedAt: '2026-07-21T00:00:50.000Z',
            logRelativePath: '.grove/environments/environment-one/plan.log',
            changes: { add: 1, change: 0, destroy: 0 },
          },
        ],
      },
    ],
  }
}

describe('GroveDatabase', () => {
  it('round-trips normalized control-plane state across a restart', () => {
    const root = temporaryDirectory()
    const path = join(root, 'grove.db')
    const vm: VmConfig = {
      id: 'vm-one',
      name: 'vm-one',
      host: '203.0.113.10',
      user: 'ubuntu',
      port: 22,
      useAgent: true,
      labels: ['production'],
      provider: { name: 'aws', region: 'us-west-1', node: 'i-test' },
    }
    const settings: GroveSettings = {
      schemaVersion: 2,
      workspacePath: join(root, 'workspace'),
      workspaceStatus: 'healthy',
      credentialProfiles: [
        {
          id: 'credential-aws',
          kind: 'aws',
          name: 'AWS',
          isDefault: true,
          secretConfigured: true,
          configuration: { accessKeyId: 'SAFE_IDENTIFIER', region: 'us-west-1' },
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    }
    const transfer: TransferJob = {
      id: 'transfer-one',
      vmId: 'vm-one',
      direction: 'upload',
      source: 'D:\\source.txt',
      target: '/tmp/source.txt',
      fileName: 'source.txt',
      status: 'completed',
      progress: 100,
      speed: 'done',
    }

    const database = new GroveDatabase(path)
    database.saveVmConfigs([vm])
    database.saveSettings(settings)
    database.saveApplication(application(root))
    database.saveTransfer(transfer)
    database.recordCopilotMessage('vm:vm-one', {
      id: 'message-one',
      role: 'user',
      content: 'status',
      timestamp: '2026-07-21T00:02:00.000Z',
      scope: 'vm:vm-one',
      createdAt: 1,
    })
    database.savePolicyRules([{ scope: 'vm:vm-one', prefix: 'systemctl restart' }])
    expect(database.quickCheck()).toBe('ok')
    database.close()

    const reopened = new GroveDatabase(path)
    expect(reopened.loadVmConfigs()).toEqual([vm])
    expect(reopened.loadSettings()).toEqual(settings)
    expect(reopened.loadApplications()).toEqual([application(root)])
    expect(reopened.loadTransfers()).toEqual([transfer])
    expect(reopened.loadCopilotState().messages).toHaveLength(1)
    expect(reopened.loadPolicyRules()).toEqual([{ scope: 'vm:vm-one', prefix: 'systemctl restart' }])
    reopened.close()
  })

  it('creates a consistent online backup', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'grove.db')
    const backupPath = join(root, 'backups', 'grove.db')
    const database = new GroveDatabase(path)
    database.saveVmConfigs([{ id: 'vm-one', name: 'One', host: '127.0.0.1', user: 'test', port: 22 }])
    await database.backup(backupPath)
    database.close()

    const backup = new GroveDatabase(backupPath)
    expect(backup.loadVmConfigs()).toHaveLength(1)
    expect(backup.quickCheck()).toBe('ok')
    backup.close()
    expect(readFileSync(backupPath).length).toBeGreaterThan(0)
  })

  it('adds application domain storage to an existing version-one database', () => {
    const root = temporaryDirectory()
    const path = join(root, 'grove.db')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
      CREATE TABLE applications (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        description TEXT, source_json TEXT NOT NULL, managed_source_path TEXT NOT NULL,
        configuration_json TEXT NOT NULL, health TEXT NOT NULL, active_version_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
    `)
    legacy.close()

    const migrated = new GroveDatabase(path)
    expect(migrated.status().schemaVersion).toBe(2)
    migrated.saveApplication(application(root))
    expect(migrated.loadApplications()[0]?.domain?.dnsRecordId).toBe('42')
    migrated.close()
  })
})
