import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveCopilotProviderLocalEnv } from './env'

const savedStateDir = process.env.GROVE_STATE_DIR

afterEach(() => {
  if (savedStateDir === undefined) {
    delete process.env.GROVE_STATE_DIR
  } else {
    process.env.GROVE_STATE_DIR = savedStateDir
  }
})

describe('saveCopilotProviderLocalEnv', () => {
  it('writes the API key with owner-only file permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-env-'))
    try {
      process.env.GROVE_STATE_DIR = dir
      saveCopilotProviderLocalEnv({
        provider: 'moonshot',
        apiKey: 'sk-test-key',
        baseUrl: 'https://api.example',
        model: 'kimi-k3',
      })
      const path = join(dir, '.env.local')
      expect(readFileSync(path, 'utf8')).toContain('GROVE_COPILOT_API_KEY=sk-test-key')
      if (process.platform !== 'win32') {
        // Regression: the key file used to be written with default (0644) permissions.
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tightens permissions on a pre-existing .env.local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-env-'))
    try {
      process.env.GROVE_STATE_DIR = dir
      saveCopilotProviderLocalEnv({ provider: 'moonshot', apiKey: 'sk-first', baseUrl: 'https://a', model: 'm' })
      saveCopilotProviderLocalEnv({ provider: 'moonshot', apiKey: 'sk-second', baseUrl: 'https://a', model: 'm' })
      const path = join(dir, '.env.local')
      expect(readFileSync(path, 'utf8')).toContain('GROVE_COPILOT_API_KEY=sk-second')
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
