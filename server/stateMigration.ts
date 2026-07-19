import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { VmConfig } from '../src/types'
import { projectStateDir } from './projectState'

export interface V2MigrationRecord {
  schemaVersion: 2
  createdAt: string
  legacyVmIds: string[]
  backupDirectory: string
  backedUpFiles: string[]
}

export interface V2MigrationOptions {
  persist?: boolean
  stateDirectory?: string
}

/**
 * Create one additive v1 -> v2 recovery snapshot before any v2 metadata is written.
 * The legacy inventory remains authoritative and in place; this function never rewrites it.
 */
export function ensureV2StateMigration(vmConfigs: VmConfig[], options: V2MigrationOptions = {}): V2MigrationRecord | undefined {
  if (options.persist === false) {
    return undefined
  }

  const stateDirectory = resolve(options.stateDirectory ?? projectStateDir())
  const migrationDirectory = join(stateDirectory, 'migrations')
  const markerPath = join(migrationDirectory, 'v2.json')
  if (existsSync(markerPath)) {
    return JSON.parse(readFileSync(markerPath, 'utf8')) as V2MigrationRecord
  }

  const createdAt = new Date().toISOString()
  const stamp = createdAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const backupDirectory = join(stateDirectory, 'backups', `v1-before-v2-${stamp}`)
  mkdirSync(backupDirectory, { recursive: true })

  const backedUpFiles: string[] = []
  for (const fileName of ['inventory.yaml', 'apprunner.yaml', '.env.local']) {
    const sourcePath = join(stateDirectory, fileName)
    if (!existsSync(sourcePath)) {
      continue
    }
    copyFileSync(sourcePath, join(backupDirectory, basename(sourcePath)))
    backedUpFiles.push(fileName)
  }

  const record: V2MigrationRecord = {
    schemaVersion: 2,
    createdAt,
    legacyVmIds: vmConfigs.map((config) => config.id),
    backupDirectory,
    backedUpFiles,
  }
  mkdirSync(migrationDirectory, { recursive: true })
  writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}
