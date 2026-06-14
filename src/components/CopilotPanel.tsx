import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Send,
  ShieldQuestion,
  Square,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type {
  ActionProposal,
  CopilotMessage,
  CopilotPermissionDecision,
  CopilotPlanState,
  CopilotProgressEvent,
  CopilotRuntimeStatus,
  CopilotScope,
  CopilotToolCall,
  TabId,
} from '../types'
import { Markdown } from './Markdown'
import { OpenUiArtifact, type OperatorBriefAction } from './OpenUiArtifact'

interface CopilotPanelProps {
  scope: CopilotScope
  scopeLabel: string
  runtime: CopilotRuntimeStatus
  messages: CopilotMessage[]
  toolCalls: CopilotToolCall[]
  plans: CopilotPlanState[]
  progress: CopilotProgressEvent[]
  proposals: ActionProposal[]
  isBusy: boolean
  onSendMessage: (message: string, options?: { referenceHistory?: boolean }) => void
  onOpenWorkspaceTarget?: (target: { vmId?: string; tab?: TabId }) => void
  onDecideProposal: (proposalId: string, decision: CopilotPermissionDecision) => void
  onCancel: () => void
}

const OUTPUT_PREVIEW_LINES = 5

function stepDotClass(status: CopilotToolCall['status']) {
  if (status === 'completed') {
    return 'text-emerald-600'
  }
  if (status === 'failed') {
    return 'text-rose-600'
  }
  return 'animate-pulse text-slate-400'
}

/** One-line rendering of the tool's argument detail for the `title(args)` step header. */
function inlineDetail(detail: string | undefined, max = 96) {
  if (!detail) {
    return ''
  }
  const flat = detail.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A single execution step, rendered the way the kimi-code TUI prints it:
 *
 *   ⏺ run_command(df -h /var)
 *     ⎿ Filesystem  Size  Used Avail
 *        … +12 lines (expand)
 */
function ToolStep({ toolCall }: { toolCall: CopilotToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const outputLines = useMemo(
    () => (toolCall.output ? toolCall.output.replace(/\r\n/g, '\n').split('\n') : []),
    [toolCall.output],
  )
  // Completed steps collapse to a 2-line result peek to keep the transcript compact; steps
  // still running or failed stay fuller so in-flight work and errors remain visible.
  const previewLines = toolCall.status === 'completed' ? 2 : OUTPUT_PREVIEW_LINES
  const hiddenLines = Math.max(0, outputLines.length - previewLines)
  const visibleLines = expanded ? outputLines : outputLines.slice(0, previewLines)
  const args = inlineDetail(toolCall.detail)

  return (
    <div className="font-mono text-xs leading-relaxed" data-testid="tool-step">
      <div className="flex items-start gap-2">
        <span className={`select-none ${stepDotClass(toolCall.status)}`} aria-hidden="true">
          ⏺
        </span>
        <span className="min-w-0 break-words text-slate-800">
          <span className="font-semibold">{toolCall.title}</span>
          {args ? <span className="text-slate-500">({args})</span> : null}
          {toolCall.status === 'running' ? <span className="ml-2 text-slate-400">running…</span> : null}
          {toolCall.status === 'failed' && !toolCall.output ? <span className="ml-2 text-rose-600">failed</span> : null}
        </span>
      </div>
      {outputLines.length > 0 ? (
        <div className="mt-0.5 flex gap-2 pl-1">
          <span className="select-none text-slate-300" aria-hidden="true">
            ⎿
          </span>
          <div className={`min-w-0 flex-1 ${toolCall.status === 'failed' ? 'text-rose-700' : 'text-slate-500'}`}>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words">{visibleLines.join('\n')}</pre>
            {hiddenLines > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="mt-0.5 text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600"
              >
                {expanded ? 'collapse' : `… +${hiddenLines} lines`}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The agent's reasoning, dim and italic like the TUI; collapses once the block closes. */
function ThinkingBlock({ toolCall }: { toolCall: CopilotToolCall }) {
  const [open, setOpen] = useState(false)
  const streaming = toolCall.status === 'running'
  const text = (toolCall.output ?? '').trim()
  const showBody = streaming || open

  return (
    <div className="font-mono text-xs leading-relaxed text-slate-400">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={streaming}
        className="flex items-center gap-2 italic disabled:cursor-default"
      >
        <span className={streaming ? 'animate-pulse select-none' : 'select-none'} aria-hidden="true">
          ✻
        </span>
        <span>{streaming ? 'Thinking…' : 'Thought'}</span>
        {!streaming ? (
          open ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )
        ) : null}
      </button>
      {showBody && text ? (
        <p className="mt-0.5 whitespace-pre-wrap break-words pl-5 italic">{text}</p>
      ) : null}
    </div>
  )
}

function planEntryIcon(status: CopilotPlanState['entries'][number]['status']) {
  if (status === 'completed') {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-emerald-600 bg-emerald-600 text-white">
        <Check className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
    )
  }
  if (status === 'in_progress') {
    return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-slate-700 text-[9px] font-bold text-slate-700">▸</span>
  }
  return <span className="h-3.5 w-3.5 rounded-sm border border-slate-300 bg-white" />
}

/** The agent's task checklist; entries tick off in place as the run progresses. */
function PlanCard({ plan }: { plan: CopilotPlanState }) {
  return (
    <div className="font-mono text-xs leading-relaxed" data-testid="plan-card">
      <div className="flex items-start gap-2">
        <span className="select-none text-slate-400" aria-hidden="true">
          ⏺
        </span>
        <span className="font-semibold text-slate-800">Plan</span>
      </div>
      <div className="mt-1 flex gap-2 pl-1">
        <span className="select-none text-slate-300" aria-hidden="true">
          ⎿
        </span>
        <ul className="min-w-0 flex-1 space-y-1">
          {plan.entries.map((entry, index) => (
            <li key={index} className="flex items-center gap-2">
              {planEntryIcon(entry.status)}
              <span
                className={
                  entry.status === 'completed'
                    ? 'text-slate-400 line-through'
                    : entry.status === 'in_progress'
                      ? 'font-semibold text-slate-900'
                      : 'text-slate-600'
                }
              >
                {entry.title}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function PermissionCard({
  proposal,
  actionable,
  onDecide,
}: {
  proposal: ActionProposal
  /** Only the oldest undecided card gets buttons; later ones queue behind it. */
  actionable: boolean
  onDecide: (proposalId: string, decision: CopilotPermissionDecision) => void
}) {
  const awaiting = proposal.status === 'awaiting_confirmation' || proposal.status === 'pending_confirmation'
  // Decided but not yet executed/dismissed: the command is running right now.
  const executing = awaiting && Boolean(proposal.decision)
  return (
    <article className="overflow-hidden rounded-md border border-amber-300 bg-white text-sm shadow-sm">
      <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-semibold text-slate-900">{proposal.title}</h3>
          <p className="text-xs text-slate-600">{proposal.description}</p>
        </div>
        <span className="rounded border border-amber-200 bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-700">
          {proposal.risk}
        </span>
      </div>
      <pre className="overflow-auto bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
        {proposal.command}
      </pre>
      {executing ? (
        <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs text-slate-600">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden="true" />
          {proposal.decision === 'deny' ? 'Denying…' : 'Allowed — executing…'}
        </div>
      ) : awaiting && !actionable ? (
        <div className="px-3 py-2 font-mono text-xs text-slate-400">Queued — decide the command above first.</div>
      ) : awaiting ? (
        <div className="flex flex-wrap gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => onDecide(proposal.id, 'allow_once')}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-900 bg-slate-900 px-2.5 font-mono text-xs font-medium text-white transition hover:bg-slate-800"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => onDecide(proposal.id, 'always_allow')}
            className="inline-flex h-7 items-center rounded border border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Always allow
          </button>
          <button
            type="button"
            onClick={() => onDecide(proposal.id, 'deny')}
            className="inline-flex h-7 items-center rounded border border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-rose-700 transition hover:bg-rose-50"
          >
            Deny
          </button>
        </div>
      ) : (
        <div
          className={`px-3 py-2 font-mono text-xs ${
            proposal.status === 'executed' ? 'text-emerald-700' : 'text-slate-500'
          }`}
        >
          {proposal.status === 'executed' ? '✓ Executed' : '✕ Dismissed'}
          {proposal.result ? `: ${proposal.result}` : ''}
        </div>
      )}
    </article>
  )
}

type TimelineItem =
  | { kind: 'message'; order: number; tie: number; data: CopilotMessage }
  | { kind: 'toolcall'; order: number; tie: number; data: CopilotToolCall }
  | { kind: 'proposal'; order: number; tie: number; data: ActionProposal }
  | { kind: 'plan'; order: number; tie: number; data: CopilotPlanState }

/** A user prompt and every step + answer it produced, rendered as one visual block. */
interface TurnGroup {
  id: string
  prompt?: CopilotMessage
  items: TimelineItem[]
}

/**
 * Fold the flat, time-ordered timeline into turns. A user message opens a turn; every later
 * item (tool steps, thoughts, plans, proposals, the assistant answer) belongs to it until the
 * next user message. Items before the first prompt (e.g. the initial greeting) form a leading
 * promptless group.
 */
function groupIntoTurns(timeline: TimelineItem[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: TurnGroup | undefined
  for (const item of timeline) {
    if (item.kind === 'message' && item.data.role === 'user') {
      current = { id: item.data.id, prompt: item.data, items: [] }
      groups.push(current)
      continue
    }
    if (!current) {
      current = { id: `lead-${item.data.id}`, items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }
  return groups
}

export function CopilotPanel({
  scope,
  scopeLabel,
  runtime,
  messages,
  toolCalls,
  plans,
  progress,
  proposals,
  isBusy,
  onSendMessage,
  onOpenWorkspaceTarget = () => undefined,
  onDecideProposal,
  onCancel,
}: CopilotPanelProps) {
  const [draft, setDraft] = useState('')
  const [referenceHistory, setReferenceHistory] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: Array<Omit<TimelineItem, 'tie'>> = [
      ...messages.map((message, index) => ({ kind: 'message' as const, order: message.createdAt ?? index, data: message })),
      ...toolCalls.map((toolCall, index) => ({ kind: 'toolcall' as const, order: toolCall.createdAt ?? index, data: toolCall })),
      ...plans.map((plan, index) => ({ kind: 'plan' as const, order: plan.createdAt ?? index, data: plan })),
      ...proposals.map((proposal, index) => ({ kind: 'proposal' as const, order: proposal.createdAt ?? index, data: proposal })),
    ]
    // `tie` (merge index) keeps equal-order items in a deterministic order so a re-render
    // never reshuffles them; server stamps are monotonic so real ties shouldn't occur.
    return (items.map((item, tie) => ({ ...item, tie })) as TimelineItem[]).sort(
      (left, right) => left.order - right.order || left.tie - right.tie,
    )
  }, [messages, toolCalls, plans, proposals])

  const turns = useMemo(() => groupIntoTurns(timeline), [timeline])

  const latestProgress = progress[0]
  const pendingPermissions = proposals.filter((proposal) => proposal.status === 'awaiting_confirmation').length

  // Confirmations resolve strictly in order: only the oldest undecided card is actionable.
  const activeConfirmationId = useMemo(() => {
    const awaiting = proposals.filter(
      (proposal) =>
        (proposal.status === 'awaiting_confirmation' || proposal.status === 'pending_confirmation') &&
        !proposal.decision,
    )
    awaiting.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
    return awaiting[0]?.id
  }, [proposals])

  useEffect(() => {
    if (bottomRef.current?.scrollIntoView) {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [timeline, isBusy])

  // Esc interrupts the running turn, exactly as in the TUI.
  useEffect(() => {
    if (!isBusy) {
      return
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isBusy, onCancel])

  function submit() {
    const trimmed = draft.trim()
    if (!trimmed || isBusy) {
      return
    }
    onSendMessage(trimmed, { referenceHistory })
    setDraft('')
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }
    event.preventDefault()
    submit()
  }

  function handleOpenUiAction(action: OperatorBriefAction) {
    if (action.kind === 'focus_vm') {
      onOpenWorkspaceTarget({ vmId: action.vmId })
      return
    }

    if (action.kind === 'open_tab') {
      onOpenWorkspaceTarget({ vmId: action.vmId, tab: action.tab })
      return
    }

    if (action.kind === 'ask_followup') {
      if (!isBusy) {
        onSendMessage(action.message ?? action.label)
      }
      return
    }

    if (!isBusy) {
      const target = action.vmId ? ` on ${action.vmId}` : ''
      const subject = action.message ?? action.label
      onSendMessage(`Propose a safe Grove-confirmed fix${target}: ${subject}`)
    }
  }

  const runtimeLabel =
    runtime.state === 'ready'
      ? `kimi (${runtime.driver})`
      : runtime.state === 'disabled'
        ? 'offline'
        : `${runtime.driver}: ${runtime.state}`

  /** Render one non-prompt timeline item (tool step, thought, plan, proposal, or answer). */
  function renderItem(item: TimelineItem) {
    if (item.kind === 'toolcall') {
      if (item.data.kind === 'think') {
        return <ThinkingBlock key={item.data.id} toolCall={item.data} />
      }
      return <ToolStep key={item.data.id} toolCall={item.data} />
    }
    if (item.kind === 'plan') {
      return <PlanCard key={item.data.id} plan={item.data} />
    }
    if (item.kind === 'proposal') {
      return (
        <PermissionCard
          key={item.data.id}
          proposal={item.data}
          actionable={item.data.id === activeConfirmationId}
          onDecide={onDecideProposal}
        />
      )
    }

    const message = item.data
    // An empty streaming bubble has nothing to show; the status line covers it.
    if (message.streaming && !message.content && !message.openUi) {
      return null
    }
    return (
      <div key={message.id} className="flex gap-2 text-sm">
        <span className="select-none font-mono text-slate-700" aria-hidden="true">
          ⏺
        </span>
        <div className="min-w-0 flex-1">
          {message.streaming ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed text-slate-700">
              {message.content}
              <span className="ml-0.5 animate-pulse text-slate-400" aria-hidden="true">
                ▍
              </span>
            </p>
          ) : (
            <div className="space-y-3">
              {message.content.trim() ? <Markdown content={message.content} /> : null}
              {message.openUi ? (
                <OpenUiArtifact artifact={message.openUi} disabled={isBusy} onAction={handleOpenUiAction} />
              ) : null}
            </div>
          )}
        </div>
      </div>
    )
  }

  /** A turn: the prompt as a distinct header, its steps indented, then the answer at the end. */
  function renderTurn(turn: TurnGroup) {
    const answers = turn.items.filter((item) => item.kind === 'message')
    const steps = turn.items.filter((item) => item.kind !== 'message')
    return (
      <div key={turn.id} className="flex flex-col gap-3">
        {turn.prompt ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-slate-900 px-3 py-2 text-sm text-white shadow-sm">
              {turn.prompt.content}
            </div>
          </div>
        ) : null}
        {steps.length > 0 ? (
          <div className="flex flex-col gap-2 border-l-2 border-slate-100 pl-3">{steps.map((item) => renderItem(item))}</div>
        ) : null}
        {answers.map((item) => renderItem(item))}
      </div>
    )
  }

  return (
    <section className="flex min-h-[560px] min-w-0 flex-1 flex-col border-r border-slate-200 bg-white lg:min-h-0">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-700">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-950">
                Copilot · {scope === 'fleet' ? 'All VMs' : scopeLabel}
              </h2>
              <p className="truncate font-mono text-xs text-slate-500">{runtimeLabel}</p>
            </div>
          </div>
          {isBusy ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2.5 font-mono text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-white"
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-white px-4 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {timeline.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
              {scope === 'fleet'
                ? 'Ask about the whole fleet — health, which VMs need attention, or run something across machines.'
                : `Ask about ${scopeLabel} — inspect services, read logs, or run a command (mutating ones ask first).`}
            </div>
          ) : null}

          {turns.map((turn) => renderTurn(turn))}

          {isBusy ? (
            <div aria-live="polite" className="flex items-center gap-2 font-mono text-xs text-slate-500">
              <span className="animate-pulse select-none text-slate-400" aria-hidden="true">
                ✻
              </span>
              <span className="font-medium text-slate-600">{latestProgress?.title ?? 'Working'}…</span>
              {latestProgress?.detail ? <span className="truncate text-slate-400">{latestProgress.detail}</span> : null}
              <span className="shrink-0 text-slate-300">(esc to interrupt)</span>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {pendingPermissions > 0 ? (
            <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-mono text-xs text-amber-800">
              {pendingPermissions} action{pendingPermissions === 1 ? '' : 's'} waiting for your confirmation above.
            </div>
          ) : null}
          <div className="flex items-start gap-2 rounded-lg border border-slate-300 bg-white p-2 shadow-sm transition focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500">
            <span className="select-none pt-1 font-mono text-sm text-slate-400" aria-hidden="true">
              &gt;
            </span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleDraftKeyDown}
              rows={1}
              aria-label="Copilot message"
              className="max-h-36 min-h-12 w-full resize-none overflow-auto py-1 text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-400"
              placeholder={scope === 'fleet' ? 'Ask about all VMs' : `Ask about ${scopeLabel}`}
            />
            <button
              type="button"
              onClick={submit}
              disabled={isBusy || !draft.trim()}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-900 bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="Send copilot message"
            >
              {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[11px] text-slate-400">
            <label
              className="flex min-w-0 cursor-pointer items-center gap-1.5 text-slate-500 hover:text-slate-700"
              title="Include this scope's recent execution history in the request. Off by default to keep sessions short and cheap; turn on for follow-ups that need prior context."
            >
              <input
                type="checkbox"
                checked={referenceHistory}
                onChange={(event) => setReferenceHistory(event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 accent-slate-900"
              />
              <span className="truncate">Reference history</span>
            </label>
            <span className="shrink-0">enter to send · shift+enter for newline</span>
          </div>
        </div>
      </div>
    </section>
  )
}
