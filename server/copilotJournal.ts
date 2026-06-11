import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionProposal, CopilotMessage, CopilotPlanState, CopilotScope, CopilotToolCall } from '../src/types'
import { projectStatePath } from './projectState'

/**
 * Append-only operation journal, one JSONL file per scope. This is the durable source of
 * truth for the copilot timeline: it survives backend restarts (in-memory chat does not),
 * feeds the Activity view, and backs the `get_history` tool.
 *
 * Records are upserted by id on load (last write wins), so a tool call that moves
 * pending -> running -> completed appends three records and resolves to the final state.
 */

type JournalRecord =
  | { kind: 'message'; scope: CopilotScope; at: number; data: CopilotMessage }
  | { kind: 'toolcall'; scope: CopilotScope; at: number; data: CopilotToolCall }
  | { kind: 'proposal'; scope: CopilotScope; at: number; data: ActionProposal }
  | { kind: 'plan'; scope: CopilotScope; at: number; data: CopilotPlanState }

export interface JournalState {
  messages: CopilotMessage[]
  toolCalls: CopilotToolCall[]
  proposals: ActionProposal[]
  plans: CopilotPlanState[]
}

function scopeFileName(scope: CopilotScope) {
  return `${scope.replace(/[^a-zA-Z0-9_-]/g, '-')}.jsonl`
}

export class CopilotJournal {
  private readonly dir: string
  private readonly enabled: boolean

  constructor(dir: string = projectStatePath('copilot', 'journal'), enabled = true) {
    this.dir = dir
    this.enabled = enabled
  }

  private ensureDir() {
    mkdirSync(this.dir, { recursive: true })
  }

  private append(record: JournalRecord) {
    if (!this.enabled) {
      return
    }
    this.ensureDir()
    appendFileSync(join(this.dir, scopeFileName(record.scope)), `${JSON.stringify(record)}\n`, 'utf8')
  }

  recordMessage(scope: CopilotScope, message: CopilotMessage) {
    this.append({ kind: 'message', scope, at: Date.now(), data: message })
  }

  recordToolCall(scope: CopilotScope, toolCall: CopilotToolCall) {
    this.append({ kind: 'toolcall', scope, at: Date.now(), data: toolCall })
  }

  recordProposal(scope: CopilotScope, proposal: ActionProposal) {
    this.append({ kind: 'proposal', scope, at: Date.now(), data: proposal })
  }

  recordPlan(scope: CopilotScope, plan: CopilotPlanState) {
    this.append({ kind: 'plan', scope, at: Date.now(), data: plan })
  }

  /** History entries for a scope, newest first, for the get_history tool. */
  history(scope: CopilotScope, options: { query?: string; limit?: number } = {}) {
    const records = this.readScope(scope)
    const query = options.query?.toLowerCase().trim()
    const limit = options.limit ?? 40
    const lines = records
      .map((record) => describeRecord(record))
      .filter((line): line is string => Boolean(line))
      .filter((line) => !query || line.toLowerCase().includes(query))
    return lines.slice(-limit).reverse()
  }

  private readScope(scope: CopilotScope): JournalRecord[] {
    const path = join(this.dir, scopeFileName(scope))
    if (!existsSync(path)) {
      return []
    }
    return parseRecords(readFileSync(path, 'utf8'))
  }

  /** Aggregate state across all scope files, with in-flight work reconciled. */
  load(): JournalState {
    if (!this.enabled || !existsSync(this.dir)) {
      return { messages: [], toolCalls: [], proposals: [], plans: [] }
    }

    const messages = new Map<string, CopilotMessage>()
    const toolCalls = new Map<string, CopilotToolCall>()
    const proposals = new Map<string, ActionProposal>()
    const plans = new Map<string, CopilotPlanState>()

    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.jsonl')) {
        continue
      }
      for (const record of parseRecords(readFileSync(join(this.dir, file), 'utf8'))) {
        if (record.kind === 'message') {
          messages.set(record.data.id, record.data)
        } else if (record.kind === 'toolcall') {
          toolCalls.set(record.data.id, record.data)
        } else if (record.kind === 'plan') {
          plans.set(record.data.id, record.data)
        } else {
          proposals.set(record.data.id, record.data)
        }
      }
    }

    return {
      messages: [...messages.values()].map(reconcileMessage).sort(byCreatedAt),
      toolCalls: [...toolCalls.values()].map(reconcileToolCall).sort(byCreatedAt),
      proposals: [...proposals.values()].map(reconcileProposal).sort(byCreatedAt),
      plans: [...plans.values()].sort(byCreatedAt),
    }
  }
}

function parseRecords(content: string): JournalRecord[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JournalRecord
      } catch {
        return undefined
      }
    })
    .filter((record): record is JournalRecord => Boolean(record))
}

function byCreatedAt(a: { createdAt?: number }, b: { createdAt?: number }) {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

/** A message left mid-stream when the backend died is finalized, not left "streaming". */
function reconcileMessage(message: CopilotMessage): CopilotMessage {
  if (!message.streaming) {
    return message
  }
  return {
    ...message,
    streaming: false,
    content: message.content || '_(interrupted before completion)_',
  }
}

/**
 * Tool calls that never reported a terminal status are marked failed on restart. A thought
 * block has no failure mode — an interrupted one is simply complete as far as it got.
 */
function reconcileToolCall(toolCall: CopilotToolCall): CopilotToolCall {
  if (toolCall.status === 'pending' || toolCall.status === 'running') {
    if (toolCall.kind === 'think') {
      return { ...toolCall, status: 'completed' }
    }
    return { ...toolCall, status: 'failed', output: toolCall.output ?? 'Interrupted by a backend restart.' }
  }
  return toolCall
}

/** Proposals awaiting a decision become re-runnable drafts rather than dangling forever. */
function reconcileProposal(proposal: ActionProposal): ActionProposal {
  if (proposal.status === 'awaiting_confirmation') {
    return { ...proposal, status: 'pending_confirmation', toolCallId: undefined }
  }
  return proposal
}

function describeRecord(record: JournalRecord): string | undefined {
  if (record.kind === 'message') {
    const who = record.data.role === 'user' ? 'You' : 'Copilot'
    return `[${record.data.timestamp}] ${who}: ${truncate(record.data.content, 240)}`
  }
  if (record.kind === 'toolcall' && record.data.status === 'completed') {
    return `[tool] ${record.data.title}${record.data.detail ? `: ${truncate(record.data.detail, 160)}` : ''}`
  }
  if (record.kind === 'proposal' && record.data.status === 'executed') {
    return `[action] ${record.data.title} -> ${truncate(record.data.result ?? 'executed', 160)}`
  }
  return undefined
}

function truncate(value: string, max: number) {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
