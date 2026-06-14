import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { envValue } from './env'
import { projectStatePath } from './projectState'

/**
 * Moonshot/Kimi provider configuration. Grove no longer calls the Moonshot API directly —
 * kimi-code CLI does — but Grove still owns the key so it can render provider status in
 * Settings and pass the model name through to the kimi drivers.
 */
export const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'
export const DEFAULT_MOONSHOT_MODEL = 'kimi-k2.6'

export interface MoonshotConfig {
  apiKey: string
  baseUrl: string
  model: string
}

function apiKeyFromEnv() {
  return envValue('GROVE_MOONSHOT_API_KEY') ?? process.env.MOONSHOT_API_KEY
}

export function moonshotConfigFromEnv(): MoonshotConfig | undefined {
  const apiKey = apiKeyFromEnv()
  if (!apiKey) {
    return undefined
  }

  return {
    apiKey,
    baseUrl: envValue('GROVE_MOONSHOT_BASE_URL') ?? DEFAULT_MOONSHOT_BASE_URL,
    model: envValue('GROVE_MOONSHOT_MODEL') ?? DEFAULT_MOONSHOT_MODEL,
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

/**
 * Write a Grove-local kimi config from the Moonshot env so kimi runs with the user's saved
 * key without an interactive `kimi login` and without touching their global ~/.kimi. Returns
 * the config path, or undefined when no key is configured.
 */
export function ensureKimiConfigFile(): string | undefined {
  const config = moonshotConfigFromEnv()
  if (!config) {
    return undefined
  }

  const dir = projectStatePath('runtime')
  mkdirSync(dir, { recursive: true })
  const path = projectStatePath('runtime', 'kimi-config.toml')
  const toml = [
    `default_model = "${GROVE_KIMI_MODEL_NAME}"`,
    'default_yolo = false',
    'telemetry = false',
    '',
    '[providers.grove-moonshot]',
    'type = "kimi"',
    `base_url = "${config.baseUrl}"`,
    `api_key = "${config.apiKey}"`,
    '',
    `[models.${GROVE_KIMI_MODEL_NAME}]`,
    'provider = "grove-moonshot"',
    `model = "${config.model}"`,
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
