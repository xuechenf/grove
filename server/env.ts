import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { projectStatePath } from './projectState'

const managedMoonshotKeys = [
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

export function saveMoonshotLocalEnv(input: { apiKey: string; baseUrl: string; model: string }) {
  const path = localEnvPath()
  mkdirSync(dirname(path), { recursive: true })
  const existingLines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const preservedLines = existingLines.filter((line) => {
    const trimmed = line.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      return true
    }

    return !managedMoonshotKeys.includes(trimmed.slice(0, separator).trim())
  })
  const nextLines = [
    ...preservedLines.filter((line) => line.trim()),
    assignmentLine('GROVE_MOONSHOT_API_KEY', input.apiKey),
    assignmentLine('GROVE_MOONSHOT_BASE_URL', input.baseUrl),
    assignmentLine('GROVE_MOONSHOT_MODEL', input.model),
  ]

  writeFileSync(path, `${nextLines.join('\n')}\n`, 'utf8')
  process.env.GROVE_MOONSHOT_API_KEY = input.apiKey
  process.env.GROVE_MOONSHOT_BASE_URL = input.baseUrl
  process.env.GROVE_MOONSHOT_MODEL = input.model
}
