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

/** Default per-turn context budget. Generous for bounded stateless turns, far below the model max. */
export const DEFAULT_KIMI_MAX_CONTEXT = 32768
const KIMI_MODEL_CONTEXT_LIMIT = 131072

/**
 * Cap on how much context kimi sends per turn. With stateless turns the context is already
 * small; this is a safety net so one unusually large turn can't blow up to the 128K model max.
 * Override with GROVE_KIMI_MAX_CONTEXT; clamped to [4096, 131072].
 */
export function kimiMaxContextSize() {
  const raw = Math.trunc(Number(envValue('GROVE_KIMI_MAX_CONTEXT')))
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KIMI_MAX_CONTEXT
  return Math.min(KIMI_MODEL_CONTEXT_LIMIT, Math.max(4096, value))
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
  ].join('\n')
  writeFileSync(path, toml, 'utf8')
  return path
}

export function kimiConfigPath(): string | undefined {
  const path = projectStatePath('runtime', 'kimi-config.toml')
  return existsSync(path) ? path : undefined
}
