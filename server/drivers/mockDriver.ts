import type { CopilotRuntimeStatus, CopilotScope } from '../../src/types'
import type { CopilotDriver, DriverUpdate, PromptRequest, PromptResult } from '../copilotTypes'

export type MockStep =
  | { type: 'delay'; ms: number }
  | { type: 'update'; update: DriverUpdate }
  | { type: 'final'; text: string }

/**
 * A scripted driver for tests and offline UI development. CI has no kimi binary or login,
 * so the entire supervisor/store/UI flow is exercised through this. A scripter function
 * turns each prompt into a sequence of streamed updates plus a final message.
 */
export type MockScripter = (request: PromptRequest) => MockStep[]

/**
 * The default script walks the full update surface — thought, plan, tool-call lifecycle,
 * streamed text — so offline development renders the same timeline a real kimi turn does.
 */
const defaultScripter: MockScripter = (request) => [
  { type: 'update', update: { type: 'thought', text: `Considering "${request.message}" for scope ${request.scope}.` } },
  {
    type: 'update',
    update: {
      type: 'plan',
      entries: [
        { title: 'Inspect current state', status: 'in_progress' },
        { title: 'Summarize findings', status: 'pending' },
      ],
    },
  },
  { type: 'delay', ms: 30 },
  {
    type: 'update',
    update: { type: 'tool_call', id: 'mock-1', title: 'get_vm', kind: 'read', status: 'running', detail: '{}' },
  },
  { type: 'delay', ms: 30 },
  {
    type: 'update',
    update: {
      type: 'tool_call',
      id: 'mock-1',
      title: 'get_vm',
      kind: 'read',
      status: 'completed',
      detail: '{}',
      output: 'lifecycle: running\nhealth: ok',
    },
  },
  {
    type: 'update',
    update: {
      type: 'plan',
      entries: [
        { title: 'Inspect current state', status: 'completed' },
        { title: 'Summarize findings', status: 'in_progress' },
      ],
    },
  },
  { type: 'update', update: { type: 'message_delta', text: 'Mock copilot: ' } },
  { type: 'update', update: { type: 'message_delta', text: `received "${request.message}".` } },
  { type: 'final', text: `Mock copilot received: ${request.message}` },
]

export class MockDriver implements CopilotDriver {
  readonly name = 'mock' as const
  private readonly scripter: MockScripter
  private cancelled = new Set<CopilotScope>()

  constructor(scripter: MockScripter = defaultScripter) {
    this.scripter = scripter
  }

  async start() {
    // No process to start.
  }

  async prompt(request: PromptRequest): Promise<PromptResult> {
    this.cancelled.delete(request.scope)
    const steps = this.scripter(request)
    let finalText = ''

    for (const step of steps) {
      if (this.cancelled.has(request.scope)) {
        return { text: finalText || 'Cancelled.', stopReason: 'cancelled' }
      }
      if (step.type === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, step.ms))
      } else if (step.type === 'update') {
        request.onUpdate(step.update)
      } else {
        finalText = step.text
      }
    }

    return { text: finalText, stopReason: 'end_turn' }
  }

  cancel(scope: CopilotScope) {
    this.cancelled.add(scope)
  }

  async stop() {
    // No process to stop.
  }

  status(): CopilotRuntimeStatus {
    return { driver: 'mock', state: 'ready', detail: 'Scripted mock copilot driver.' }
  }
}
