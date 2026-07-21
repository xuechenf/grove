import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type {
  ApplicationDeployment,
  ApplicationInstance,
  ApplicationVersion,
  CredentialProfile,
  GroveApplication,
  GroveApplicationInput,
  GroveSettings,
} from '../src/types'
import { projectStatePath } from './projectState'
import { atomicWriteFileSync, quarantineCorruptFile } from './stateFiles'

const applicationSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), path: z.string().min(1) }),
  z.object({ type: z.literal('git'), repoUrl: z.string().min(1), ref: z.string().min(1).optional() }),
])

const configurationSchema = z.object({
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  artifactPath: z.string().min(1),
  startCommand: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  healthCheckPath: z.string().min(1),
  healthCheckTimeoutSeconds: z.number().int().min(1).max(600),
  environment: z.record(z.string(), z.string()).default({}),
})

const versionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sequence: z.number().int().positive(),
  status: z.enum(['building', 'succeeded', 'failed']),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
  sourceRevision: z.string().optional(),
  artifactRelativePath: z.string().optional(),
  artifactDigest: z.string().optional(),
  artifactSizeBytes: z.number().nonnegative().optional(),
  buildLogRelativePath: z.string().min(1),
  failure: z.string().optional(),
})

const deploymentTargetSchema = z.object({
  vmId: z.string().min(1),
  status: z.enum(['queued', 'uploading', 'activating', 'healthy', 'rolled_back', 'failed']),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  detail: z.string().optional(),
  previousVersionId: z.string().optional(),
})

const deploymentSchema = z.object({
  id: z.string().min(1),
  applicationId: z.string().min(1),
  versionId: z.string().min(1),
  environment: z.string().min(1),
  strategy: z.literal('rolling'),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed']),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
  targetVmIds: z.array(z.string().min(1)),
  targets: z.array(deploymentTargetSchema),
})

const instanceSchema = z.object({
  vmId: z.string().min(1),
  versionId: z.string().optional(),
  desiredVersionId: z.string().optional(),
  status: z.enum(['unknown', 'uploading', 'deploying', 'healthy', 'degraded', 'failed', 'stopped']),
  remotePath: z.string().min(1),
  unitName: z.string().min(1),
  updatedAt: z.string().min(1),
  healthDetail: z.string().optional(),
  lastDeploymentId: z.string().optional(),
})

const ingressRuleSchema = z.object({
  description: z.string(),
  protocol: z.enum(['tcp', 'udp']),
  fromPort: z.number().int().min(1).max(65535),
  toPort: z.number().int().min(1).max(65535),
  cidrs: z.array(z.string().min(1)).min(1),
})

const infrastructureOperationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['plan', 'apply', 'destroy-plan', 'destroy-apply']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
  planDigest: z.string().optional(),
  planRelativePath: z.string().optional(),
  logRelativePath: z.string().min(1),
  changes: z.object({ add: z.number().int().nonnegative(), change: z.number().int().nonnegative(), destroy: z.number().int().nonnegative() }).optional(),
  failure: z.string().optional(),
})

const applicationEnvironmentSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(['aws', 'azure', 'alicloud']),
  region: z.string().min(1),
  providerCredentialProfileId: z.string().min(1),
  sshCredentialProfileId: z.string().min(1),
  vmName: z.string().min(1),
  instanceType: z.string().min(1),
  imageId: z.string().min(1),
  systemUser: z.string().min(1),
  diskSizeGb: z.number().int().min(8).max(4096),
  assignPublicIp: z.boolean(),
  ingressRules: z.array(ingressRuleSchema),
  nameComCredentialProfileId: z.string().optional(),
  hostname: z.string().optional(),
  dnsStatus: z.enum(['not_configured', 'pending', 'ready', 'failed']).default('not_configured'),
  dnsRecordId: z.string().optional(),
  dnsDetail: z.string().optional(),
  status: z.enum(['draft', 'planned', 'provisioning', 'ready', 'failed', 'destroy_planned']),
  vmIds: z.array(z.string()),
  publicIp: z.string().optional(),
  privateIp: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  operations: z.array(infrastructureOperationSchema),
})

const applicationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  source: applicationSourceSchema,
  managedSourcePath: z.string().min(1),
  configuration: configurationSchema,
  health: z.enum(['healthy', 'degraded', 'failed', 'unknown', 'not_deployed']),
  activeVersionId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  versions: z.array(versionSchema),
  deployments: z.array(deploymentSchema),
  instances: z.array(instanceSchema),
  environments: z.array(applicationEnvironmentSchema).default([]),
})

const applicationFileSchema = z.object({
  schemaVersion: z.literal(2),
  application: applicationSchema,
})

const credentialProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['ssh', 'aws', 'azure', 'alicloud', 'name.com']),
  name: z.string().min(1),
  isDefault: z.boolean(),
  secretConfigured: z.boolean(),
  configuration: z.record(z.string(), z.string()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastTestAt: z.string().optional(),
  lastTestStatus: z.enum(['passed', 'failed']).optional(),
  lastTestDetail: z.string().optional(),
})

const settingsSchema = z.object({
  schemaVersion: z.literal(2),
  workspacePath: z.string().min(1),
  workspaceStatus: z.enum(['healthy', 'missing', 'unwritable', 'migrating']),
  credentialProfiles: z.array(credentialProfileSchema),
  /** Set once the legacy AppRunner import has run; prevents re-importing on every boot. */
  legacyAppRunnerMigrationCompletedAt: z.string().optional(),
})

export interface ApplicationWorkspaceOptions {
  persist?: boolean
  settingsPath?: string
  workspacePath?: string
}

function nowIso() {
  return new Date().toISOString()
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
}

function workspaceStatus(path: string): GroveSettings['workspaceStatus'] {
  if (!existsSync(path)) {
    return 'missing'
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return 'healthy'
  } catch {
    return 'unwritable'
  }
}

function defaultSettings(workspacePath?: string): GroveSettings {
  const path = resolve(workspacePath ?? projectStatePath('workspace'))
  return {
    schemaVersion: 2,
    workspacePath: path,
    workspaceStatus: workspaceStatus(path),
    credentialProfiles: [],
  }
}

function normalizeApplication(application: GroveApplication, appDir: string): GroveApplication {
  const instances = application.instances as ApplicationInstance[]
  const deployments = application.deployments as ApplicationDeployment[]
  const versions = application.versions as ApplicationVersion[]
  return {
    ...application,
    managedSourcePath: join(appDir, 'source'),
    versions,
    deployments,
    instances,
    environments: application.environments ?? [],
  }
}

function isDirectoryEmpty(path: string) {
  return !existsSync(path) || readdirSync(path).length === 0
}

export class ApplicationWorkspace {
  private readonly persist: boolean
  private readonly settingsPath: string
  private settingsState: GroveSettings
  private applicationsState: GroveApplication[] = []

  constructor(options: ApplicationWorkspaceOptions = {}) {
    this.persist = options.persist ?? true
    this.settingsPath = resolve(options.settingsPath ?? projectStatePath('settings.yaml'))
    this.settingsState = this.loadSettings(options.workspacePath)
    if (this.persist) {
      this.ensureWorkspace()
      this.applicationsState = this.scanApplications()
    }
  }

  settings() {
    const status = workspaceStatus(this.settingsState.workspacePath)
    this.settingsState = { ...this.settingsState, workspaceStatus: status }
    return structuredClone(this.settingsState)
  }

  listApplications() {
    return structuredClone(this.applicationsState)
  }

  /** Whether the one-shot legacy AppRunner import already ran for this workspace. */
  legacyAppRunnerMigrationCompleted() {
    return Boolean(this.settingsState.legacyAppRunnerMigrationCompletedAt)
  }

  markLegacyAppRunnerMigrationCompleted() {
    this.settingsState = { ...this.settingsState, legacyAppRunnerMigrationCompletedAt: nowIso() }
    this.persistSettings()
  }

  getApplication(applicationId: string) {
    const application = this.applicationsState.find((item) => item.id === applicationId)
    return application ? structuredClone(application) : undefined
  }

  createApplication(input: GroveApplicationInput) {
    const baseSlug = slugify(input.name)
    if (!baseSlug) {
      throw new Error('Application name must contain at least one letter or number.')
    }
    let slug = baseSlug
    let suffix = 2
    while (this.applicationsState.some((item) => item.slug === slug)) {
      slug = `${baseSlug}-${suffix}`
      suffix += 1
    }

    const timestamp = nowIso()
    const appDir = this.applicationDirectoryForSlug(slug)
    const application: GroveApplication = {
      id: uniqueId('app'),
      slug,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      source: input.source,
      managedSourcePath: join(appDir, 'source'),
      configuration: input.configuration,
      health: 'not_deployed',
      createdAt: timestamp,
      updatedAt: timestamp,
      versions: [],
      deployments: [],
      instances: [],
      environments: [],
    }

    if (this.persist) {
      mkdirSync(join(appDir, '.grove', 'versions'), { recursive: true })
      mkdirSync(application.managedSourcePath, { recursive: true })
      this.writeApplication(application)
    }
    this.applicationsState = [application, ...this.applicationsState]
    return structuredClone(application)
  }

  /**
   * Read-modify-write against the CURRENT record. Callers describe their changes as a function
   * of the freshly-read application instead of passing a whole-record snapshot, so an update
   * made while another operation was awaiting (e.g. a config PATCH during a deploy) is merged,
   * never silently overwritten. The method is synchronous, which makes the read-merge-write
   * sequence atomic with respect to any other updateApplication call.
   */
  updateApplication(applicationId: string, changes: (current: GroveApplication) => Partial<GroveApplication>) {
    const current = this.applicationsState.find((item) => item.id === applicationId)
    if (!current) {
      throw new Error('Application not found')
    }
    const merged = { ...current, ...changes(structuredClone(current)) }
    if (merged.slug !== current.slug) {
      throw new Error('Application slug cannot be changed.')
    }
    const next = applicationSchema.parse({ ...merged, updatedAt: nowIso() }) as GroveApplication
    if (this.persist) {
      this.writeApplication(next)
    }
    this.applicationsState = this.applicationsState.map((item) => (item.id === next.id ? next : item))
    return structuredClone(next)
  }

  removeApplicationMetadata(applicationId: string) {
    const application = this.applicationsState.find((item) => item.id === applicationId)
    if (!application) {
      return
    }
    if (this.persist) {
      rmSync(this.applicationDirectory(application), { recursive: true, force: true })
    }
    this.applicationsState = this.applicationsState.filter((item) => item.id !== applicationId)
  }

  applicationDirectory(application: Pick<GroveApplication, 'slug'>) {
    return this.applicationDirectoryForSlug(application.slug)
  }

  versionDirectory(application: Pick<GroveApplication, 'slug'>, versionId: string) {
    return join(this.applicationDirectory(application), '.grove', 'versions', versionId)
  }

  environmentDirectory(application: Pick<GroveApplication, 'slug'>, environmentId: string) {
    return join(this.applicationDirectory(application), '.grove', 'environments', environmentId)
  }

  relocateWorkspace(nextWorkspacePath: string) {
    const nextPath = resolve(nextWorkspacePath)
    const currentPath = resolve(this.settingsState.workspacePath)
    if (nextPath === currentPath) {
      return this.settings()
    }
    if (!this.persist) {
      this.settingsState = { ...this.settingsState, workspacePath: nextPath, workspaceStatus: 'healthy' }
      return this.settings()
    }
    if (!isDirectoryEmpty(nextPath)) {
      throw new Error('The new workspace folder must be empty.')
    }

    const parent = dirname(nextPath)
    mkdirSync(parent, { recursive: true })
    const stagingPath = join(parent, `.${basename(nextPath)}.grove-migration-${Date.now()}`)
    rmSync(stagingPath, { recursive: true, force: true })
    this.settingsState = { ...this.settingsState, workspaceStatus: 'migrating' }
    this.persistSettings()
    try {
      if (existsSync(currentPath)) {
        cpSync(currentPath, stagingPath, { recursive: true, errorOnExist: true })
      } else {
        mkdirSync(stagingPath, { recursive: true })
      }
      if (existsSync(nextPath)) {
        rmSync(nextPath, { recursive: false })
      }
      renameSync(stagingPath, nextPath)
      this.settingsState = { ...this.settingsState, workspacePath: nextPath, workspaceStatus: 'healthy' }
      this.persistSettings()
      this.applicationsState = this.scanApplications()
      return this.settings()
    } catch (error) {
      rmSync(stagingPath, { recursive: true, force: true })
      this.settingsState = { ...this.settingsState, workspaceStatus: workspaceStatus(currentPath) }
      this.persistSettings()
      throw error
    }
  }

  saveCredentialProfile(profile: CredentialProfile) {
    const parsed = credentialProfileSchema.parse(profile) as CredentialProfile
    let profiles = this.settingsState.credentialProfiles.filter((item) => item.id !== parsed.id)
    if (parsed.isDefault) {
      profiles = profiles.map((item) => (item.kind === parsed.kind ? { ...item, isDefault: false } : item))
    } else if (!profiles.some((item) => item.kind === parsed.kind && item.isDefault)) {
      parsed.isDefault = true
    }
    profiles.push(parsed)
    this.settingsState = { ...this.settingsState, credentialProfiles: profiles }
    this.persistSettings()
    return structuredClone(parsed)
  }

  removeCredentialProfile(profileId: string) {
    const profile = this.settingsState.credentialProfiles.find((item) => item.id === profileId)
    if (!profile) {
      return undefined
    }
    let profiles = this.settingsState.credentialProfiles.filter((item) => item.id !== profileId)
    if (profile.isDefault) {
      const replacement = profiles.find((item) => item.kind === profile.kind)
      if (replacement) {
        profiles = profiles.map((item) => (item.id === replacement.id ? { ...item, isDefault: true } : item))
      }
    }
    this.settingsState = { ...this.settingsState, credentialProfiles: profiles }
    this.persistSettings()
    return structuredClone(profile)
  }

  private loadSettings(workspacePath?: string) {
    if (!this.persist || !existsSync(this.settingsPath)) {
      const settings = defaultSettings(workspacePath)
      if (this.persist) {
        this.settingsState = settings
        this.persistSettings()
      }
      return settings
    }
    let parsed: GroveSettings
    try {
      parsed = settingsSchema.parse(parse(readFileSync(this.settingsPath, 'utf8'))) as GroveSettings
    } catch (error) {
      // A truncated/corrupt settings file must not kill startup: quarantine it and boot
      // with defaults (a fresh settings.yaml is written below by ensureWorkspace).
      const quarantined = quarantineCorruptFile(this.settingsPath)
      console.warn(
        `Grove: unreadable settings file moved to ${quarantined ?? this.settingsPath}; starting with defaults.`,
        error,
      )
      return defaultSettings(workspacePath)
    }
    return {
      ...parsed,
      workspacePath: resolve(workspacePath ?? parsed.workspacePath),
      workspaceStatus: workspaceStatus(resolve(workspacePath ?? parsed.workspacePath)),
    }
  }

  private ensureWorkspace() {
    mkdirSync(this.settingsState.workspacePath, { recursive: true })
    this.settingsState = { ...this.settingsState, workspaceStatus: workspaceStatus(this.settingsState.workspacePath) }
    this.persistSettings()
  }

  private persistSettings() {
    if (!this.persist) {
      return
    }
    const text = stringify(settingsSchema.parse(this.settingsState))
    atomicWriteFileSync(this.settingsPath, text)
  }

  private applicationDirectoryForSlug(slug: string) {
    return join(this.settingsState.workspacePath, slug)
  }

  private scanApplications() {
    if (!existsSync(this.settingsState.workspacePath)) {
      return []
    }
    return readdirSync(this.settingsState.workspacePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const appDir = join(this.settingsState.workspacePath, entry.name)
        const metadataPath = join(appDir, '.grove', 'application.yaml')
        if (!existsSync(metadataPath)) {
          return []
        }
        try {
          const parsed = applicationFileSchema.parse(parse(readFileSync(metadataPath, 'utf8')))
          return [normalizeApplication(parsed.application as GroveApplication, appDir)]
        } catch (error) {
          // One corrupt application.yaml must not kill the whole scan: quarantine it and
          // skip the application instead of throwing during startup.
          const quarantined = quarantineCorruptFile(metadataPath)
          console.warn(
            `Grove: invalid application metadata at ${metadataPath}; moved to ${quarantined ?? metadataPath} and skipped.`,
            error,
          )
          return []
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  private writeApplication(application: GroveApplication) {
    const metadataPath = join(this.applicationDirectory(application), '.grove', 'application.yaml')
    const payload = applicationFileSchema.parse({ schemaVersion: 2, application })
    atomicWriteFileSync(metadataPath, stringify(payload))
  }
}
