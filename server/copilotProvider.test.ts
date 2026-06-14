import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KIMI_MAX_CONTEXT,
  DEFAULT_KIMI_TOOL_TIMEOUT_MS,
  ensureKimiConfigFile,
  kimiMaxContextSize,
  kimiToolCallTimeoutMs,
} from './copilotProvider'

const saved = {
  maxContext: process.env.GROVE_KIMI_MAX_CONTEXT,
  toolTimeout: process.env.GROVE_KIMI_TOOL_TIMEOUT_MS,
  apiKey: process.env.GROVE_MOONSHOT_API_KEY,
  stateDir: process.env.GROVE_STATE_DIR,
}

afterEach(() => {
  for (const [key, value] of [
    ['GROVE_KIMI_MAX_CONTEXT', saved.maxContext],
    ['GROVE_KIMI_TOOL_TIMEOUT_MS', saved.toolTimeout],
    ['GROVE_MOONSHOT_API_KEY', saved.apiKey],
    ['GROVE_STATE_DIR', saved.stateDir],
  ] as const) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('kimiMaxContextSize', () => {
  it('defaults to a bounded budget far below the model max', () => {
    delete process.env.GROVE_KIMI_MAX_CONTEXT
    expect(kimiMaxContextSize()).toBe(DEFAULT_KIMI_MAX_CONTEXT)
  })

  it('honors GROVE_KIMI_MAX_CONTEXT', () => {
    process.env.GROVE_KIMI_MAX_CONTEXT = '40000'
    expect(kimiMaxContextSize()).toBe(40000)
  })

  it('clamps to the model context limit and a sane floor', () => {
    process.env.GROVE_KIMI_MAX_CONTEXT = '999999'
    expect(kimiMaxContextSize()).toBe(131072)
    process.env.GROVE_KIMI_MAX_CONTEXT = '100'
    expect(kimiMaxContextSize()).toBe(4096)
  })

  it('writes the configured cap into the kimi config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-kimi-'))
    try {
      process.env.GROVE_STATE_DIR = dir
      process.env.GROVE_MOONSHOT_API_KEY = 'sk-test'
      process.env.GROVE_KIMI_MAX_CONTEXT = '40000'
      const path = ensureKimiConfigFile()
      expect(path).toBeDefined()
      expect(readFileSync(path!, 'utf8')).toContain('max_context_size = 40000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('kimiToolCallTimeoutMs', () => {
  it('defaults well above the backend command budget so long tools are not falsely timed out', () => {
    delete process.env.GROVE_KIMI_TOOL_TIMEOUT_MS
    expect(kimiToolCallTimeoutMs()).toBe(DEFAULT_KIMI_TOOL_TIMEOUT_MS)
    expect(DEFAULT_KIMI_TOOL_TIMEOUT_MS).toBeGreaterThan(600000) // > the 600s SSH mutating budget
  })

  it('honors GROVE_KIMI_TOOL_TIMEOUT_MS and never drops below kimi\'s own 60s default', () => {
    process.env.GROVE_KIMI_TOOL_TIMEOUT_MS = '300000'
    expect(kimiToolCallTimeoutMs()).toBe(300000)
    process.env.GROVE_KIMI_TOOL_TIMEOUT_MS = '1000'
    expect(kimiToolCallTimeoutMs()).toBe(60000)
  })

  it('writes the MCP client tool-call timeout into the kimi config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-kimi-'))
    try {
      process.env.GROVE_STATE_DIR = dir
      process.env.GROVE_MOONSHOT_API_KEY = 'sk-test'
      process.env.GROVE_KIMI_TOOL_TIMEOUT_MS = '720000'
      const toml = readFileSync(ensureKimiConfigFile()!, 'utf8')
      expect(toml).toContain('[mcp.client]')
      expect(toml).toContain('tool_call_timeout_ms = 720000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
