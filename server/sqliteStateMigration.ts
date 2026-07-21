import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ApplicationWorkspace } from './applicationWorkspace'
import { loadAppRunnerServices } from './appRunnerMetadata'
import { CopilotJournal } from './copilotJournal'
import { CopilotPolicy } from './copilotPolicy'
import { GroveDatabase } from './database'
import { loadInventory } from './inventory'
import { projectStateDir } from './projectState'
import { atomicWriteFileSync } from './stateFiles'

export interface SqliteStateMigrationResult {
  database: GroveDatabase
  migrated: boolean
  backupDirectory?: string
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function copyIfPresent(source: string, target: string, backedUpFiles: string[], label: string) {
  if (!existsSync(source)) return
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  backedUpFiles.push(label)
}

/**
 * Open Grove's database, atomically importing the v0.3 YAML/JSONL control-plane state on first
 * launch. Secret-bearing files are deliberately neither opened nor copied: the existing
 * credential vault and key files remain in place and continue to be authoritative.
 */
export function initializeSqliteState(stateDirectory = projectStateDir()): SqliteStateMigrationResult {
  const statePath = resolve(stateDirectory)
  const databasePath = join(statePath, 'grove.db')
  if (existsSync(databasePath)) {
    return { database: new GroveDatabase(databasePath), migrated: false }
  }

  mkdirSync(statePath, { recursive: true })
  const stamp = timestamp()
  const backupDirectory = join(statePath, 'backups', `v2-before-sqlite-${stamp}`)
  const legacyDirectory = join(backupDirectory, 'legacy-state')
  const backedUpFiles: string[] = []

  for (const fileName of ['inventory.yaml', 'settings.yaml', 'apprunner.yaml']) {
    copyIfPresent(join(statePath, fileName), join(legacyDirectory, fileName), backedUpFiles, fileName)
  }
  copyIfPresent(
    join(statePath, 'copilot', 'policy.yaml'),
    join(legacyDirectory, 'copilot', 'policy.yaml'),
    backedUpFiles,
    'copilot/policy.yaml',
  )
  const journalSource = join(statePath, 'copilot', 'journal')
  if (existsSync(journalSource)) {
    const journalTarget = join(legacyDirectory, 'copilot', 'journal')
    mkdirSync(dirname(journalTarget), { recursive: true })
    cpSync(journalSource, journalTarget, { recursive: true })
    for (const file of readdirSync(journalSource)) {
      if (file.endsWith('.jsonl')) backedUpFiles.push(`copilot/journal/${file}`)
    }
  }

  const legacyWorkspace = new ApplicationWorkspace({
    persist: true,
    readOnly: true,
    settingsPath: join(statePath, 'settings.yaml'),
  })
  const settings = legacyWorkspace.settings()
  const applications = legacyWorkspace.listApplications()
  for (const application of applications) {
    const metadataSource = join(settings.workspacePath, application.slug, '.grove', 'application.yaml')
    copyIfPresent(
      metadataSource,
      join(legacyDirectory, 'applications', application.slug, 'application.yaml'),
      backedUpFiles,
      `applications/${application.slug}/application.yaml`,
    )
  }

  const vmConfigs = loadInventory(join(statePath, 'inventory.yaml'))
  const appRunnerServices = loadAppRunnerServices(join(statePath, 'apprunner.yaml'))
  const copilot = new CopilotJournal(join(statePath, 'copilot', 'journal'), true).load()
  const policyRules = new CopilotPolicy({ path: join(statePath, 'copilot', 'policy.yaml'), persist: true }).list()
  const temporaryPath = `${databasePath}.${process.pid}.${Date.now()}.migrating`
  let temporaryDatabase: GroveDatabase | undefined
  try {
    temporaryDatabase = new GroveDatabase(temporaryPath)
    temporaryDatabase.importLegacyState({
      vmConfigs,
      settings,
      applications,
      appRunnerServices,
      copilot,
      policyRules,
      backupDirectory,
    })
    temporaryDatabase.assertIntegrity()
    temporaryDatabase.close()
    temporaryDatabase = undefined
    renameSync(temporaryPath, databasePath)
  } catch (error) {
    try {
      temporaryDatabase?.close()
    } catch {
      // Preserve the original migration failure.
    }
    for (const path of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      rmSync(path, { force: true })
    }
    throw error
  }

  const marker = {
    schemaVersion: 3,
    migratedAt: new Date().toISOString(),
    databasePath,
    backupDirectory,
    backedUpFiles,
    imported: {
      vms: vmConfigs.length,
      credentialProfiles: settings.credentialProfiles.length,
      applications: applications.length,
      appRunnerServices: appRunnerServices.length,
      copilotMessages: copilot.messages.length,
      copilotToolCalls: copilot.toolCalls.length,
      copilotProposals: copilot.proposals.length,
      copilotPlans: copilot.plans.length,
      policyRules: policyRules.length,
    },
  }
  const migrationDirectory = join(statePath, 'migrations')
  mkdirSync(migrationDirectory, { recursive: true })
  atomicWriteFileSync(join(migrationDirectory, 'v3.json'), `${JSON.stringify(marker, null, 2)}\n`)

  // Keep the path user-readable in the backup even when no legacy metadata existed.
  atomicWriteFileSync(
    join(backupDirectory, 'manifest.json'),
    `${JSON.stringify({ createdAt: marker.migratedAt, source: statePath, backedUpFiles }, null, 2)}\n`,
  )

  return { database: new GroveDatabase(databasePath), migrated: true, backupDirectory }
}
