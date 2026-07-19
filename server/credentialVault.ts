import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { projectStatePath } from './projectState'

export interface CredentialVault {
  has(profileId: string): boolean
  get(profileId: string): Record<string, string> | undefined
  set(profileId: string, values: Record<string, string>): void
  delete(profileId: string): void
}

export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, Record<string, string>>()

  has(profileId: string) {
    return this.values.has(profileId)
  }

  get(profileId: string) {
    const value = this.values.get(profileId)
    return value ? structuredClone(value) : undefined
  }

  set(profileId: string, values: Record<string, string>) {
    this.values.set(profileId, structuredClone(values))
  }

  delete(profileId: string) {
    this.values.delete(profileId)
  }
}

interface EncryptedValue {
  iv: string
  authTag: string
  ciphertext: string
}

type EncryptedVaultFile = Record<string, EncryptedValue>

function restrictFile(path: string) {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows applies the user's profile ACL. POSIX systems also receive mode 0600.
  }
}

function atomicWrite(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
  restrictFile(temporaryPath)
  renameSync(temporaryPath, path)
  restrictFile(path)
}

/**
 * Encrypted fallback for CLI/dev mode. Packaged Electron injects its OS-backed vault instead.
 * The key and ciphertext are deliberately separate and permission-restricted; neither file is
 * placed in the user-selected application workspace or included in migration exports.
 */
export class EncryptedFileCredentialVault implements CredentialVault {
  private readonly keyPath: string
  private readonly vaultPath: string
  private readonly key: Buffer
  private values: EncryptedVaultFile

  constructor(options: { keyPath?: string; vaultPath?: string } = {}) {
    this.keyPath = options.keyPath ?? projectStatePath('credentials.key')
    this.vaultPath = options.vaultPath ?? projectStatePath('credentials.enc.json')
    this.key = this.loadOrCreateKey()
    this.values = this.loadVault()
  }

  has(profileId: string) {
    return Boolean(this.values[profileId])
  }

  get(profileId: string) {
    const value = this.values[profileId]
    if (!value) {
      return undefined
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext) as Record<string, string>
    } catch {
      throw new Error('Credential vault data could not be decrypted.')
    }
  }

  set(profileId: string, values: Record<string, string>) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plaintext = Buffer.from(JSON.stringify(values), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    this.values[profileId] = {
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
    this.persist()
  }

  delete(profileId: string) {
    if (!this.values[profileId]) {
      return
    }
    delete this.values[profileId]
    this.persist()
  }

  private loadOrCreateKey() {
    mkdirSync(dirname(this.keyPath), { recursive: true })
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath)
      if (key.length !== 32) {
        throw new Error('Credential vault key is invalid.')
      }
      restrictFile(this.keyPath)
      return key
    }
    const key = randomBytes(32)
    writeFileSync(this.keyPath, key, { mode: 0o600 })
    restrictFile(this.keyPath)
    return key
  }

  private loadVault(): EncryptedVaultFile {
    if (!existsSync(this.vaultPath)) {
      return {}
    }
    try {
      restrictFile(this.vaultPath)
      return JSON.parse(readFileSync(this.vaultPath, 'utf8')) as EncryptedVaultFile
    } catch {
      throw new Error('Credential vault file is invalid.')
    }
  }

  private persist() {
    atomicWrite(this.vaultPath, `${JSON.stringify(this.values, null, 2)}\n`)
  }
}

/** Stores OS-encrypted blobs while keeping the encryption implementation in Electron main. */
export class BlobCredentialVault implements CredentialVault {
  private readonly vaultPath: string
  private readonly encrypt: (plaintext: string) => Buffer
  private readonly decrypt: (ciphertext: Buffer) => string
  private values: Record<string, string>

  constructor(options: {
    vaultPath?: string
    encrypt: (plaintext: string) => Buffer
    decrypt: (ciphertext: Buffer) => string
  }) {
    this.vaultPath = options.vaultPath ?? projectStatePath('credentials.os-vault.json')
    this.encrypt = options.encrypt
    this.decrypt = options.decrypt
    this.values = existsSync(this.vaultPath)
      ? (JSON.parse(readFileSync(this.vaultPath, 'utf8')) as Record<string, string>)
      : {}
  }

  has(profileId: string) {
    return Boolean(this.values[profileId])
  }

  get(profileId: string) {
    const value = this.values[profileId]
    return value ? (JSON.parse(this.decrypt(Buffer.from(value, 'base64'))) as Record<string, string>) : undefined
  }

  set(profileId: string, values: Record<string, string>) {
    this.values[profileId] = this.encrypt(JSON.stringify(values)).toString('base64')
    atomicWrite(this.vaultPath, `${JSON.stringify(this.values, null, 2)}\n`)
  }

  delete(profileId: string) {
    if (!this.values[profileId]) return
    delete this.values[profileId]
    atomicWrite(this.vaultPath, `${JSON.stringify(this.values, null, 2)}\n`)
  }
}
