import { afterEach, describe, expect, it, vi } from 'vitest'
import { vms } from '../src/data/fixtures'
import {
  CopilotAgent,
  type CopilotAgentInput,
  type CopilotToolRuntime,
  type ToolResult,
} from './copilotAgent'

function moonshotResponse(message: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

describe('CopilotAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forces a final no-tool answer after repeated tool calls reach the loop budget', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    let sshExecutionCount = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requestBodies.push(requestBody)

      if (requestBody.tool_choice === 'none') {
        return moonshotResponse({
          content: 'I checked uptime on orchid-build-01 and it is reachable. Evidence: uptime command completed.',
        })
      }

      return moonshotResponse({
        content: null,
        tool_calls: [
          {
            id: `tool-call-${requestBodies.length}`,
            type: 'function',
            function: {
              name: 'ssh_exec',
              arguments: JSON.stringify({
                command: 'uptime',
                reason: 'Check whether the selected VM is reachable.',
              }),
            },
          },
        ],
      })
    })

    const runtime: CopilotToolRuntime = {
      inspectSystem: async (): Promise<ToolResult> => ({ ok: true, summary: 'System inspected.' }),
      executeReadOnlySsh: async (): Promise<ToolResult> => {
        sshExecutionCount += 1
        return {
          ok: true,
          summary: 'Check whether the selected VM is reachable. Command completed.',
          data: { stdout: 'up 3 days' },
        }
      },
      listRemoteFiles: async (): Promise<ToolResult> => ({ ok: true, summary: 'Listed files.', data: [] }),
      createKnownProposal: (): ToolResult => ({ ok: true, summary: 'Created proposal.' }),
      createSshProposal: (): ToolResult => ({ ok: true, summary: 'Created SSH proposal.' }),
      planSftpTransfer: (): ToolResult => ({ ok: true, summary: 'Created SFTP proposal.' }),
    }
    const input: CopilotAgentInput = {
      vm: vms[0],
      vms,
      activeTab: 'overview',
      message: 'is this VM online?',
      transfers: [],
      history: [],
      runtime,
    }

    const agent = new CopilotAgent({
      apiKey: 'test-key',
      baseUrl: 'https://moonshot.test/v1',
      model: 'test-model',
    })
    const result = await agent.respond(input)

    expect(result.content).toContain('I checked uptime')
    expect(result.content).not.toContain('tool-iteration limit')
    expect(requestBodies).toHaveLength(6)
    expect(requestBodies[0].tool_choice).toBe('auto')
    expect(requestBodies[0].tools).toBeDefined()
    expect(requestBodies[5].tool_choice).toBe('none')
    expect(requestBodies[5].tools).toBeUndefined()
    expect(sshExecutionCount).toBe(1)
  })
})
