import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { findKimiBinary } from './drivers/kimiBinary'

/**
 * In-app installer for the kimi-code CLI. Grove's copilot brain is the `kimi` CLI, distributed
 * as the PyPI package `kimi-cli` and installed with Astral's `uv` (the method the missing-binary
 * guidance already points at). When kimi is absent the copilot panel offers a one-click install
 * that runs here:
 *
 *   1. Find `uv`; if missing, run Astral's official installer from https://astral.sh.
 *   2. `uv tool install --force kimi-cli` (uv fetches its own Python if needed — no prerequisites).
 *   3. Re-detect the `kimi` binary (it lands in ~/.local/bin, which Grove already probes).
 *
 * Only the two documented, pinned upstream sources are touched (astral.sh for uv, PyPI for
 * kimi-cli); no user input is interpolated into any command. It runs only on explicit user action.
 */

export type InstallLog = (line: string) => void

export interface InstallDeps {
  platform?: NodeJS.Platform
  home?: string
  /** Run a command, streaming combined stdout/stderr to onLog; resolves with the exit code. */
  run?: (command: string, args: string[], onLog: InstallLog) => Promise<number>
  /** Locate the `uv` executable (injectable for tests). */
  findUv?: () => string | undefined
  /** Locate the installed `kimi` executable (injectable for tests). */
  findKimi?: () => string | undefined
}

export interface InstallResult {
  ok: boolean
  binary?: string
  error?: string
}

/** uv's install locations, plus the usual dirs the spawning process's PATH often omits. */
function uvSearchDirs(platform: NodeJS.Platform, home: string) {
  if (platform === 'win32') {
    return [join(home, '.local', 'bin')]
  }
  return [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
}

function uvNames(platform: NodeJS.Platform) {
  // Astral's installer ships uv as a native exe (never a .cmd shim), and we spawn the resolved
  // path without a shell — which can't launch .cmd/.bat — so only probe for the real executable.
  return platform === 'win32' ? ['uv.exe', 'uv'] : ['uv']
}

function findExecutable(names: string[], dirs: string[], pathEnv = process.env.PATH ?? ''): string | undefined {
  const all = [...pathEnv.split(delimiter).filter(Boolean), ...dirs]
  for (const dir of all) {
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) {
        return full
      }
    }
  }
  return undefined
}

/** Env for install subprocesses: prepend uv's bin dirs so a just-bootstrapped uv is reachable. */
function installEnv(platform: NodeJS.Platform, home: string): NodeJS.ProcessEnv {
  const extra = uvSearchDirs(platform, home)
  const current = process.env.PATH ?? ''
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...extra, current].filter(Boolean).join(delimiter) }
  // Least privilege: the remote installer shell and uv don't need Grove's secrets. kimi receives
  // the Moonshot key via its generated config file, never the environment, so strip it here.
  delete env.GROVE_MOONSHOT_API_KEY
  delete env.MOONSHOT_API_KEY
  // Force UTF-8 stdio so non-ASCII install output (errors, progress glyphs) doesn't render as
  // mojibake in the streamed log on non-UTF-8 Windows locales (cp936/GBK), matching kimiSpawnEnv.
  env.PYTHONUTF8 = env.PYTHONUTF8 ?? '1'
  env.PYTHONIOENCODING = env.PYTHONIOENCODING ?? 'utf-8'
  return env
}

function defaultRun(platform: NodeJS.Platform, home: string) {
  return (command: string, args: string[], onLog: InstallLog) =>
    new Promise<number>((resolve) => {
      let child
      try {
        child = spawn(command, args, { env: installEnv(platform, home) })
      } catch (error) {
        onLog(`Failed to launch ${command}: ${error instanceof Error ? error.message : String(error)}`)
        resolve(-1)
        return
      }
      createInterface({ input: child.stdout }).on('line', (line) => onLog(line))
      createInterface({ input: child.stderr }).on('line', (line) => onLog(line))
      child.on('error', (error) => {
        onLog(`Failed to launch ${command}: ${error.message}`)
        resolve(-1)
      })
      child.on('close', (code) => resolve(code ?? -1))
    })
}

/** Run Astral's official uv installer. Windows uses the PowerShell script; macOS/Linux use sh. */
function bootstrapUv(platform: NodeJS.Platform, run: NonNullable<InstallDeps['run']>, onLog: InstallLog) {
  if (platform === 'win32') {
    return run(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        // Force UTF-8 console output so the streamed log isn't mojibake on non-UTF-8 locales.
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; irm https://astral.sh/uv/install.ps1 | iex',
      ],
      onLog,
    )
  }
  // macOS ships curl; the script is the documented Unix install path. Download to a file first so
  // a curl failure (404/TLS/proxy) aborts under `set -e` instead of being swallowed by the pipe
  // (a pipeline's exit status is the trailing `sh`, which would read empty input and exit 0).
  const script = '${TMPDIR:-/tmp}/grove-uv-install.sh'
  return run(
    'sh',
    ['-c', `set -e; curl -LsSf https://astral.sh/uv/install.sh -o "${script}"; sh "${script}"`],
    onLog,
  )
}

export async function installKimiCli(onLog: InstallLog, deps: InstallDeps = {}): Promise<InstallResult> {
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? homedir()
  const run = deps.run ?? defaultRun(platform, home)
  const findUv = deps.findUv ?? (() => findExecutable(uvNames(platform), uvSearchDirs(platform, home)))
  const findKimi = deps.findKimi ?? (() => findKimiBinary())

  let uv = findUv()
  if (uv) {
    onLog(`Found uv: ${uv}`)
  } else {
    onLog('uv was not found. Installing uv from https://astral.sh …')
    const code = await bootstrapUv(platform, run, onLog)
    if (code !== 0) {
      return { ok: false, error: `Installing uv failed (exit ${code}). See the log for details.` }
    }
    uv = findUv()
    if (!uv) {
      return { ok: false, error: 'The uv installer finished but uv was not found afterward (the download may have failed — see the log).' }
    }
    onLog(`Installed uv: ${uv}`)
  }

  onLog('Installing kimi-cli with `uv tool install --force kimi-cli` …')
  const code = await run(uv, ['tool', 'install', '--force', 'kimi-cli'], onLog)
  if (code !== 0) {
    return { ok: false, error: `\`uv tool install kimi-cli\` failed (exit ${code}). See the log for details.` }
  }

  const binary = findKimi()
  if (!binary) {
    return { ok: false, error: 'kimi-cli installed but the kimi executable was not found on PATH or in ~/.local/bin.' }
  }
  onLog(`kimi-code CLI is ready: ${binary}`)
  return { ok: true, binary }
}
