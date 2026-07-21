import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CopilotProvider } from '../src/types'
import { projectStatePath } from './projectState'

const managedCopilotKeys = [
  'GROVE_COPILOT_PROVIDER',
  'GROVE_COPILOT_API_KEY',
  'GROVE_COPILOT_BASE_URL',
  'GROVE_COPILOT_MODEL',
  'GROVE_MOONSHOT_API_KEY',
  'GROVE_MOONSHOT_BASE_URL',
  'GROVE_MOONSHOT_MODEL',
]

export function envValue(key: string) {
  return process.env[key]
}

export function envFlag(key: string) {
  return envValue(key) === 'true'
}

function unquote(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

export function loadLocalEnv() {
  const path = localEnvPath()
  if (!existsSync(path)) {
    return
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()
    const value = unquote(trimmed.slice(separator + 1))
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

export function localEnvPath() {
  return projectStatePath('.env.local')
}

function assignmentLine(key: string, value: string) {
  return `${key}=${value.replace(/\r?\n/g, '')}`
}

export function saveCopilotProviderLocalEnv(input: {
  provider: CopilotProvider
  apiKey: string
  baseUrl: string
  model: string
}) {
  const path = localEnvPath()
  mkdirSync(dirname(path), { recursive: true })
  const existingLines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const preservedLines = existingLines.filter((line) => {
    const trimmed = line.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      return true
    }

    return !managedCopilotKeys.includes(trimmed.slice(0, separator).trim())
  })
  const nextLines = [
    ...preservedLines.filter((line) => line.trim()),
    assignmentLine('GROVE_COPILOT_PROVIDER', input.provider),
    assignmentLine('GROVE_COPILOT_API_KEY', input.apiKey),
    assignmentLine('GROVE_COPILOT_BASE_URL', input.baseUrl),
    assignmentLine('GROVE_COPILOT_MODEL', input.model),
  ]

  // The file holds the copilot API key in plaintext: create it owner-only and enforce the
  // mode afterwards as well (mode only applies when the file is first created).
  writeFileSync(path, `${nextLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows applies the user profile ACL; chmod is best-effort hardening elsewhere.
  }
  process.env.GROVE_COPILOT_PROVIDER = input.provider
  process.env.GROVE_COPILOT_API_KEY = input.apiKey
  process.env.GROVE_COPILOT_BASE_URL = input.baseUrl
  process.env.GROVE_COPILOT_MODEL = input.model
  delete process.env.GROVE_MOONSHOT_API_KEY
  delete process.env.GROVE_MOONSHOT_BASE_URL
  delete process.env.GROVE_MOONSHOT_MODEL
}

export function saveMoonshotLocalEnv(input: { apiKey: string; baseUrl: string; model: string }) {
  saveCopilotProviderLocalEnv({ provider: 'moonshot', ...input })
}
