import { accessSync, constants, existsSync } from 'node:fs'
import type {
  AlicloudCredentialCsvImport,
  AwsCredentialCsvImport,
  CredentialProfile,
  CredentialProfileInput,
  CredentialProfileKind,
  CredentialProfileTestResult,
} from '../src/types'
import type { ApplicationWorkspace } from './applicationWorkspace'
import type { CredentialVault } from './credentialVault'
import { ProviderCredentialTester } from './providerCredentialTester'

const safeConfigurationKeys: Record<CredentialProfileKind, Set<string>> = {
  ssh: new Set(['keyPath', 'username', 'publicKeyPath']),
  aws: new Set(['accessKeyId', 'region', 'regions', 'accountId', 'arn']),
  azure: new Set(['tenantId', 'clientId', 'subscriptionId']),
  alicloud: new Set(['accessKeyId', 'region', 'accountId']),
  'name.com': new Set(['username', 'apiBaseUrl']),
}

const secretKeys: Record<CredentialProfileKind, Set<string>> = {
  ssh: new Set(['privateKey', 'passphrase']),
  aws: new Set(['secretAccessKey', 'sessionToken']),
  azure: new Set(['clientSecret']),
  alicloud: new Set(['accessKeySecret', 'securityToken']),
  'name.com': new Set(['apiToken']),
}

const requiredConfiguration: Record<CredentialProfileKind, string[]> = {
  ssh: [],
  aws: ['accessKeyId'],
  azure: ['tenantId', 'clientId', 'subscriptionId'],
  alicloud: ['accessKeyId'],
  'name.com': ['username'],
}

const requiredSecrets: Record<CredentialProfileKind, string[]> = {
  ssh: [],
  aws: ['secretAccessKey'],
  azure: ['clientSecret'],
  alicloud: ['accessKeySecret'],
  'name.com': ['apiToken'],
}

function nowIso() {
  return new Date().toISOString()
}

function uniqueId(kind: CredentialProfileKind) {
  const prefix = kind.replace('.', '-')
  return `credential-${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
}

function cleanRecord(values: Record<string, string> | undefined, allowed: Set<string>) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([key, value]) => allowed.has(key) && value.trim())
      .map(([key, value]) => [key, value.trim()]),
  )
}

function parseCsvRows(csvText: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]
    if (character === '"') {
      if (quoted && csvText[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(value.trim())
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && csvText[index + 1] === '\n') index += 1
      row.push(value.trim())
      value = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else {
      value += character
    }
  }
  row.push(value.trim())
  if (row.some(Boolean)) rows.push(row)
  if (quoted) throw new Error('Credential CSV contains an unterminated quoted value.')
  return rows
}

function normalizedCsvHeader(value: string) {
  return value.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function awsCsvValues(csvText: string) {
  const rows = parseCsvRows(csvText)
  if (rows.length < 2) throw new Error('AWS credential CSV must contain a header and one credential row.')
  const headers = rows[0].map(normalizedCsvHeader)
  const values = rows.find((row, index) => index > 0 && row.some(Boolean)) ?? []
  const valueFor = (...names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header))
    return index >= 0 ? values[index]?.trim() : undefined
  }
  const accessKeyId = valueFor('accesskeyid', 'awsaccesskeyid')
  const secretAccessKey = valueFor('secretaccesskey', 'awssecretaccesskey')
  const sessionToken = valueFor('sessiontoken', 'awssessiontoken')
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credential CSV must include Access key ID and Secret access key columns.')
  }
  return { accessKeyId, secretAccessKey, sessionToken }
}

function alicloudCsvValues(csvText: string) {
  const rows = parseCsvRows(csvText)
  if (rows.length < 2) throw new Error('Alibaba Cloud credential CSV must contain a header and one credential row.')
  const headers = rows[0].map(normalizedCsvHeader)
  const values = rows.find((row, index) => index > 0 && row.some(Boolean)) ?? []
  const valueFor = (...names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header))
    return index >= 0 ? values[index]?.trim() : undefined
  }
  const accessKeyId = valueFor('accesskeyid')
  const accessKeySecret = valueFor('accesskeysecret', 'secretaccesskey')
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('Alibaba Cloud credential CSV must include AccessKey ID and AccessKey Secret columns.')
  }
  return { accessKeyId, accessKeySecret }
}

export class CredentialManager {
  private readonly workspace: ApplicationWorkspace
  private readonly vault: CredentialVault
  private readonly onSettingsUpdated?: () => void
  private readonly providerTester: ProviderCredentialTester

  constructor(
    workspace: ApplicationWorkspace,
    vault: CredentialVault,
    onSettingsUpdated?: () => void,
    providerTester = new ProviderCredentialTester(),
  ) {
    this.workspace = workspace
    this.vault = vault
    this.onSettingsUpdated = onSettingsUpdated
    this.providerTester = providerTester
  }

  create(input: CredentialProfileInput) {
    const timestamp = nowIso()
    const profileId = uniqueId(input.kind)
    const configuration = cleanRecord(input.configuration, safeConfigurationKeys[input.kind])
    const secrets = cleanRecord(input.secrets, secretKeys[input.kind])
    this.assertConfiguration(input.kind, configuration)
    this.assertSecrets(input.kind, secrets, false)
    this.assertSshMaterial(input.kind, configuration, secrets)

    if (Object.keys(secrets).length) {
      this.vault.set(profileId, secrets)
    }
    const profile: CredentialProfile = {
      id: profileId,
      kind: input.kind,
      name: input.name.trim(),
      isDefault: input.isDefault ?? false,
      secretConfigured: this.hasRequiredSecrets(input.kind, secrets, configuration),
      configuration,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (!profile.name) {
      this.vault.delete(profileId)
      throw new Error('Credential profile name is required.')
    }
    const saved = this.workspace.saveCredentialProfile(profile)
    this.onSettingsUpdated?.()
    return saved
  }

  importAwsCsv(input: AwsCredentialCsvImport) {
    if (!input.csvText.trim()) throw new Error('Select a non-empty AWS credential CSV file.')
    const values = awsCsvValues(input.csvText)
    return this.create({
      kind: 'aws',
      name: input.name.trim() || 'AWS account',
      isDefault: input.isDefault ?? true,
      configuration: {
        accessKeyId: values.accessKeyId,
        region: input.region?.trim() || 'us-east-1',
      },
      secrets: {
        secretAccessKey: values.secretAccessKey,
        ...(values.sessionToken ? { sessionToken: values.sessionToken } : {}),
      },
    })
  }

  importAlicloudCsv(input: AlicloudCredentialCsvImport) {
    if (!input.csvText.trim()) throw new Error('Select a non-empty Alibaba Cloud credential CSV file.')
    const values = alicloudCsvValues(input.csvText)
    return this.create({
      kind: 'alicloud',
      name: input.name.trim() || 'Alibaba Cloud account',
      isDefault: input.isDefault ?? true,
      configuration: {
        accessKeyId: values.accessKeyId,
        region: input.region?.trim() || 'cn-beijing',
      },
      secrets: { accessKeySecret: values.accessKeySecret },
    })
  }

  update(profileId: string, input: CredentialProfileInput) {
    const current = this.find(profileId)
    if (current.kind !== input.kind) {
      throw new Error('Credential profile kind cannot be changed.')
    }
    const configuration = cleanRecord(input.configuration, safeConfigurationKeys[input.kind])
    const suppliedSecrets = cleanRecord(input.secrets, secretKeys[input.kind])
    const existingSecrets = this.vault.get(profileId) ?? {}
    const secrets = { ...existingSecrets, ...suppliedSecrets }
    this.assertConfiguration(input.kind, configuration)
    this.assertSecrets(input.kind, secrets, true)
    this.assertSshMaterial(input.kind, configuration, secrets)
    if (Object.keys(suppliedSecrets).length) {
      this.vault.set(profileId, secrets)
    }
    const profile: CredentialProfile = {
      ...current,
      name: input.name.trim(),
      isDefault: input.isDefault ?? current.isDefault,
      configuration,
      secretConfigured: this.hasRequiredSecrets(input.kind, secrets, configuration),
      updatedAt: nowIso(),
      lastTestAt: undefined,
      lastTestStatus: undefined,
      lastTestDetail: undefined,
    }
    if (!profile.name) {
      throw new Error('Credential profile name is required.')
    }
    const saved = this.workspace.saveCredentialProfile(profile)
    this.onSettingsUpdated?.()
    return saved
  }

  delete(profileId: string) {
    const removed = this.workspace.removeCredentialProfile(profileId)
    if (!removed) {
      throw new Error('Credential profile not found.')
    }
    this.vault.delete(profileId)
    this.onSettingsUpdated?.()
    return removed
  }

  async test(profileId: string): Promise<CredentialProfileTestResult> {
    const profile = this.find(profileId)
    const secrets = this.vault.get(profileId) ?? {}
    let status: 'passed' | 'failed' = 'passed'
    let detail: string
    let identity: Record<string, string> | undefined
    try {
      this.assertConfiguration(profile.kind, profile.configuration)
      this.assertSecrets(profile.kind, secrets, true)
      if (profile.kind === 'ssh') {
        const keyPath = profile.configuration.keyPath
        if (!keyPath && !secrets.privateKey) {
          throw new Error('Provide an SSH key path or private key.')
        }
        if (keyPath) {
          if (!existsSync(keyPath)) {
            throw new Error('SSH key file does not exist.')
          }
          accessSync(keyPath, constants.R_OK)
          detail = `SSH key is readable at ${keyPath}.`
        } else {
          detail = 'SSH private key is available in the credential vault.'
        }
      } else {
        const result = await this.providerTester.test({ profile, secrets })
        detail = result.detail
        identity = result.identity
      }
    } catch (error) {
      status = 'failed'
      detail = error instanceof Error ? error.message : 'Credential profile validation failed.'
    }

    const tested: CredentialProfile = {
      ...profile,
      configuration: { ...profile.configuration, ...(identity ?? {}) },
      secretConfigured: this.hasRequiredSecrets(profile.kind, secrets, profile.configuration),
      updatedAt: nowIso(),
      lastTestAt: nowIso(),
      lastTestStatus: status,
      lastTestDetail: detail,
    }
    const saved = this.workspace.saveCredentialProfile(tested)
    this.onSettingsUpdated?.()
    return { profile: saved, status, detail, identity }
  }

  secrets(profileId: string) {
    const profile = this.find(profileId)
    const values = this.vault.get(profileId)
    if (!values) {
      throw new Error(`${profile.name} has no stored secret values.`)
    }
    return structuredClone(values)
  }

  profile(profileId: string) {
    return structuredClone(this.find(profileId))
  }

  list() {
    return structuredClone(this.workspace.settings().credentialProfiles)
  }

  private find(profileId: string) {
    const profile = this.workspace.settings().credentialProfiles.find((item) => item.id === profileId)
    if (!profile) {
      throw new Error('Credential profile not found.')
    }
    return profile
  }

  private assertConfiguration(kind: CredentialProfileKind, configuration: Record<string, string>) {
    const missing = requiredConfiguration[kind].filter((key) => !configuration[key])
    if (missing.length) {
      throw new Error(`Missing ${kind} configuration: ${missing.join(', ')}.`)
    }
  }

  private assertSecrets(kind: CredentialProfileKind, secrets: Record<string, string>, existingAllowed: boolean) {
    const missing = requiredSecrets[kind].filter((key) => !secrets[key])
    if (missing.length && (existingAllowed || kind !== 'ssh')) {
      throw new Error(`Missing ${kind} secret: ${missing.join(', ')}.`)
    }
  }

  private hasRequiredSecrets(kind: CredentialProfileKind, secrets: Record<string, string>, configuration: Record<string, string>) {
    if (kind === 'ssh') {
      return Boolean(secrets.privateKey || configuration.keyPath)
    }
    return requiredSecrets[kind].every((key) => Boolean(secrets[key]))
  }

  private assertSshMaterial(kind: CredentialProfileKind, configuration: Record<string, string>, secrets: Record<string, string>) {
    if (kind === 'ssh' && !configuration.keyPath && !secrets.privateKey) {
      throw new Error('Provide an SSH key path or private key.')
    }
  }
}
