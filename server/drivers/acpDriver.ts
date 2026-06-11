import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CopilotRuntimeStatus, CopilotScope, CopilotToolCallKind, CopilotToolCallStatus } from '../../src/types'
import { AcpConnection } from '../acpClient'
import type { CopilotDriver, DriverUpdate, PromptRequest, PromptResult } from '../copilotTypes'

export interface AcpDriverOptions {
  binary?: string
  model?: string
}

interface ActivePrompt {
  scope: CopilotScope
  onUpdate: (update: DriverUpdate) => void
}

const ACP_PROTOCOL_VERSION = 1

/**
 * Primary driver: one long-lived `kimi acp` process serving many sessions (one per scope).
 * Gives streamed updates, cancellation, and a warm process with no per-turn startup cost.
 * Permission requests for the agent's tool calls are auto-approved here because Grove's MCP
 * tools themselves pause mutating commands for explicit confirmation.
 */
export class AcpDriver implements CopilotDriver {
  readonly name = 'acp' as const
  private readonly binary: string
  private readonly model?: string
  private child?: ChildProcessWithoutNullStreams
  private connection?: AcpConnection
  private initializing?: Promise<void>
  private readonly sessionByScope = new Map<CopilotScope, string>()
  private readonly scopeBySession = new Map<string, CopilotScope>()
  private readonly activeBySession = new Map<string, ActivePrompt>()
  private state: CopilotRuntimeStatus['state'] = 'starting'
  private detail = 'Starting kimi ACP server.'

  constructor(options: AcpDriverOptions = {}) {
    this.binary = options.binary ?? process.env.GROVE_KIMI_BIN ?? 'kimi'
    this.model = options.model
  }

  async start() {
    await this.ensureConnection()
  }

  private async ensureConnection(): Promise<void> {
    if (this.connection && !this.connection.isClosed()) {
      return
    }
    if (this.initializing) {
      return this.initializing
    }

    this.initializing = (async () => {
      this.state = 'starting'
      const child = spawn(this.binary, ['acp'], { env: process.env })
      this.child = child
      const connection = new AcpConnection(child)
      this.connection = connection
      this.sessionByScope.clear()
      this.scopeBySession.clear()

      connection.onNotification((method, params) => this.onNotification(method, params))
      connection.onRequest((method, params) => this.onRequest(method, params))
      child.on('exit', () => {
        this.state = 'error'
        this.detail = 'kimi ACP server exited.'
        this.connection = undefined
      })

      try {
        await connection.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        this.state = 'ready'
        this.detail = 'kimi ACP server ready.'
      } catch (error) {
        this.state = 'error'
        this.detail = error instanceof Error ? error.message : 'ACP initialize failed.'
        throw error
      }
    })()

    try {
      await this.initializing
    } finally {
      this.initializing = undefined
    }
  }

  private async ensureSession(request: PromptRequest): Promise<string> {
    await this.ensureConnection()
    const existing = this.sessionByScope.get(request.scope)
    if (existing) {
      return existing
    }

    const result = (await this.connection!.request('session/new', {
      cwd: request.cwd,
      mcpServers: [
        {
          name: request.mcp.name,
          command: request.mcp.command,
          args: request.mcp.args,
          env: Object.entries(request.mcp.env).map(([name, value]) => ({ name, value })),
        },
      ],
    })) as { sessionId?: string }

    const sessionId = result.sessionId
    if (!sessionId) {
      throw new Error('kimi ACP did not return a session id.')
    }
    this.sessionByScope.set(request.scope, sessionId)
    this.scopeBySession.set(sessionId, request.scope)
    return sessionId
  }

  async prompt(request: PromptRequest): Promise<PromptResult> {
    const sessionId = await this.ensureSession(request)
    this.activeBySession.set(sessionId, { scope: request.scope, onUpdate: request.onUpdate })
    let assembled = ''
    const collect = (update: DriverUpdate) => {
      if (update.type === 'message_delta') {
        assembled += update.text
      }
      request.onUpdate(update)
    }
    this.activeBySession.set(sessionId, { scope: request.scope, onUpdate: collect })

    try {
      const result = (await this.connection!.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: request.message }],
      })) as { stopReason?: string }
      return { text: assembled, stopReason: result.stopReason ?? 'end_turn' }
    } finally {
      this.activeBySession.delete(sessionId)
    }
  }

  cancel(scope: CopilotScope) {
    const sessionId = this.sessionByScope.get(scope)
    if (sessionId && this.connection) {
      this.connection.notify('session/cancel', { sessionId })
    }
  }

  async stop() {
    this.child?.kill()
    this.child = undefined
    this.connection = undefined
  }

  status(): CopilotRuntimeStatus {
    return { driver: 'acp', state: this.state, detail: this.detail, model: this.model }
  }

  private onNotification(method: string, params: unknown) {
    if (method !== 'session/update') {
      return
    }
    const payload = params as { sessionId?: string; update?: Record<string, unknown> }
    const sessionId = payload.sessionId
    const update = payload.update
    if (!sessionId || !update) {
      return
    }
    const active = this.activeBySession.get(sessionId)
    if (!active) {
      return
    }

    const driverUpdate = mapSessionUpdate(update)
    if (driverUpdate) {
      active.onUpdate(driverUpdate)
    }
  }

  private onRequest(method: string, params: unknown): unknown {
    if (method === 'session/request_permission') {
      const payload = params as { options?: Array<{ optionId?: string; kind?: string; name?: string }> }
      const options = payload.options ?? []
      const allow =
        options.find((option) => /allow|approve|yes|once/i.test(`${option.kind ?? ''} ${option.name ?? ''}`)) ??
        options[0]
      if (allow?.optionId) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    }

    // We advertise no fs/terminal capabilities; refuse anything else.
    throw new Error(`Unsupported ACP request: ${method}`)
  }
}

function mapSessionUpdate(update: Record<string, unknown>): DriverUpdate | undefined {
  const kind = String(update.sessionUpdate ?? '')

  if (kind === 'agent_message_chunk') {
    const text = contentText(update.content)
    return text ? { type: 'message_delta', text } : undefined
  }

  if (kind === 'agent_thought_chunk') {
    const text = contentText(update.content)
    return text ? { type: 'thought', text } : undefined
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return {
      type: 'tool_call',
      id: String(update.toolCallId ?? update.id ?? 'tool'),
      title: String(update.title ?? update.kind ?? 'tool'),
      kind: toToolKind(update.kind),
      status: toToolStatus(update.status),
      detail: contentText(update.rawInput) || undefined,
      output: contentText(update.content) || undefined,
    }
  }

  if (kind === 'plan') {
    const entries = Array.isArray(update.entries)
      ? update.entries.map((entry) => {
          const record = entry as Record<string, unknown>
          return { title: String(record.content ?? record.title ?? ''), status: String(record.status ?? 'pending') }
        })
      : []
    return { type: 'plan', entries }
  }

  return undefined
}

function contentText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item)).filter(Boolean).join('')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') {
      return record.text
    }
    if (record.content) {
      return contentText(record.content)
    }
  }
  return ''
}

function toToolStatus(value: unknown): CopilotToolCallStatus {
  const text = String(value ?? '')
  if (text === 'completed' || text === 'success') {
    return 'completed'
  }
  if (text === 'failed' || text === 'error') {
    return 'failed'
  }
  if (text === 'in_progress' || text === 'running') {
    return 'running'
  }
  return 'pending'
}

function toToolKind(value: unknown): CopilotToolCallKind {
  const text = String(value ?? '')
  if (text === 'read' || text === 'edit' || text === 'execute' || text === 'fetch' || text === 'think') {
    return text
  }
  return 'other'
}
