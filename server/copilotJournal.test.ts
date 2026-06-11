import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionProposal, CopilotMessage, CopilotPlanState, CopilotToolCall } from '../src/types'
import { CopilotJournal } from './copilotJournal'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grove-journal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function message(id: string, partial: Partial<CopilotMessage> = {}): CopilotMessage {
  return { id, role: 'assistant', content: 'hi', timestamp: '00:00', scope: 'vm:vm-a', createdAt: 1, ...partial }
}

describe('CopilotJournal', () => {
  it('hydrates messages, tool calls, and proposals across instances', () => {
    const journal = new CopilotJournal(dir)
    journal.recordMessage('vm:vm-a', message('m1', { content: 'first' }))
    const toolCall: CopilotToolCall = {
      id: 't1',
      scope: 'vm:vm-a',
      title: 'run_command',
      kind: 'read',
      status: 'completed',
      createdAt: 2,
      updatedAt: 3,
    }
    journal.recordToolCall('vm:vm-a', toolCall)

    const reloaded = new CopilotJournal(dir).load()
    expect(reloaded.messages.map((item) => item.id)).toContain('m1')
    expect(reloaded.toolCalls[0]?.status).toBe('completed')
  })

  it('reconciles interrupted in-flight work on reload', () => {
    const journal = new CopilotJournal(dir)
    journal.recordMessage('vm:vm-a', message('m1', { streaming: true, content: '' }))
    journal.recordToolCall('vm:vm-a', {
      id: 't1',
      scope: 'vm:vm-a',
      title: 'run_command',
      kind: 'execute',
      status: 'running',
      createdAt: 2,
      updatedAt: 2,
    })
    const proposal: ActionProposal = {
      id: 'p1',
      vmId: 'vm-a',
      scope: 'vm:vm-a',
      title: 'Run',
      description: 'x',
      command: 'sudo systemctl restart nginx',
      actionType: 'custom_command',
      risk: 'medium',
      status: 'awaiting_confirmation',
      createdAt: 3,
    }
    journal.recordProposal('vm:vm-a', proposal)

    const reloaded = new CopilotJournal(dir).load()
    expect(reloaded.messages[0]?.streaming).toBe(false)
    expect(reloaded.toolCalls[0]?.status).toBe('failed')
    expect(reloaded.proposals[0]?.status).toBe('pending_confirmation')
  })

  it('hydrates plans with the latest entry state per id', () => {
    const journal = new CopilotJournal(dir)
    const plan: CopilotPlanState = {
      id: 'plan-1',
      scope: 'vm:vm-a',
      entries: [
        { title: 'Inspect disk', status: 'in_progress' },
        { title: 'Summarize', status: 'pending' },
      ],
      createdAt: 4,
      updatedAt: 4,
    }
    journal.recordPlan('vm:vm-a', plan)
    journal.recordPlan('vm:vm-a', {
      ...plan,
      entries: [
        { title: 'Inspect disk', status: 'completed' },
        { title: 'Summarize', status: 'in_progress' },
      ],
      updatedAt: 5,
    })

    const reloaded = new CopilotJournal(dir).load()
    expect(reloaded.plans).toHaveLength(1)
    expect(reloaded.plans[0]?.entries[0]?.status).toBe('completed')
    expect(reloaded.plans[0]?.entries[1]?.status).toBe('in_progress')
  })

  it('completes interrupted thought blocks instead of failing them', () => {
    const journal = new CopilotJournal(dir)
    journal.recordToolCall('vm:vm-a', {
      id: 'think-1',
      scope: 'vm:vm-a',
      title: 'Thinking',
      kind: 'think',
      origin: 'agent',
      status: 'running',
      output: 'partial reasoning',
      createdAt: 2,
      updatedAt: 2,
    })

    const reloaded = new CopilotJournal(dir).load()
    expect(reloaded.toolCalls[0]?.status).toBe('completed')
    expect(reloaded.toolCalls[0]?.output).toBe('partial reasoning')
  })

  it('keeps the latest record per id and filters history by query', () => {
    const journal = new CopilotJournal(dir)
    journal.recordMessage('vm:vm-a', message('m1', { content: 'check nginx logs' }))
    journal.recordMessage('vm:vm-a', message('m2', { role: 'user', content: 'restart postgres' }))

    expect(journal.history('vm:vm-a', { query: 'nginx' })).toHaveLength(1)
    expect(journal.history('vm:vm-a')).toHaveLength(2)
  })
})
