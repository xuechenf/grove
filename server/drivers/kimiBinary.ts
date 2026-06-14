import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { envValue } from '../env'

export const DEFAULT_KIMI_BINARY = 'kimi'

export interface KimiBinaryLookup {
  /** Explicit override (defaults to GROVE_KIMI_BIN). */
  env?: string
  platform?: NodeJS.Platform
  home?: string
  /** PATH string to scan (defaults to process.env.PATH). */
  pathEnv?: string
  /** Existence probe, injectable for tests. */
  exists?: (path: string) => boolean
}

function binaryNames(platform: NodeJS.Platform) {
  // `uv tool install kimi-cli` drops kimi.exe on Windows; npm-style shims may use .cmd.
  return platform === 'win32' ? ['kimi.exe', 'kimi.cmd', 'kimi'] : ['kimi']
}

/**
 * Well-known install dirs that are frequently NOT on the spawning process's PATH — most
 * notably `~/.local/bin`, where `uv tool install` places kimi. The Grove backend inherits
 * the GUI/launcher PATH, which often omits these, so `spawn('kimi')` fails with ENOENT even
 * though kimi is installed. Probing these lets the copilot work without manual setup.
 */
function commonInstallDirs(platform: NodeJS.Platform, home: string) {
  if (platform === 'win32') {
    return [join(home, '.local', 'bin')]
  }
  return [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
}

/**
 * Resolve the kimi executable. Precedence:
 * 1. GROVE_KIMI_BIN (explicit, wins outright).
 * 2. A bare `kimi` if it already resolves on PATH (let spawn find it).
 * 3. A full path in a well-known install dir (e.g. ~/.local/bin from `uv tool install`).
 * 4. Fall back to `kimi`, so a truly-missing binary still surfaces the actionable ENOENT.
 */
export function resolveKimiBinary(lookup: KimiBinaryLookup = {}): string {
  const configured = (lookup.env ?? envValue('GROVE_KIMI_BIN'))?.trim()
  if (configured) {
    return configured
  }

  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const home = lookup.home ?? homedir()
  const names = binaryNames(platform)

  const pathDirs = (lookup.pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of names) {
      if (exists(join(dir, name))) {
        return DEFAULT_KIMI_BINARY
      }
    }
  }

  for (const dir of commonInstallDirs(platform, home)) {
    for (const name of names) {
      const full = join(dir, name)
      if (exists(full)) {
        return full
      }
    }
  }

  return DEFAULT_KIMI_BINARY
}

export function kimiBinaryFromEnv() {
  return resolveKimiBinary()
}

/**
 * Environment for spawning kimi. kimi is a Python CLI; on Windows with a non-UTF-8 system
 * locale (e.g. GBK/cp936) its stdio defaults to that codec and it aborts the whole turn with
 * a UnicodeEncodeError the moment it prints an emoji ("🚨" and friends are common in status
 * output). Forcing UTF-8 stdio keeps those turns alive. Honors any value the user already set.
 */
export function kimiSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PYTHONUTF8: base.PYTHONUTF8 ?? '1',
    PYTHONIOENCODING: base.PYTHONIOENCODING ?? 'utf-8',
  }
}

export function formatKimiLaunchError(error: unknown, binary: string) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ENOENT' || /\bENOENT\b/.test(message)) {
    return [
      `Failed to launch kimi-code CLI: "${binary}" was not found.`,
      'Install it with `uv tool install kimi-cli`, then restart Grove so the backend sees the updated PATH.',
      'If kimi is installed somewhere else, set `GROVE_KIMI_BIN` to the full executable path in `.grove/.env.local` or your shell environment.',
    ].join(' ')
  }

  return `Failed to launch kimi-code CLI: ${message}`
}
