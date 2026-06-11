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
    'max_context_size = 131072',
    '',
  ].join('\n')
  writeFileSync(path, toml, 'utf8')
  return path
}

export function kimiConfigPath(): string | undefined {
  const path = projectStatePath('runtime', 'kimi-config.toml')
  return existsSync(path) ? path : undefined
}
