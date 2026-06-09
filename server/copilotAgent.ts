import type {
  ActionProposal,
  CommandRun,
  CopilotMessage,
  CopilotProgressEvent,
  FileNode,
  TabId,
  TransferJob,
  VM,
} from '../src/types'
import { classifyCommand } from './commandProfiles'
import { envValue } from './env'

export const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'
export const DEFAULT_MOONSHOT_MODEL = 'kimi-k2.6'
const MAX_TOOL_LOOPS = 5

export type SystemInspectionCheck = 'shadowsocks_running' | 'shadowsocks_installed'

export const SHADOWSOCKS_RUNNING_DIAGNOSTIC_COMMAND = [
  'printf "__GROVE_SHADOWSOCKS_DIAGNOSTIC__\\n"',
  'printf "services:\\n"',
  "systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -Ei 'shadowsocks|ssserver|ss-local|ss-redir|ss-manager' || true",
  'printf "processes:\\n"',
  "ps -eo pid,user,comm,args 2>/dev/null | grep -Ei '[s]hadowsocks|[s]sserver|[s]s-local|[s]s-redir|[s]s-manager' | grep -Ev '__GROVE_SHADOWSOCKS_DIAGNOSTIC__|grep -Ei|grep -Ev' || true",
  'printf "listeners:\\n"',
  "ss -lntup 2>/dev/null | grep -Ei 'shadowsocks|ssserver|8388|1080' || true",
].join('\n')

export const SHADOWSOCKS_INSTALLED_DIAGNOSTIC_COMMAND = [
  'printf "__GROVE_SHADOWSOCKS_INSTALLED_DIAGNOSTIC__\\n"',
  'printf "binaries:\\n"',
  'for bin in ssserver ss-server ss-local sslocal ss-redir ss-manager shadowsocks-server shadowsocks; do found="$(command -v "$bin" 2>/dev/null || true)"; [ -n "$found" ] && printf "%s=%s\\n" "$bin" "$found"; done',
  'printf "packages:\\n"',
  "dpkg-query -W -f='${binary:Package} ${Version}\\n' '*shadowsocks*' 2>/dev/null | grep -Ei 'shadowsocks|ssserver|ss-local|ss-redir|ss-manager' || true",
  "rpm -qa 2>/dev/null | grep -Ei 'shadowsocks|ssserver|ss-local|ss-redir|ss-manager' || true",
  'printf "python-packages:\\n"',
  "python3 -m pip show shadowsocks 2>/dev/null | awk -F': ' '/^(Name|Version|Location):/ {print $0}' || true",
  "pip3 show shadowsocks 2>/dev/null | awk -F': ' '/^(Name|Version|Location):/ {print $0}' || true",
  'printf "unit-files:\\n"',
  "systemctl list-unit-files --no-pager 2>/dev/null | grep -Ei 'shadowsocks|ssserver|ss-local|ss-redir|ss-manager' || true",
  'printf "config-paths:\\n"',
  'for path in /etc/shadowsocks /etc/shadowsocks-libev /etc/shadowsocks.json /usr/local/etc/shadowsocks*; do [ -e "$path" ] && ls -ld "$path"; done 2>/dev/null || true',
].join('\n')

type KnownProposalType = Exclude<ActionProposal['actionType'], 'custom_command'>

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string
      tool_calls?: ToolCall[]
    }
  }>
}

export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
  error?: string
}

export interface CustomSshProposalInput {
  title: string
  description: string
  command: string
  risk: ActionProposal['risk']
}

export interface SftpTransferPlanInput {
  direction: TransferJob['direction']
  source: string
  target: string
  fileName: string
  description: string
}

export interface CopilotToolRuntime {
  inspectSystem(check: SystemInspectionCheck): Promise<ToolResult>
  executeReadOnlySsh(command: string, reason: string): Promise<ToolResult>
  listRemoteFiles(path: string): Promise<ToolResult>
  createKnownProposal(type: KnownProposalType): ToolResult
  createSshProposal(input: CustomSshProposalInput): ToolResult
  planSftpTransfer(input: SftpTransferPlanInput): ToolResult
}

export interface CopilotAgentInput {
  vm: VM
  vms: VM[]
  activeTab: TabId
  message: string
  transfers: TransferJob[]
  history: CopilotMessage[]
  runtime: CopilotToolRuntime
  onProgress?: (progress: Omit<CopilotProgressEvent, 'id' | 'vmId' | 'timestamp'>) => void
}

export interface CopilotAgentResult {
  content: string
  provider: 'moonshot'
}

export interface MoonshotConfig {
  apiKey: string
  baseUrl: string
  model: string
}

function compact(value: string, maxLength = 1800) {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }

  return `${trimmed.slice(0, maxLength - 20).trimEnd()}\n... truncated ...`
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

function summarizeVm(vm: VM) {
  const degradedServices = vm.services.filter((service) => service.state !== 'running')
  return [
    `Selected VM: ${vm.name} (${vm.id}), hostname ${vm.hostname}, ${vm.lifecycle}/${vm.health}, ${vm.os}.`,
    `Connection: ${vm.connection.user}@${vm.connection.host}:${vm.connection.port}, key label ${vm.connection.keyLabel}, SSH test ${vm.connection.testStatus}.`,
    `Metrics: CPU ${vm.metrics.cpuPercent}%, memory ${vm.metrics.memoryPercent}%, disk ${vm.metrics.diskPercent}%, load ${vm.metrics.loadAverage.join(' ')}, uptime ${vm.metrics.uptime}.`,
    `Tracked services: ${
      vm.services.map((service) => `${service.name}:${service.state}${service.port ? `:${service.port}` : ''}`).join(', ') ||
      'none'
    }.`,
    `Tracked degraded services: ${
      degradedServices.map((service) => `${service.name}:${service.state}`).join(', ') || 'none'
    }.`,
  ].join('\n')
}

function summarizeFleet(vms: VM[]) {
  return vms
    .map((vm) => `${vm.name}=${vm.lifecycle}/${vm.health} ${vm.connection.user}@${vm.connection.host}:${vm.connection.port}`)
    .join('; ')
}

function summarizeTransfers(vm: VM, transfers: TransferJob[]) {
  const relevantTransfers = transfers.filter((transfer) => transfer.vmId === vm.id).slice(0, 5)
  if (!relevantTransfers.length) {
    return 'No active transfers for the selected VM.'
  }

  return relevantTransfers
    .map((transfer) => `${transfer.direction} ${transfer.fileName}: ${transfer.status}, ${transfer.source} -> ${transfer.target}`)
    .join('\n')
}

function proposalTypeFromValue(value: unknown): KnownProposalType | undefined {
  const knownTypes: KnownProposalType[] = [
    'inspect_logs',
    'restart_service',
    'snapshot',
    'transfer_file',
    'explain_metrics',
    'patch_vms',
  ]
  return knownTypes.find((type) => type === value)
}

function riskFromValue(value: unknown): ActionProposal['risk'] {
  return value === 'medium' || value === 'high' ? value : 'low'
}

function transferDirectionFromValue(value: unknown): TransferJob['direction'] {
  return value === 'upload' || value === 'download' || value === 'copy' ? value : 'copy'
}

function buildSystemPrompt() {
  return [
    'You are Grove Copilot, a local agentic VM assistant running inside the user-owned Grove backend.',
    'You have context for the selected VM and its SSH connection info, but you must use tools for live operational questions.',
    'Use inspect_system or ssh_exec before answering operational questions. Use shadowsocks_running for live service/process/listener questions. Use shadowsocks_installed for package, binary, unit-file, or config existence questions.',
    'Read-only SSH and SFTP inspection may run directly. Mutating operations, file writes, package changes, service restarts, reboots, and destructive actions must be turned into confirmation proposals.',
    'Never type into the user live terminal. All tool work uses Grove backend SSH/SFTP channels.',
    'Do not reveal API keys, private key contents, or hidden environment values. It is okay to mention host, port, username, and key label already present in VM context.',
    'Keep answers concise. Say what you checked, on which VM, and what the result means.',
  ].join('\n')
}

function buildInitialMessages(input: CopilotAgentInput): ChatMessage[] {
  const history = input.history.slice(-10).map((message): ChatMessage => ({
    role: message.role,
    content: message.content,
  }))

  return [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: [
        `Active tab: ${input.activeTab}.`,
        summarizeVm(input.vm),
        `Fleet: ${summarizeFleet(input.vms)}.`,
        `Transfers: ${summarizeTransfers(input.vm, input.transfers)}.`,
      ].join('\n'),
    },
    ...history,
    { role: 'user', content: input.message },
  ]
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'inspect_system',
      description: 'Run a built-in read-only diagnostic on the selected VM for runtime or installation checks.',
      parameters: {
        type: 'object',
        properties: {
          check: {
            type: 'string',
            enum: ['shadowsocks_running', 'shadowsocks_installed'],
            description:
              'The diagnostic to run. Use shadowsocks_running for runtime status; use shadowsocks_installed for install/package/binary/config evidence.',
          },
        },
        required: ['check'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_exec',
      description: 'Run a read-only SSH command on the selected VM using a non-interactive exec channel.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'A read-only Linux shell command. Mutating commands will be rejected.',
          },
          reason: {
            type: 'string',
            description: 'Why this read-only command is needed.',
          },
        },
        required: ['command', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sftp_list',
      description: 'List files on the selected VM over SFTP.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Remote path to list, such as / or /etc.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_known_proposal',
      description: 'Create one of Grove built-in confirmation proposals.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['inspect_logs', 'restart_service', 'snapshot', 'transfer_file', 'explain_metrics', 'patch_vms'],
          },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_ssh_command',
      description: 'Create a confirmation proposal for a mutating or custom SSH command. The command is not executed now.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          command: { type: 'string' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['title', 'description', 'command', 'risk'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_sftp_transfer',
      description: 'Create a confirmation proposal describing an SFTP upload/download/copy plan. The transfer is not executed now.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['upload', 'download', 'copy'] },
          source: { type: 'string' },
          target: { type: 'string' },
          fileName: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['direction', 'source', 'target', 'fileName', 'description'],
      },
    },
  },
]

function parseArgs(rawArgs: string) {
  try {
    return JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function serializeToolResult(result: ToolResult) {
  return compact(JSON.stringify(result), 8000)
}

function toolCacheKey(toolCall: ToolCall) {
  return `${toolCall.function.name}:${toolCall.function.arguments || '{}'}`
}

function summarizeToolEvidence(messages: ChatMessage[]) {
  const toolMessages = messages.filter((message) => message.role === 'tool').slice(-6)
  if (!toolMessages.length) {
    return 'I could not complete a final model response, and no tool results were available to summarize.'
  }

  return [
    'I checked the VM with the available tools, but could not get a final model response. Latest tool results:',
    ...toolMessages.map((message) => {
      const content = compact(message.content ?? '', 700).replace(/\s+/g, ' ')
      return `- ${message.name ?? 'tool'}: ${content}`
    }),
  ].join('\n')
}

function toolTitle(toolName: string) {
  if (toolName === 'inspect_system') {
    return 'Running system diagnostic'
  }
  if (toolName === 'ssh_exec') {
    return 'Running SSH inspection'
  }
  if (toolName === 'sftp_list') {
    return 'Listing remote files'
  }
  if (toolName === 'create_known_proposal' || toolName === 'propose_ssh_command') {
    return 'Preparing confirmation proposal'
  }
  if (toolName === 'plan_sftp_transfer') {
    return 'Planning SFTP transfer'
  }

  return 'Running copilot operation'
}

function toolDetail(toolCall: ToolCall) {
  const args = parseArgs(toolCall.function.arguments)
  if (toolCall.function.name === 'ssh_exec') {
    return compact(String(args.command ?? 'SSH command'), 220)
  }
  if (toolCall.function.name === 'inspect_system') {
    return String(args.check ?? 'system check')
  }
  if (toolCall.function.name === 'sftp_list') {
    return `Path: ${String(args.path ?? '/')}`
  }
  if (toolCall.function.name === 'create_known_proposal') {
    return String(args.type ?? 'proposal')
  }
  if (toolCall.function.name === 'propose_ssh_command') {
    return compact(String(args.title ?? args.command ?? 'SSH proposal'), 220)
  }
  if (toolCall.function.name === 'plan_sftp_transfer') {
    return `${String(args.source ?? '')} -> ${String(args.target ?? '')}`.trim()
  }

  return undefined
}

function publishProgress(
  input: CopilotAgentInput,
  title: string,
  detail?: string,
  status: CopilotProgressEvent['status'] = 'running',
) {
  input.onProgress?.({
    title,
    detail,
    status,
  })
}

async function executeTool(input: CopilotAgentInput, toolCall: ToolCall): Promise<ToolResult> {
  const args = parseArgs(toolCall.function.arguments)

  if (toolCall.function.name === 'inspect_system') {
    return input.runtime.inspectSystem(args.check === 'shadowsocks_installed' ? 'shadowsocks_installed' : 'shadowsocks_running')
  }

  if (toolCall.function.name === 'ssh_exec') {
    return input.runtime.executeReadOnlySsh(String(args.command ?? ''), String(args.reason ?? 'Requested by copilot.'))
  }

  if (toolCall.function.name === 'sftp_list') {
    return input.runtime.listRemoteFiles(String(args.path ?? '/'))
  }

  if (toolCall.function.name === 'create_known_proposal') {
    const type = proposalTypeFromValue(args.type)
    if (!type) {
      return { ok: false, summary: 'Unknown proposal type.', error: 'Unknown proposal type.' }
    }
    return input.runtime.createKnownProposal(type)
  }

  if (toolCall.function.name === 'propose_ssh_command') {
    return input.runtime.createSshProposal({
      title: String(args.title ?? 'Run SSH command'),
      description: String(args.description ?? 'Execute this command after confirmation.'),
      command: String(args.command ?? ''),
      risk: riskFromValue(args.risk),
    })
  }

  if (toolCall.function.name === 'plan_sftp_transfer') {
    return input.runtime.planSftpTransfer({
      direction: transferDirectionFromValue(args.direction),
      source: String(args.source ?? ''),
      target: String(args.target ?? ''),
      fileName: String(args.fileName ?? 'transfer'),
      description: String(args.description ?? 'Plan this transfer after confirmation.'),
    })
  }

  return {
    ok: false,
    summary: `Unknown tool ${toolCall.function.name}.`,
    error: `Unknown tool ${toolCall.function.name}.`,
  }
}

export class CopilotAgent {
  private config?: MoonshotConfig

  constructor(config: MoonshotConfig | undefined = moonshotConfigFromEnv()) {
    this.config = config
  }

  configure(config: MoonshotConfig) {
    this.config = config
  }

  async respond(input: CopilotAgentInput): Promise<CopilotAgentResult> {
    if (!this.config) {
      throw new Error('Moonshot API key is not configured. Open Settings > Copilot provider to save a key.')
    }

    return this.respondWithMoonshot(input)
  }

  private async respondWithMoonshot(input: CopilotAgentInput): Promise<CopilotAgentResult> {
    const messages = buildInitialMessages(input)
    const toolResultCache = new Map<string, ToolResult>()

    for (let turn = 0; turn < MAX_TOOL_LOOPS; turn += 1) {
      publishProgress(input, turn === 0 ? 'Sent request to Kimi' : 'Sent tool results back to Kimi', undefined, 'running')
      const assistantMessage = await this.complete(messages)
      const toolCalls = assistantMessage.tool_calls ?? []
      if (!toolCalls.length) {
        publishProgress(input, 'Formatted final answer', 'Kimi returned a response for the panel.', 'completed')
        return {
          content: compact(assistantMessage.content ?? 'I checked the available context, but I do not have a final answer.'),
          provider: 'moonshot',
        }
      }

      publishProgress(
        input,
        'Kimi selected operations',
        toolCalls.map((toolCall) => toolCall.function.name).join(', '),
        'running',
      )
      messages.push({
        role: 'assistant',
        content: assistantMessage.content ?? '',
        reasoning_content: assistantMessage.reasoning_content,
        tool_calls: toolCalls,
      })

      for (const toolCall of toolCalls) {
        const cacheKey = toolCacheKey(toolCall)
        const cachedResult = toolResultCache.get(cacheKey)
        publishProgress(
          input,
          cachedResult ? 'Reusing earlier tool result' : toolTitle(toolCall.function.name),
          toolDetail(toolCall),
          'running',
        )
        const result = cachedResult
          ? {
              ...cachedResult,
              summary: `Skipped repeated ${toolCall.function.name} call; using the earlier result. ${cachedResult.summary}`,
            }
          : await executeTool(input, toolCall)
        if (!cachedResult) {
          toolResultCache.set(cacheKey, result)
        }
        publishProgress(
          input,
          result.ok ? `${toolTitle(toolCall.function.name)} completed` : `${toolTitle(toolCall.function.name)} failed`,
          result.summary,
          result.ok ? 'completed' : 'failed',
        )
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: serializeToolResult(result),
        })
      }
    }

    publishProgress(input, 'Synthesizing gathered results', 'Tool budget reached; asking Kimi for a final answer without more tools.', 'running')
    messages.push({
      role: 'user',
      content: [
        'Stop using tools now.',
        'You have already used the available tool budget for this request.',
        'Produce the best final answer from the tool results above. If evidence is absent or inconclusive, say that clearly and list what was checked.',
      ].join('\n'),
    })

    try {
      const finalMessage = await this.complete(messages, { allowTools: false })
      publishProgress(input, 'Formatted final answer', 'Kimi summarized the gathered tool results.', 'completed')
      return {
        content: compact(finalMessage.content ?? summarizeToolEvidence(messages)),
        provider: 'moonshot',
      }
    } catch {
      publishProgress(input, 'Formatted fallback answer', 'Summarized the latest tool results locally.', 'completed')
      return {
        content: summarizeToolEvidence(messages),
        provider: 'moonshot',
      }
    }
  }

  private async complete(messages: ChatMessage[], options: { allowTools?: boolean } = {}) {
    const allowTools = options.allowTools ?? true
    if (!this.config) {
      throw new Error('Moonshot config is missing.')
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: 1,
      max_tokens: 1600,
    }
    if (allowTools) {
      body.tools = tools
      body.tool_choice = 'auto'
    } else {
      body.tool_choice = 'none'
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      throw new Error(`Moonshot chat request failed (${response.status}): ${compact(body, 500)}`)
    }

    const json = (await response.json()) as ChatResponse
    const message = json.choices?.[0]?.message
    if (!message) {
      throw new Error('Moonshot chat response did not include a message.')
    }

    return message
  }

}

export function isAgentReadOnlyCommand(command: string) {
  if (!command.trim()) {
    return false
  }

  const classification = classifyCommand(command)
  if (classification.mutating) {
    return false
  }

  const allowedPrefixes = [
    'awk',
    'cat',
    'command -v',
    'df',
    'du',
    'free',
    'grep',
    'head',
    'hostname',
    'id',
    'journalctl',
    'ls',
    'pgrep',
    'ps',
    'pwd',
    'ss',
    'stat',
    'sudo journalctl',
    'sudo systemctl is-active',
    'sudo systemctl is-enabled',
    'sudo systemctl list-units',
    'sudo systemctl status',
    'systemctl is-active',
    'systemctl is-enabled',
    'systemctl list-units',
    'systemctl status',
    'tail',
    'uname',
    'uptime',
    'which',
  ]
  const normalized = command
    .trim()
    .replace(/^timeout\s+\d+[smhd]?\s+/i, '')
    .replace(/\s+/g, ' ')
  return (
    allowedPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    command === SHADOWSOCKS_RUNNING_DIAGNOSTIC_COMMAND ||
    command === SHADOWSOCKS_INSTALLED_DIAGNOSTIC_COMMAND
  )
}

export function toolResultFromCommandRun(run: CommandRun): ToolResult {
  return {
    ok: run.status === 'completed',
    summary: run.summary,
    data: {
      ...run,
      stdout: compact(run.stdout ?? '', 5000),
      stderr: compact(run.stderr ?? '', 2000),
    },
    error: run.status === 'failed' ? run.stderr || run.summary : undefined,
  }
}

export function toolResultFromFiles(path: string, files: FileNode[]): ToolResult {
  return {
    ok: true,
    summary: `Listed ${files.length} remote item${files.length === 1 ? '' : 's'} at ${path}.`,
    data: files.slice(0, 50),
  }
}
