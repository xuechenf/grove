import type {
  CopilotRuntimeStatus,
  CopilotScope,
  CopilotToolCallKind,
  CopilotToolCallStatus,
  VM,
} from '../src/types'

/** Result shape returned by every Grove MCP tool. */
export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
  error?: string
}

/**
 * Backend capabilities the MCP tool layer delegates to. The store implements this; it owns
 * command classification, the per-VM mutation lock, the confirmation gate, SSH transport,
 * journaling, and activity. The MCP layer is a thin, scope-aware adapter over it.
 */
export interface CopilotToolHost {
  listVms(): VM[]
  getVm(vmId: string): VM | undefined
  /** Read-only commands run immediately; mutating commands block on a UI confirmation. */
  runScopedCommand(input: {
    scope: CopilotScope
    vmId: string
    command: string
    reason: string
  }): Promise<ToolResult>
  readRemoteLogs(input: { vmId: string; unit?: string; grep?: string; lines: number }): Promise<ToolResult>
  listRemoteFiles(input: { vmId: string; path: string }): Promise<ToolResult>
  serviceStatus(input: { vmId: string; name: string }): Promise<ToolResult>
  /** Composite runtime inspection: metrics + services + top processes in one SSH exec. */
  inspectVm(input: { scope: CopilotScope; vmId: string }): Promise<ToolResult>
  /** Composite unit diagnosis: status + recent logs + listening ports in one SSH exec. */
  diagnoseService(input: { scope: CopilotScope; vmId: string; unit: string; lines: number }): Promise<ToolResult>
  fleetRunCommand(input: {
    scope: CopilotScope
    command: string
    reason: string
    targetVmIds?: string[]
  }): Promise<ToolResult>
  recordNote(input: { scope: CopilotScope; content: string }): ToolResult
  getHistory(input: { scope: CopilotScope; query?: string; limit?: number }): ToolResult
}

/** A streaming update emitted by a driver during a prompt turn. */
export type DriverUpdate =
  | { type: 'message_delta'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'tool_call'
      id: string
      title: string
      kind: CopilotToolCallKind
      status: CopilotToolCallStatus
      detail?: string
      output?: string
    }
  | { type: 'plan'; entries: Array<{ title: string; status: string }> }
  | { type: 'progress'; title: string; detail?: string }

/** How a scope's kimi session reaches Grove's scoped MCP tools. */
export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** A kimi `--mcp-config-file` JSON file describing this server (used by the print driver). */
  configPath: string
}

export interface PromptRequest {
  scope: CopilotScope
  /** Working directory for the scope's kimi session (its generated AGENTS.md lives here). */
  cwd: string
  mcp: McpServerSpec
  message: string
  onUpdate: (update: DriverUpdate) => void
}

export interface PromptResult {
  text: string
  stopReason?: string
}

/**
 * A copilot brain. The ACP and print drivers run kimi-code CLI; the mock driver replays
 * scripted updates for tests and offline development. The supervisor only talks to this.
 */
export interface CopilotDriver {
  readonly name: CopilotRuntimeStatus['driver']
  start(): Promise<void>
  prompt(request: PromptRequest): Promise<PromptResult>
  cancel(scope: CopilotScope): void
  stop(): Promise<void>
  status(): CopilotRuntimeStatus
}
