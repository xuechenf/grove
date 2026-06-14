import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KIMI_MAX_CONTEXT,
  DEFAULT_KIMI_MAX_STEPS,
  DEFAULT_KIMI_TOOL_TIMEOUT_MS,
  ensureKimiConfigFile,
  kimiMaxContextSize,
  kimiMaxStepsPerTurn,
  kimiToolCallTimeoutMs,
} from './copilotProvider'

const saved = {
  maxContext: process.env.GROVE_KIMI_MAX_CONTEXT,
  maxSteps: process.env.GROVE_KIMI_MAX_STEPS,
  toolTimeout: process.env.GROVE_KIMI_TOOL_TIMEOUT_MS,
  apiKey: process.env.GROVE_MOONSHOT_API_KEY,
  stateDir: process.env.GROVE_STATE_DIR,
}

afterEach(() => {
  for (const [key, value] of [
    ['GROVE_KIMI_MAX_CONTEXT', saved.maxContext],
    ['GROVE_KIMI_MAX_STEPS', saved.maxSteps],
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
  it('defaults to the full model window (cost is controlled elsewhere, not by shrinking context)', () => {
    delete process.env.GROVE_KIMI_MAX_CONTEXT
    expect(kimiMaxContextSize()).toBe(DEFAULT_KIMI_MAX_CONTEXT)
  })

  it('honors GROVE_KIMI_MAX_CONTEXT above the floor', () => {
    process.env.GROVE_KIMI_MAX_CONTEXT = '80000'
    expect(kimiMaxContextSize()).toBe(80000)
  })

  it('never drops below kimi\'s reserve, so it cannot trigger the constant-compaction loop', () => {
    process.env.GROVE_KIMI_MAX_CONTEXT = '999999'
    expect(kimiMaxContextSize()).toBe(131072)
    // The reserve is ~50k; anything at/below it would compact every step. The floor stays above.
    process.env.GROVE_KIMI_MAX_CONTEXT = '32768'
    expect(kimiMaxContextSize()).toBe(65536)
    expect(kimiMaxContextSize()).toBeGreaterThan(50000)
  })

  it('writes a context window and a step cap into the kimi config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grove-kimi-'))
    try {
      process.env.GROVE_STATE_DIR = dir
      process.env.GROVE_MOONSHOT_API_KEY = 'sk-test'
      process.env.GROVE_KIMI_MAX_CONTEXT = '80000'
      process.env.GROVE_KIMI_MAX_STEPS = '40'
      const toml = readFileSync(ensureKimiConfigFile()!, 'utf8')
      expect(toml).toContain('max_context_size = 80000')
      expect(toml).toContain('[loop_control]')
      expect(toml).toContain('max_steps_per_turn = 40')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('kimiMaxStepsPerTurn', () => {
  it('caps runaway agent loops far below kimi\'s 1000 default', () => {
    delete process.env.GROVE_KIMI_MAX_STEPS
    expect(kimiMaxStepsPerTurn()).toBe(DEFAULT_KIMI_MAX_STEPS)
    expect(DEFAULT_KIMI_MAX_STEPS).toBeLessThan(1000)
  })

  it('honors GROVE_KIMI_MAX_STEPS within [1, 1000]', () => {
    process.env.GROVE_KIMI_MAX_STEPS = '25'
    expect(kimiMaxStepsPerTurn()).toBe(25)
    process.env.GROVE_KIMI_MAX_STEPS = '999999'
    expect(kimiMaxStepsPerTurn()).toBe(1000)
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
