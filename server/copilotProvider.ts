import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { CopilotProvider } from '../src/types'
import { envValue } from './env'
import { projectStatePath } from './projectState'

/**
 * Copilot provider configuration. Grove no longer calls the model API directly — kimi-code CLI
 * does — but Grove still owns the key so it can render provider status in Settings and write a
 * project-local kimi config for non-interactive runs.
 */
export const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'
export const DEFAULT_MOONSHOT_MODEL = 'kimi-k3'
export const DEFAULT_GLM_CN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
export const DEFAULT_GLM_CN_MODEL = 'glm-5.2'

export interface CopilotProviderConfig {
  provider: CopilotProvider
  apiKey: string
  baseUrl: string
  model: string
}

const providerDefaults: Record<CopilotProvider, { baseUrl: string; model: string; kimiType: 'kimi' | 'openai' }> = {
  moonshot: {
    baseUrl: DEFAULT_MOONSHOT_BASE_URL,
    model: DEFAULT_MOONSHOT_MODEL,
    kimiType: 'kimi',
  },
  'glm-cn': {
    baseUrl: DEFAULT_GLM_CN_BASE_URL,
    model: DEFAULT_GLM_CN_MODEL,
    kimiType: 'openai',
  },
}

function normalizeProvider(value: string | undefined): CopilotProvider | undefined {
  return value === 'moonshot' || value === 'glm-cn' ? value : undefined
}

function providerFromEnv(): CopilotProvider {
  return normalizeProvider(envValue('GROVE_COPILOT_PROVIDER')) ?? 'moonshot'
}

function normalizeModel(provider: CopilotProvider, model: string) {
  // Moonshot's public API advertises K3 under the canonical `kimi-k3` id. Preserve
  // compatibility with Grove settings saved before that id was published.
  return provider === 'moonshot' && model.trim().toLowerCase() === 'k3' ? 'kimi-k3' : model
}

function apiKeyFromEnv(provider: CopilotProvider) {
  const generic = envValue('GROVE_COPILOT_API_KEY')
  if (generic) {
    return generic
  }

  if (provider === 'moonshot') {
    return envValue('GROVE_MOONSHOT_API_KEY') ?? process.env.MOONSHOT_API_KEY
  }

  return undefined
}

export function copilotProviderDefaults(provider: CopilotProvider) {
  const defaults = providerDefaults[provider]
  return {
    baseUrl: defaults.baseUrl,
    model: defaults.model,
  }
}

export function copilotProviderStatusFromEnv() {
  const provider = providerFromEnv()
  const legacyMoonshot = !envValue('GROVE_COPILOT_PROVIDER') && provider === 'moonshot'
  const defaults = providerDefaults[provider]
  const configuredModel =
    envValue('GROVE_COPILOT_MODEL') ??
    (legacyMoonshot ? envValue('GROVE_MOONSHOT_MODEL') : undefined) ??
    defaults.model
  return {
    provider,
    configured: Boolean(apiKeyFromEnv(provider)),
    baseUrl:
      envValue('GROVE_COPILOT_BASE_URL') ??
      (legacyMoonshot ? envValue('GROVE_MOONSHOT_BASE_URL') : undefined) ??
      defaults.baseUrl,
    model: normalizeModel(provider, configuredModel),
  }
}

export function copilotProviderConfigFromEnv(): CopilotProviderConfig | undefined {
  const status = copilotProviderStatusFromEnv()
  const apiKey = apiKeyFromEnv(status.provider)
  if (!apiKey) {
    return undefined
  }

  return {
    provider: status.provider,
    apiKey,
    baseUrl: status.baseUrl,
    model: status.model,
  }
}

export const GROVE_KIMI_MODEL_NAME = 'grove-kimi'

export const DEFAULT_KIMI_MAX_CONTEXT = 131072
const KIMI_MODEL_CONTEXT_LIMIT = 131072
// kimi reserves ~50k tokens for response generation and auto-compacts when
// `context_tokens + reserved_context_size >= max_context_size`. If max_context_size is at or
// below that reserve, compaction fires on the very first step — kimi wipes its own history,
// forgets the goal, and loops re-planning forever. So the window must stay comfortably above it.
const KIMI_CONTEXT_FLOOR = 65536

/**
 * kimi's model context window. This is NOT the cost lever — runaway/long sessions are bounded by
 * stateless turns (GROVE_KIMI_SESSION_TURNS) and a per-turn step cap (GROVE_KIMI_MAX_STEPS).
 * Shrinking this below kimi's ~50k reserve causes constant auto-compaction and an inspect loop,
 * so it defaults to the full model window. Override with GROVE_KIMI_MAX_CONTEXT; clamped to
 * [65536, 131072] to stay above the reserve.
 */
export function kimiMaxContextSize() {
  const raw = Math.trunc(Number(envValue('GROVE_KIMI_MAX_CONTEXT')))
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KIMI_MAX_CONTEXT
  return Math.min(KIMI_MODEL_CONTEXT_LIMIT, Math.max(KIMI_CONTEXT_FLOOR, value))
}

/**
 * Hard cap on agent steps (tool calls) in one turn — the real guard against a runaway loop
 * burning tokens. kimi's own default is 1000, far too high; a legitimate VM/fleet op needs only
 * a handful. Override with GROVE_KIMI_MAX_STEPS; clamped to [1, 1000].
 */
export const DEFAULT_KIMI_MAX_STEPS = 100

export function kimiMaxStepsPerTurn() {
  const raw = Math.trunc(Number(envValue('GROVE_KIMI_MAX_STEPS')))
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KIMI_MAX_STEPS
  return Math.min(1000, Math.max(1, value))
}

/**
 * How long kimi waits for one MCP tool call. kimi's own default is 60s, but Grove tools can
 * legitimately run for minutes — a gated fleet `apt upgrade` runs under a 600s SSH budget — so
 * at 60s kimi gives up and reports a false "timed out" while the command keeps running and
 * succeeds, leaving the UI contradicting itself. The backend always responds within its command
 * budget, so we let kimi wait that long (default 15 min) and report the real result.
 * Override with GROVE_KIMI_TOOL_TIMEOUT_MS; floored at kimi's own 60s default.
 */
export const DEFAULT_KIMI_TOOL_TIMEOUT_MS = 900000

export function kimiToolCallTimeoutMs() {
  const raw = Math.trunc(Number(envValue('GROVE_KIMI_TOOL_TIMEOUT_MS')))
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KIMI_TOOL_TIMEOUT_MS
  return Math.max(60000, value)
}

function tomlString(value: string) {
  return JSON.stringify(value)
}

/**
 * Write a Grove-local kimi config from the saved provider env so kimi runs with the user's key
 * without an interactive `kimi login` and without touching their global ~/.kimi. Returns the
 * config path, or undefined when no key is configured.
 */
export function ensureKimiConfigFile(): string | undefined {
  const config = copilotProviderConfigFromEnv()
  if (!config) {
    return undefined
  }

  const providerName = `grove-${config.provider}`
  const provider = providerDefaults[config.provider]
  const dir = projectStatePath('runtime')
  mkdirSync(dir, { recursive: true })
  const path = projectStatePath('runtime', 'kimi-config.toml')
  const toml = [
    `default_model = ${tomlString(GROVE_KIMI_MODEL_NAME)}`,
    'default_yolo = false',
    'telemetry = false',
    '',
    `[providers.${providerName}]`,
    `type = ${tomlString(provider.kimiType)}`,
    `base_url = ${tomlString(config.baseUrl)}`,
    `api_key = ${tomlString(config.apiKey)}`,
    '',
    `[models.${GROVE_KIMI_MODEL_NAME}]`,
    `provider = ${tomlString(providerName)}`,
    `model = ${tomlString(config.model)}`,
    `max_context_size = ${kimiMaxContextSize()}`,
    '',
    '[mcp.client]',
    `tool_call_timeout_ms = ${kimiToolCallTimeoutMs()}`,
    '',
    '[loop_control]',
    `max_steps_per_turn = ${kimiMaxStepsPerTurn()}`,
    '',
  ].join('\n')
  writeFileSync(path, toml, 'utf8')
  return path
}

export function kimiConfigPath(): string | undefined {
  const path = projectStatePath('runtime', 'kimi-config.toml')
  return existsSync(path) ? path : undefined
}
