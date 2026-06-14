import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import type { CopilotRuntimeStatus, CopilotScope } from '../../src/types'
import type { CopilotDriver, DriverUpdate, PromptRequest, PromptResult } from '../copilotTypes'
import { envValue } from '../env'
import { formatKimiLaunchError, isKimiInstalled, kimiBinaryFromEnv, kimiSpawnEnv } from './kimiBinary'

export interface PrintDriverOptions {
  binary?: string
  model?: string
  configFile?: string
  /** Resolve the kimi `--session` id for a scope's Nth turn; return undefined to run stateless. */
  sessionId?: (scope: CopilotScope, turn: number) => string | undefined
  /** Turns to keep in one kimi session before rotating (defaults to GROVE_KIMI_SESSION_TURNS, or 1). */
  sessionTurns?: number
  /** Process spawner, injectable so tests can capture the kimi argv. */
  spawn?: typeof spawn
}

/**
 * How many turns share one kimi session before it rotates. kimi resumes a persistent session
 * per id and re-sends its whole history each turn, so a long-lived session grows input tokens
 * unboundedly (≈ O(N²) over a conversation). `1` (the default) keeps every turn stateless and
 * bounded; cross-turn context comes from Grove's journal/notes and the "Reference history"
 * toggle, not kimi's session. Set GROVE_KIMI_SESSION_TURNS>1 for a short rolling window.
 */
function sessionTurnsFromEnv() {
  return Math.max(1, Math.trunc(Number(envValue('GROVE_KIMI_SESSION_TURNS'))) || 1)
}

/**
 * Fallback driver: runs `kimi --print --output-format stream-json` once per turn. Simpler
 * and more robust than ACP on awkward stdio platforms, at the cost of per-turn process
 * startup. `--yolo` auto-approves kimi's *built-in* tools; Grove's own mutating commands
 * are still gated by the MCP layer's confirmation proposals, identical to the ACP path.
 */
export class PrintDriver implements CopilotDriver {
  readonly name = 'print' as const
  /** Explicit override (tests); when unset the binary is re-resolved per turn so an in-app
   * install lands without a restart (the new kimi appears in ~/.local/bin, off the GUI PATH). */
  private readonly binaryOverride?: string
  private readonly model?: string
  private readonly configFile?: string
  private readonly sessionId: (scope: CopilotScope, turn: number) => string | undefined
  private readonly sessionTurns: number
  private readonly turnsByScope = new Map<CopilotScope, number>()
  private readonly spawnProcess: typeof spawn
  private readonly active = new Map<CopilotScope, ReturnType<typeof spawn>>()
  private lastError?: string

  constructor(options: PrintDriverOptions = {}) {
    this.binaryOverride = options.binary
    this.model = options.model
    this.configFile = options.configFile
    this.spawnProcess = options.spawn ?? spawn
    this.sessionTurns = options.sessionTurns ?? sessionTurnsFromEnv()
    // Default: stateless when sessionTurns<=1 (no --session, fresh one-shot each turn), else a
    // session id that rotates every `sessionTurns` turns. The `-ui1` suffix namespaces it to the
    // current operator-brief guidance so older sessions never re-entrench stale output formats.
    this.sessionId =
      options.sessionId ??
      ((scope, turn) => {
        if (this.sessionTurns <= 1) {
          return undefined
        }
        const epoch = Math.floor((turn - 1) / this.sessionTurns)
        return `grove-${scope.replace(/[^a-zA-Z0-9_-]/g, '-')}-ui1-e${epoch}`
      })
  }

  async start() {
    // Nothing persistent to start; each prompt spawns its own process.
  }

  private resolveBinary() {
    return this.binaryOverride ?? kimiBinaryFromEnv()
  }

  prompt(request: PromptRequest): Promise<PromptResult> {
    const turn = (this.turnsByScope.get(request.scope) ?? 0) + 1
    this.turnsByScope.set(request.scope, turn)
    const sessionId = this.sessionId(request.scope, turn)

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--yolo',
      '--work-dir',
      request.cwd,
      '--mcp-config-file',
      request.mcp.configPath,
    ]
    // Stateless turns omit --session so kimi runs a fresh one-shot and never re-sends history.
    if (sessionId) {
      args.push('--session', sessionId)
    }
    if (this.configFile) {
      args.push('--config-file', this.configFile)
    }
    if (this.model) {
      args.push('--model', this.model)
    }
    args.push('--prompt', request.message)

    const binary = this.resolveBinary()
    const child = this.spawnProcess(binary, args, { cwd: request.cwd, env: kimiSpawnEnv() })
    this.active.set(request.scope, child)

    let finalText = ''
    let deltaText = ''
    let launchFailed = false
    const stderrChunks: string[] = []

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => {
      const event = parseStreamLine(line)
      if (!event) {
        return
      }
      if (event.final) {
        finalText = event.text ?? finalText
      } else if (event.update) {
        if (event.update.type === 'message_delta') {
          deltaText += event.update.text
        }
        request.onUpdate(event.update)
      }
    })
    const stderrDecoder = new StringDecoder('utf8')
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(stderrDecoder.write(chunk)))

    return new Promise<PromptResult>((resolve) => {
      child.on('error', (error) => {
        launchFailed = true
        this.lastError = formatKimiLaunchError(error, binary)
        this.active.delete(request.scope)
        resolve({ text: this.lastError, stopReason: 'error' })
      })
      child.on('close', (code) => {
        this.active.delete(request.scope)
        if (launchFailed) {
          return
        }
        const text = finalText || deltaText
        if (!text && code !== 0) {
          const detail = stderrChunks.join('').trim().slice(0, 500)
          this.lastError = detail || `kimi exited with code ${code}`
          resolve({ text: `kimi exited with code ${code}. ${detail}`.trim(), stopReason: 'error' })
          return
        }
        this.lastError = undefined
        resolve({ text: text || 'No response produced.', stopReason: code === 0 ? 'end_turn' : 'error' })
      })
    })
  }

  cancel(scope: CopilotScope) {
    const child = this.active.get(scope)
    child?.kill()
    this.active.delete(scope)
  }

  async stop() {
    for (const child of this.active.values()) {
      child.kill()
    }
    this.active.clear()
  }

  status(): CopilotRuntimeStatus {
    const installed = this.binaryOverride ? isKimiInstalled({ env: this.binaryOverride }) : isKimiInstalled()
    return {
      driver: 'print',
      state: this.lastError ? 'error' : 'ready',
      detail: this.lastError ?? `kimi print-mode driver (per-turn). Binary: ${this.resolveBinary()}`,
      model: this.model,
      kimiInstalled: installed,
    }
  }
}

/**
 * Lenient kimi stream-json parser. The exact schema varies across kimi versions, so we
 * extract assistant text and tool-call signals from whatever recognizable shape appears
 * rather than binding to one rigid format.
 */
export function parseStreamLine(line: string): { update?: DriverUpdate; final?: boolean; text?: string } | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') {
    return undefined
  }
  let event: Record<string, unknown>
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }

  const type = String(event.type ?? event.event ?? '')
  const subtype = String(event.subtype ?? '')

  // Tool call signals.
  if (type.includes('tool')) {
    const name = String((event.name as string) ?? (event.tool as string) ?? 'tool')
    const status = type.includes('result') || subtype.includes('result') ? 'completed' : 'running'
    return {
      update: {
        type: 'tool_call',
        id: String((event.id as string) ?? (event.tool_call_id as string) ?? name),
        title: name,
        kind: 'execute',
        status,
        detail: extractText(event.input ?? event.arguments),
        output: status === 'completed' ? extractText(event.output ?? event.result) : undefined,
      },
    }
  }

  // Final result line.
  if (type === 'result' || type === 'final' || subtype === 'final' || event.is_final === true) {
    const text = extractText(event.result ?? event.text ?? event.content ?? event.message)
    return { final: true, text }
  }

  // Assistant text chunk.
  const text = extractAssistantText(event)
  if (text) {
    return { update: { type: 'message_delta', text } }
  }

  return undefined
}

function extractAssistantText(event: Record<string, unknown>): string | undefined {
  const role = String(event.role ?? '')
  if (role && role !== 'assistant') {
    return undefined
  }
  const candidate = event.delta ?? event.text ?? event.content ?? event.message
  const text = extractText(candidate)
  return text || undefined
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item)).filter(Boolean).join('')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') {
      return record.text
    }
    if (typeof record.content === 'string') {
      return record.content
    }
    if (Array.isArray(record.content)) {
      return extractText(record.content)
    }
  }
  return ''
}
