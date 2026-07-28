import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import type {
  ActionProposal,
  AppRunnerService,
  AuditEvent,
  CommandRun,
  CopilotMessage,
  CopilotPlanState,
  CopilotScope,
  CopilotToolCall,
  CredentialProfile,
  GroveApplication,
  GroveSettings,
  GroveStorageStatus,
  TransferJob,
  VM,
  VmConfig,
} from '../src/types'
import { projectStatePath } from './projectState'

export interface PersistedCopilotRecord {
  kind: 'message' | 'toolcall' | 'proposal' | 'plan'
  scope: CopilotScope
  at: number
  data: CopilotMessage | CopilotToolCall | ActionProposal | CopilotPlanState
}

export interface PersistedCopilotState {
  messages: CopilotMessage[]
  toolCalls: CopilotToolCall[]
  proposals: ActionProposal[]
  plans: CopilotPlanState[]
}

export interface LegacyStateImport {
  vmConfigs: VmConfig[]
  settings: GroveSettings
  applications: GroveApplication[]
  appRunnerServices: AppRunnerService[]
  copilot: PersistedCopilotState
  policyRules: Array<{ scope: CopilotScope; prefix: string }>
  backupDirectory: string
}

type SqlRow = Record<string, unknown>

function json(value: unknown) {
  return JSON.stringify(value)
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T
}

function optionalText(value: unknown) {
  return value === null || value === undefined ? undefined : String(value)
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Grove's durable structured state. The database contains control-plane metadata only:
 * credential secrets, source trees, artifacts, logs, and Terraform state remain on the filesystem.
 */
export class GroveDatabase {
  readonly path: string
  private readonly database: DatabaseSync
  private transactionDepth = 0

  constructor(path = projectStatePath('grove.db')) {
    this.path = path === ':memory:' ? path : resolve(path)
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true })
    }
    this.database = new DatabaseSync(this.path, { timeout: 5_000 })
    this.configure()
    this.migrateSchema()
    this.assertIntegrity()
    if (this.path !== ':memory:') {
      try {
        chmodSync(this.path, 0o600)
      } catch {
        // Windows protects the file with the user's profile ACL; chmod is best-effort elsewhere.
      }
    }
  }

  close() {
    if (this.path !== ':memory:') {
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    this.database.close()
  }

  async backup(destination: string) {
    const target = resolve(destination)
    mkdirSync(dirname(target), { recursive: true })
    await sqliteBackup(this.database, target)
    try {
      chmodSync(target, 0o600)
    } catch {
      // Best effort; see constructor.
    }
  }

  quickCheck() {
    const row = this.database.prepare('PRAGMA quick_check').get() as SqlRow | undefined
    return String(row?.quick_check ?? '')
  }

  assertIntegrity() {
    const result = this.quickCheck()
    if (result !== 'ok') {
      throw new Error(`Grove database integrity check failed: ${result || 'unknown result'}. Restore a backup before continuing.`)
    }
  }

  legacyImportCompleted() {
    return Boolean(this.metadata('legacy_import_completed_at'))
  }

  legacyBackupDirectory() {
    return this.metadata('legacy_backup_directory')
  }

  status(): GroveStorageStatus {
    const migration = this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as SqlRow
    const journal = this.database.prepare('PRAGMA journal_mode').get() as SqlRow
    return {
      engine: 'sqlite',
      databasePath: this.path,
      schemaVersion: Number(migration.version ?? 0),
      integrity: this.quickCheck() === 'ok' ? 'ok' : 'error',
      journalMode: String(journal.journal_mode ?? 'unknown'),
      migratedAt: this.metadata('legacy_import_completed_at'),
      backupDirectory: this.metadata('legacy_backup_directory'),
    }
  }

  importLegacyState(input: LegacyStateImport) {
    if (this.legacyImportCompleted()) {
      return
    }
    this.transaction(() => {
      this.saveVmConfigs(input.vmConfigs)
      this.saveSettings(input.settings)
      input.applications.forEach((application, position) => this.saveApplication(application, position))
      this.saveAppRunnerServices(input.appRunnerServices)
      for (const message of input.copilot.messages) {
        const scope = message.scope ?? (message.contextVmId ? `vm:${message.contextVmId}` : 'fleet')
        this.recordCopilotMessage(scope, message, message.createdAt ?? (Date.parse(message.timestamp) || Date.now()))
      }
      for (const toolCall of input.copilot.toolCalls) {
        this.recordCopilotToolCall(toolCall.scope, toolCall, toolCall.createdAt)
      }
      for (const proposal of input.copilot.proposals) {
        const scope = proposal.scope ?? (proposal.vmId ? `vm:${proposal.vmId}` : 'fleet')
        this.recordCopilotProposal(scope, proposal, proposal.createdAt ?? Date.now())
      }
      for (const plan of input.copilot.plans) {
        this.recordCopilotPlan(plan.scope, plan, plan.createdAt)
      }
      this.savePolicyRules(input.policyRules)
      this.setMetadata('legacy_backup_directory', input.backupDirectory)
      this.setMetadata('legacy_import_completed_at', nowIso())
    })
  }

  loadVmConfigs(): VmConfig[] {
    const rows = this.database.prepare('SELECT * FROM vm_configs ORDER BY position').all() as SqlRow[]
    return rows.map((row) => {
      const keyPath = optionalText(row.key_path)
      const os = optionalText(row.os)
      const labels = parseJson<string[]>(row.labels_json)
      const provider = parseJson<VmConfig['provider'] | null>(row.provider_json)
      return {
        id: String(row.id),
        name: String(row.name),
        host: String(row.host),
        user: String(row.username),
        port: Number(row.port),
        ...(keyPath ? { keyPath } : {}),
        ...(row.use_agent ? { useAgent: true } : {}),
        ...(os ? { os } : {}),
        ...(labels.length ? { labels } : {}),
        ...(provider ? { provider } : {}),
      }
    })
  }

  saveVmConfigs(configs: VmConfig[]) {
    this.transaction(() => {
      const retained = new Set(configs.map((config) => config.id))
      const existing = this.database.prepare('SELECT id FROM vm_configs').all() as SqlRow[]
      const remove = this.database.prepare('DELETE FROM vm_configs WHERE id = ?')
      for (const row of existing) {
        if (!retained.has(String(row.id))) remove.run(String(row.id))
      }
      const statement = this.database.prepare(`
        INSERT INTO vm_configs (
          id, position, name, host, username, port, key_path, use_agent, os, labels_json, provider_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          position=excluded.position, name=excluded.name, host=excluded.host, username=excluded.username,
          port=excluded.port, key_path=excluded.key_path, use_agent=excluded.use_agent, os=excluded.os,
          labels_json=excluded.labels_json, provider_json=excluded.provider_json, updated_at=excluded.updated_at
      `)
      configs.forEach((config, position) => {
        statement.run(
          config.id,
          position,
          config.name,
          config.host,
          config.user,
          config.port,
          config.keyPath ?? null,
          config.useAgent ? 1 : 0,
          config.os ?? null,
          json(config.labels ?? []),
          json(config.provider ?? null),
          nowIso(),
        )
      })
    })
  }

  loadVmRuntime(vmId: string) {
    const row = this.database.prepare('SELECT payload_json FROM vm_runtime WHERE vm_id = ?').get(vmId) as SqlRow | undefined
    return row ? parseJson<VM>(row.payload_json) : undefined
  }

  saveVmRuntime(vm: VM) {
    this.database
      .prepare(`
        INSERT INTO vm_runtime (vm_id, payload_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(vm_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
      `)
      .run(vm.id, json(vm), nowIso())
  }

  loadSettings(): GroveSettings | undefined {
    const row = this.database.prepare('SELECT * FROM settings WHERE id = 1').get() as SqlRow | undefined
    if (!row) return undefined
    const profiles = this.database.prepare('SELECT * FROM credential_profiles ORDER BY position').all() as SqlRow[]
    return {
      schemaVersion: 2,
      workspacePath: String(row.workspace_path),
      workspaceStatus: String(row.workspace_status) as GroveSettings['workspaceStatus'],
      credentialProfiles: profiles.map((profile) => this.credentialProfile(profile)),
      legacyAppRunnerMigrationCompletedAt: optionalText(row.legacy_apprunner_migration_completed_at),
    }
  }

  saveSettings(settings: GroveSettings) {
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO settings (
            id, schema_version, workspace_path, workspace_status, legacy_apprunner_migration_completed_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            schema_version=excluded.schema_version, workspace_path=excluded.workspace_path,
            workspace_status=excluded.workspace_status,
            legacy_apprunner_migration_completed_at=excluded.legacy_apprunner_migration_completed_at,
            updated_at=excluded.updated_at
        `)
        .run(
          settings.schemaVersion,
          settings.workspacePath,
          settings.workspaceStatus,
          settings.legacyAppRunnerMigrationCompletedAt ?? null,
          nowIso(),
        )
      const retained = new Set(settings.credentialProfiles.map((profile) => profile.id))
      const existing = this.database.prepare('SELECT id FROM credential_profiles').all() as SqlRow[]
      const remove = this.database.prepare('DELETE FROM credential_profiles WHERE id = ?')
      for (const row of existing) {
        if (!retained.has(String(row.id))) remove.run(String(row.id))
      }
      const save = this.database.prepare(`
        INSERT INTO credential_profiles (
          id, position, kind, name, is_default, secret_configured, configuration_json,
          created_at, updated_at, last_test_at, last_test_status, last_test_detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          position=excluded.position, kind=excluded.kind, name=excluded.name, is_default=excluded.is_default,
          secret_configured=excluded.secret_configured, configuration_json=excluded.configuration_json,
          updated_at=excluded.updated_at, last_test_at=excluded.last_test_at,
          last_test_status=excluded.last_test_status, last_test_detail=excluded.last_test_detail
      `)
      settings.credentialProfiles.forEach((profile, position) => {
        save.run(
          profile.id,
          position,
          profile.kind,
          profile.name,
          profile.isDefault ? 1 : 0,
          profile.secretConfigured ? 1 : 0,
          json(profile.configuration),
          profile.createdAt,
          profile.updatedAt,
          profile.lastTestAt ?? null,
          profile.lastTestStatus ?? null,
          profile.lastTestDetail ?? null,
        )
      })
    })
  }

  loadApplications(): GroveApplication[] {
    const rows = this.database.prepare('SELECT * FROM applications ORDER BY position, updated_at DESC').all() as SqlRow[]
    return rows.map((row) => {
      const id = String(row.id)
      const children = (table: string) =>
        (this.database.prepare(`SELECT payload_json FROM ${table} WHERE application_id = ? ORDER BY position`).all(id) as SqlRow[]).map(
          (child) => parseJson<unknown>(child.payload_json),
        )
      const deployments = (children('application_deployments') as GroveApplication['deployments']).map((deployment) => ({
        ...deployment,
        targets: (
          this.database
            .prepare('SELECT payload_json FROM deployment_targets WHERE deployment_id = ? ORDER BY position')
            .all(deployment.id) as SqlRow[]
        ).map((target) => parseJson<GroveApplication['deployments'][number]['targets'][number]>(target.payload_json)),
      }))
      const environments = (children('application_environments') as GroveApplication['environments']).map((environment) => ({
        ...environment,
        operations: (
          this.database
            .prepare('SELECT payload_json FROM infrastructure_operations WHERE environment_id = ? ORDER BY position')
            .all(environment.id) as SqlRow[]
        ).map((operation) =>
          parseJson<GroveApplication['environments'][number]['operations'][number]>(operation.payload_json),
        ),
      }))
      return {
        id,
        slug: String(row.slug),
        name: String(row.name),
        description: optionalText(row.description),
        source: parseJson(row.source_json),
        managedSourcePath: String(row.managed_source_path),
        configuration: parseJson(row.configuration_json),
        domain: row.domain_json ? parseJson(row.domain_json) : undefined,
        health: String(row.health) as GroveApplication['health'],
        activeVersionId: optionalText(row.active_version_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        versions: children('application_versions') as GroveApplication['versions'],
        deployments,
        instances: children('application_instances') as GroveApplication['instances'],
        environments,
      }
    })
  }

  saveApplication(application: GroveApplication, position = 0) {
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO applications (
            id, position, slug, name, description, source_json, managed_source_path,
            configuration_json, domain_json, health, active_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            position=excluded.position, slug=excluded.slug, name=excluded.name, description=excluded.description,
            source_json=excluded.source_json, managed_source_path=excluded.managed_source_path,
            configuration_json=excluded.configuration_json, domain_json=excluded.domain_json, health=excluded.health,
            active_version_id=excluded.active_version_id, updated_at=excluded.updated_at
        `)
        .run(
          application.id,
          position,
          application.slug,
          application.name,
          application.description ?? null,
          json(application.source),
          application.managedSourcePath,
          json(application.configuration),
          application.domain ? json(application.domain) : null,
          application.health,
          application.activeVersionId ?? null,
          application.createdAt,
          application.updatedAt,
        )
      this.database.prepare('DELETE FROM application_deployments WHERE application_id = ?').run(application.id)
      this.database.prepare('DELETE FROM application_versions WHERE application_id = ?').run(application.id)
      this.database.prepare('DELETE FROM application_instances WHERE application_id = ?').run(application.id)
      this.database.prepare('DELETE FROM application_environments WHERE application_id = ?').run(application.id)
      this.insertApplicationChildren('application_versions', application.id, application.versions)
      this.insertApplicationChildren('application_instances', application.id, application.instances)
      const saveDeployment = this.database.prepare(
        'INSERT INTO application_deployments (id, application_id, position, payload_json) VALUES (?, ?, ?, ?)',
      )
      const saveTarget = this.database.prepare(
        'INSERT INTO deployment_targets (deployment_id, vm_id, position, payload_json) VALUES (?, ?, ?, ?)',
      )
      application.deployments.forEach((deployment, deploymentPosition) => {
        saveDeployment.run(deployment.id, application.id, deploymentPosition, json({ ...deployment, targets: [] }))
        deployment.targets.forEach((target, targetPosition) => {
          saveTarget.run(deployment.id, target.vmId, targetPosition, json(target))
        })
      })
      const saveEnvironment = this.database.prepare(
        'INSERT INTO application_environments (id, application_id, position, payload_json) VALUES (?, ?, ?, ?)',
      )
      const saveOperation = this.database.prepare(
        'INSERT INTO infrastructure_operations (id, environment_id, position, payload_json) VALUES (?, ?, ?, ?)',
      )
      application.environments.forEach((environment, environmentPosition) => {
        saveEnvironment.run(environment.id, application.id, environmentPosition, json({ ...environment, operations: [] }))
        environment.operations.forEach((operation, operationPosition) => {
          saveOperation.run(operation.id, environment.id, operationPosition, json(operation))
        })
      })
    })
  }

  deleteApplication(applicationId: string) {
    this.database.prepare('DELETE FROM applications WHERE id = ?').run(applicationId)
  }

  loadAppRunnerServices(): AppRunnerService[] {
    return (this.database.prepare('SELECT payload_json FROM app_runner_services ORDER BY position').all() as SqlRow[]).map((row) =>
      parseJson(row.payload_json),
    )
  }

  saveAppRunnerServices(services: AppRunnerService[]) {
    this.transaction(() => {
      this.database.exec('DELETE FROM app_runner_services')
      const save = this.database.prepare('INSERT INTO app_runner_services (id, position, payload_json) VALUES (?, ?, ?)')
      services.forEach((service, position) => save.run(service.id, position, json(service)))
    })
  }

  loadTransfers(): TransferJob[] {
    const rows = this.database.prepare('SELECT payload_json FROM transfers ORDER BY updated_at DESC').all() as SqlRow[]
    return rows.map((row) => parseJson<TransferJob>(row.payload_json))
  }

  saveTransfer(transfer: TransferJob) {
    this.database
      .prepare(`
        INSERT INTO transfers (id, vm_id, status, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at
      `)
      .run(transfer.id, transfer.vmId, transfer.status, json(transfer), nowIso())
  }

  saveCommandRun(run: CommandRun) {
    this.database
      .prepare(`
        INSERT INTO command_runs (id, vm_id, actor, status, started_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json
      `)
      .run(run.id, run.vmId, run.actor, run.status, run.startedAt, json(run))
  }

  saveAuditEvent(event: AuditEvent) {
    this.database
      .prepare(`
        INSERT INTO audit_events (id, vm_id, actor, timestamp, payload_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
      `)
      .run(event.id, event.vmId, event.actor, event.timestamp, json(event))
  }

  recordCopilotMessage(scope: CopilotScope, message: CopilotMessage, at = Date.now()) {
    this.upsertCopilot('copilot_messages', message.id, scope, at, message)
  }

  recordCopilotToolCall(scope: CopilotScope, toolCall: CopilotToolCall, at = Date.now()) {
    this.upsertCopilot('copilot_tool_calls', toolCall.id, scope, at, toolCall)
  }

  recordCopilotProposal(scope: CopilotScope, proposal: ActionProposal, at = Date.now()) {
    this.upsertCopilot('action_proposals', proposal.id, scope, at, proposal)
  }

  recordCopilotPlan(scope: CopilotScope, plan: CopilotPlanState, at = Date.now()) {
    this.transaction(() => {
      this.upsertCopilot('copilot_plans', plan.id, scope, at, { ...plan, entries: [] })
      this.database.prepare('DELETE FROM copilot_plan_entries WHERE plan_id = ?').run(plan.id)
      const save = this.database.prepare(
        'INSERT INTO copilot_plan_entries (plan_id, position, payload_json) VALUES (?, ?, ?)',
      )
      plan.entries.forEach((entry, position) => save.run(plan.id, position, json(entry)))
    })
  }

  loadCopilotState(): PersistedCopilotState {
    const load = <T>(table: string) =>
      (this.database.prepare(`SELECT payload_json FROM ${table} ORDER BY created_at`).all() as SqlRow[]).map((row) =>
        parseJson<T>(row.payload_json),
      )
    const plans = load<CopilotPlanState>('copilot_plans').map((plan) => ({
      ...plan,
      entries: (
        this.database.prepare('SELECT payload_json FROM copilot_plan_entries WHERE plan_id = ? ORDER BY position').all(plan.id) as SqlRow[]
      ).map((entry) => parseJson<CopilotPlanState['entries'][number]>(entry.payload_json)),
    }))
    return {
      messages: load('copilot_messages'),
      toolCalls: load('copilot_tool_calls'),
      proposals: load('action_proposals'),
      plans,
    }
  }

  copilotRecords(scope: CopilotScope): PersistedCopilotRecord[] {
    const rows = this.database
      .prepare(`
        SELECT 'message' AS kind, scope, created_at AS at, payload_json FROM copilot_messages WHERE scope = ?
        UNION ALL SELECT 'toolcall', scope, created_at, payload_json FROM copilot_tool_calls WHERE scope = ?
        UNION ALL SELECT 'proposal', scope, created_at, payload_json FROM action_proposals WHERE scope = ?
        UNION ALL SELECT 'plan', scope, created_at, payload_json FROM copilot_plans WHERE scope = ?
        ORDER BY at
      `)
      .all(scope, scope, scope, scope) as SqlRow[]
    return rows.map((row) => ({
      kind: String(row.kind) as PersistedCopilotRecord['kind'],
      scope: String(row.scope) as CopilotScope,
      at: Number(row.at),
      data: parseJson(row.payload_json),
    }))
  }

  loadPolicyRules() {
    return (this.database.prepare('SELECT scope, prefix FROM copilot_policy_rules ORDER BY created_at').all() as SqlRow[]).map(
      (row) => ({ scope: String(row.scope) as CopilotScope, prefix: String(row.prefix) }),
    )
  }

  savePolicyRules(rules: Array<{ scope: CopilotScope; prefix: string }>) {
    this.transaction(() => {
      this.database.exec('DELETE FROM copilot_policy_rules')
      const save = this.database.prepare('INSERT INTO copilot_policy_rules (scope, prefix, created_at) VALUES (?, ?, ?)')
      rules.forEach((rule) => save.run(rule.scope, rule.prefix, nowIso()))
    })
  }

  private configure() {
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    if (this.path !== ':memory:') {
      this.database.exec('PRAGMA journal_mode = WAL')
      this.database.exec('PRAGMA synchronous = NORMAL')
    }
  }

  private migrateSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vm_configs (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
        username TEXT NOT NULL, port INTEGER NOT NULL, key_path TEXT, use_agent INTEGER NOT NULL,
        os TEXT, labels_json TEXT NOT NULL, provider_json TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vm_runtime (
        vm_id TEXT PRIMARY KEY REFERENCES vm_configs(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
        workspace_path TEXT NOT NULL, workspace_status TEXT NOT NULL,
        legacy_apprunner_migration_completed_at TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS credential_profiles (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        is_default INTEGER NOT NULL, secret_configured INTEGER NOT NULL, configuration_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_test_at TEXT,
        last_test_status TEXT, last_test_detail TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        description TEXT, source_json TEXT NOT NULL, managed_source_path TEXT NOT NULL,
        configuration_json TEXT NOT NULL, domain_json TEXT, health TEXT NOT NULL, active_version_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_versions (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_instances (
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE, vm_id TEXT NOT NULL,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (application_id, vm_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_deployments (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deployment_targets (
        deployment_id TEXT NOT NULL REFERENCES application_deployments(id) ON DELETE CASCADE,
        vm_id TEXT NOT NULL, position INTEGER NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY (deployment_id, vm_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_environments (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS infrastructure_operations (
        id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES application_environments(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS app_runner_services (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, status TEXT NOT NULL,
        payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, actor TEXT NOT NULL, timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS copilot_messages (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS copilot_tool_calls (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_proposals (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS copilot_plans (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS copilot_plan_entries (
        plan_id TEXT NOT NULL REFERENCES copilot_plans(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (plan_id, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS copilot_policy_rules (
        scope TEXT NOT NULL, prefix TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (scope, prefix)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_command_runs_vm_started ON command_runs(vm_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_vm_time ON audit_events(vm_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_copilot_messages_scope_time ON copilot_messages(scope, created_at);
      CREATE INDEX IF NOT EXISTS idx_copilot_tools_scope_time ON copilot_tool_calls(scope, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_scope_time ON action_proposals(scope, created_at);
      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
    `)
    const applicationColumns = this.database.prepare('PRAGMA table_info(applications)').all() as SqlRow[]
    if (!applicationColumns.some((column) => String(column.name) === 'domain_json')) {
      this.database.exec('ALTER TABLE applications ADD COLUMN domain_json TEXT')
    }
    this.database.exec(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, CURRENT_TIMESTAMP)',
    )
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()
    this.database.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  private metadata(key: string) {
    const row = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as SqlRow | undefined
    return row ? String(row.value) : undefined
  }

  private setMetadata(key: string, value: string) {
    this.database
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  private credentialProfile(row: SqlRow): CredentialProfile {
    return {
      id: String(row.id),
      kind: String(row.kind) as CredentialProfile['kind'],
      name: String(row.name),
      isDefault: Boolean(row.is_default),
      secretConfigured: Boolean(row.secret_configured),
      configuration: parseJson(row.configuration_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastTestAt: optionalText(row.last_test_at),
      lastTestStatus: optionalText(row.last_test_status) as CredentialProfile['lastTestStatus'],
      lastTestDetail: optionalText(row.last_test_detail),
    }
  }

  private insertApplicationChildren(table: 'application_versions' | 'application_instances', applicationId: string, values: unknown[]) {
    if (table === 'application_versions') {
      const save = this.database.prepare(
        'INSERT INTO application_versions (id, application_id, position, payload_json) VALUES (?, ?, ?, ?)',
      )
      values.forEach((value, position) => {
        const record = value as { id: string }
        save.run(record.id, applicationId, position, json(record))
      })
      return
    }
    const save = this.database.prepare(
      'INSERT INTO application_instances (application_id, vm_id, position, payload_json) VALUES (?, ?, ?, ?)',
    )
    values.forEach((value, position) => {
      const record = value as { vmId: string }
      save.run(applicationId, record.vmId, position, json(record))
    })
  }

  private upsertCopilot(table: string, id: string, scope: CopilotScope, at: number, payload: unknown) {
    this.database
      .prepare(`
        INSERT INTO ${table} (id, scope, created_at, payload_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scope=excluded.scope,
          created_at=CASE WHEN excluded.created_at < created_at THEN excluded.created_at ELSE created_at END,
          payload_json=excluded.payload_json
      `)
      .run(id, scope, at, json(payload))
  }
}
