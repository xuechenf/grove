import {
  Bot,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileSearch,
  Gauge,
  LoaderCircle,
  Send,
  Wand2,
  XCircle,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { ActionProposal, CopilotMessage, CopilotProgressEvent, TabId, VM } from '../types'

interface CopilotPanelProps {
  vm?: VM
  activeTab: TabId
  messages: CopilotMessage[]
  progress: CopilotProgressEvent[]
  proposals: ActionProposal[]
  isBusy: boolean
  onSendMessage: (message: string) => void
  onCreateProposal: (type: ActionProposal['actionType']) => void
  onConfirmProposal: (proposalId: string) => void
}

const DEFAULT_PANEL_WIDTH = 384
const MIN_PANEL_WIDTH = 320
const MAX_PANEL_WIDTH = 680

function clampPanelWidth(width: number) {
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH)
}

function iconForProposal(type: ActionProposal['actionType']) {
  if (type === 'inspect_logs') {
    return <FileSearch className="h-4 w-4" aria-hidden="true" />
  }

  if (type === 'transfer_file') {
    return <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
  }

  if (type === 'explain_metrics') {
    return <Gauge className="h-4 w-4" aria-hidden="true" />
  }

  return <Wand2 className="h-4 w-4" aria-hidden="true" />
}

function suggestionSet(activeTab: TabId): Array<{ label: string; type: ActionProposal['actionType'] }> {
  if (activeTab === 'files') {
    return [
      { label: 'Plan transfer', type: 'transfer_file' },
      { label: 'Patch VMs', type: 'patch_vms' },
      { label: 'Inspect logs', type: 'inspect_logs' },
    ]
  }

  if (activeTab === 'terminal') {
    return [
      { label: 'Patch VMs', type: 'patch_vms' },
      { label: 'Inspect logs', type: 'inspect_logs' },
      { label: 'Restart service', type: 'restart_service' },
    ]
  }

  if (activeTab === 'settings') {
    return [
      { label: 'Patch VMs', type: 'patch_vms' },
      { label: 'Test SSH path', type: 'inspect_logs' },
    ]
  }

  return [
    { label: 'Patch VMs', type: 'patch_vms' },
    { label: 'Explain metrics', type: 'explain_metrics' },
    { label: 'Inspect logs', type: 'inspect_logs' },
  ]
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${part}-${index}`} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>
    }

    return part
  })
}

function renderFormattedContent(content: string) {
  const blocks = content.split(/```/)
  const nodes: ReactNode[] = []

  blocks.forEach((block, blockIndex) => {
    if (blockIndex % 2 === 1) {
      const lines = block.replace(/^\w+\n/, '').trim()
      nodes.push(
        <pre key={`code-${blockIndex}`} className="my-2 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-cyan-100">
          {lines}
        </pre>,
      )
      return
    }

    block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .forEach((line, lineIndex) => {
        const key = `line-${blockIndex}-${lineIndex}`
        if (!line) {
          nodes.push(<div key={key} className="h-1" />)
          return
        }

        const heading = line.match(/^#{1,3}\s+(.+)$/)
        if (heading) {
          nodes.push(<h3 key={key} className="mt-2 text-sm font-semibold text-slate-950">{renderInline(heading[1])}</h3>)
          return
        }

        const bullet = line.match(/^[-*]\s+(.+)$/)
        if (bullet) {
          nodes.push(
            <div key={key} className="flex gap-2 leading-relaxed">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
              <span>{renderInline(bullet[1])}</span>
            </div>,
          )
          return
        }

        const numbered = line.match(/^(\d+)\.\s+(.+)$/)
        if (numbered) {
          nodes.push(
            <div key={key} className="grid grid-cols-[1.5rem_1fr] gap-1 leading-relaxed">
              <span className="font-semibold text-cyan-700">{numbered[1]}.</span>
              <span>{renderInline(numbered[2])}</span>
            </div>,
          )
          return
        }

        nodes.push(<p key={key} className="leading-relaxed">{renderInline(line)}</p>)
      })
  })

  return <div className="space-y-1">{nodes}</div>
}

function progressIcon(status: CopilotProgressEvent['status']) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
  }

  if (status === 'failed') {
    return <XCircle className="h-3.5 w-3.5 text-rose-600" aria-hidden="true" />
  }

  return <Circle className="h-3.5 w-3.5 fill-cyan-500 text-cyan-500" aria-hidden="true" />
}

function timestampFromId(id: string, fallback: number) {
  const match = id.match(/-(\d{13})(?:-|$)/)
  return match ? Number(match[1]) : fallback
}

function isRunStart(event: CopilotProgressEvent) {
  return event.title === 'Queued copilot request' || event.title === 'Sending request to copilot'
}

function currentRunEvents(progress: CopilotProgressEvent[]) {
  const latestRunStartIndex = progress.findIndex(isRunStart)
  const currentEvents = latestRunStartIndex >= 0 ? progress.slice(0, latestRunStartIndex + 1) : progress.slice(0, 4)
  return currentEvents.reverse()
}

export function CopilotPanel({
  vm,
  activeTab,
  messages,
  progress,
  proposals,
  isBusy,
  onSendMessage,
  onCreateProposal,
  onConfirmProposal,
}: CopilotPanelProps) {
  const [draft, setDraft] = useState('')
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const vmMessages = useMemo(
    () => messages.filter((message) => !message.contextVmId || message.contextVmId === vm?.id),
    [messages, vm?.id],
  )
  const timeline = useMemo(() => {
    const messageItems = vmMessages.map((message, index) => ({
      kind: 'message' as const,
      id: message.id,
      timestamp: message.timestamp,
      order: timestampFromId(message.id, index),
      message,
    }))
    const progressTrail = currentRunEvents(progress)
    const latestProgress = progressTrail[progressTrail.length - 1]
    const latestUserOrder = messageItems.reduce(
      (latest, item) => (item.message.role === 'user' ? Math.max(latest, item.order) : latest),
      -1,
    )
    const hasAssistantAfterLatestUser =
      latestUserOrder < 0 ||
      messageItems.some((item) => item.message.role === 'assistant' && item.order > latestUserOrder)
    const items: Array<
      | (typeof messageItems)[number]
      | {
          kind: 'progressBox'
          id: string
          timestamp: string
          order: number
          events: CopilotProgressEvent[]
          latest: CopilotProgressEvent
        }
    > = [...messageItems]

    if (latestProgress && (isBusy || latestProgress.status === 'running' || !hasAssistantAfterLatestUser)) {
      const latestProgressOrder = timestampFromId(latestProgress.id, messageItems.length + progressTrail.length)
      items.push({
        kind: 'progressBox',
        id: 'copilot-progress-rolling-box',
        timestamp: latestProgress.timestamp,
        order: Math.max(latestProgressOrder, latestUserOrder + 0.1),
        events: progressTrail,
        latest: latestProgress,
      })
    }

    return items.sort((left, right) => left.order - right.order)
  }, [isBusy, progress, vmMessages])

  useEffect(() => {
    if (bottomRef.current?.scrollIntoView) {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [timeline, isBusy])

  useEffect(() => {
    if (!isResizing) {
      return undefined
    }

    const originalCursor = document.body.style.cursor
    const originalUserSelect = document.body.style.userSelect

    function resize(event: PointerEvent) {
      setPanelWidth(clampPanelWidth(window.innerWidth - event.clientX))
    }

    function stopResize() {
      setIsResizing(false)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize)

    return () => {
      document.body.style.cursor = originalCursor
      document.body.style.userSelect = originalUserSelect
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stopResize)
    }
  }, [isResizing])

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth < 1024) {
      return
    }

    event.preventDefault()
    setPanelWidth(clampPanelWidth(window.innerWidth - event.clientX))
    setIsResizing(true)
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }

    event.preventDefault()
    setPanelWidth((current) => clampPanelWidth(current + (event.key === 'ArrowLeft' ? 24 : -24)))
  }

  function submit() {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }

    onSendMessage(trimmed)
    setDraft('')
  }

  return (
    <aside
      className="relative flex min-h-0 w-full flex-col border-l border-slate-200 bg-slate-50 lg:w-[var(--copilot-panel-width)] lg:flex-none"
      style={{ '--copilot-panel-width': `${panelWidth}px` } as CSSProperties}
    >
      <div
        role="separator"
        aria-label="Resize copilot panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        aria-valuenow={panelWidth}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="group absolute bottom-0 left-0 top-0 z-10 hidden w-3 -translate-x-1.5 cursor-col-resize items-center justify-center outline-none lg:flex"
      >
        <span className="h-10 w-0.5 rounded bg-slate-300 opacity-0 transition group-hover:opacity-100 group-focus:opacity-100" />
      </div>
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded bg-slate-950 text-cyan-300">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-950">VM copilot</h2>
            <p className="truncate text-xs text-slate-500">
              Context: {vm ? `${vm.name} / ${activeTab}` : 'no VM selected'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {suggestionSet(activeTab).map((suggestion) => (
            <button
              key={`${activeTab}-${suggestion.type}`}
              type="button"
              disabled={!vm}
              onClick={() => onCreateProposal(suggestion.type)}
              className="h-7 rounded border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-2">
          {timeline.map((item) => {
            if (item.kind === 'progressBox') {
              const visibleEvents = item.events.filter((event) => event.id !== item.latest.id).slice(-3)
              return (
                <section
                  key={item.id}
                  aria-live="polite"
                  className="mr-auto w-full rounded border border-cyan-200 bg-cyan-50/80 px-3 py-2 text-sm text-slate-700"
                >
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase text-cyan-700">
                    {item.latest.status === 'running' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      progressIcon(item.latest.status)
                    )}
                    Current execution / {item.timestamp}
                  </div>
                  <div className="font-medium text-slate-900">{item.latest.title}</div>
                  {item.latest.detail ? <div className="mt-1 break-words text-xs leading-relaxed text-slate-500">{item.latest.detail}</div> : null}
                  {visibleEvents.length ? (
                    <div className="mt-2 space-y-1 border-t border-cyan-200/80 pt-2">
                      {visibleEvents.map((event) => (
                        <div key={event.id} className="grid grid-cols-[1rem_1fr] gap-2 text-xs text-slate-600">
                          <span className="mt-0.5">{event.status === 'running' ? <Circle className="h-3.5 w-3.5 fill-cyan-500 text-cyan-500" aria-hidden="true" /> : progressIcon(event.status)}</span>
                          <div className="min-w-0 truncate">
                            <span className="font-medium text-slate-800">{event.title}</span>
                            {event.detail ? <span className="text-slate-500"> - {event.detail}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            }

            const message = item.message
            const isAssistant = message.role === 'assistant'
            return (
              <article
                key={message.id}
                className={`rounded border px-3 py-2 text-sm ${
                  isAssistant
                    ? 'mr-auto w-full border-slate-200 bg-white text-slate-700'
                    : 'ml-auto max-w-[92%] border-cyan-200 bg-cyan-600 text-white'
                }`}
              >
                <div className={`mb-1 text-[11px] font-medium uppercase ${isAssistant ? 'text-slate-400' : 'text-cyan-100'}`}>
                  {isAssistant ? 'copilot' : 'you'} / {message.timestamp}
                </div>
                {isAssistant ? renderFormattedContent(message.content) : <p className="leading-relaxed">{message.content}</p>}
              </article>
            )
          })}
        </div>

        <div className="mt-3 space-y-2">
          {proposals.map((proposal) => (
            <article key={proposal.id} className="rounded border border-slate-200 bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-start gap-2">
                <span className="mt-0.5 text-cyan-700">{iconForProposal(proposal.actionType)}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-slate-900">{proposal.title}</h3>
                  <p className="text-xs text-slate-500">{proposal.description}</p>
                </div>
                <span className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">{proposal.risk}</span>
              </div>
              <pre className="mb-2 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-cyan-100">
                {proposal.command}
              </pre>
              {proposal.status === 'executed' ? (
                <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Executed: {proposal.result}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onConfirmProposal(proposal.id)}
                  className="inline-flex h-8 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-2.5 text-xs font-medium text-white transition hover:bg-slate-800"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Confirm action
                </button>
              )}
            </article>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit()
              }
            }}
            className="h-9 min-w-0 flex-1 rounded border border-slate-300 px-3 text-sm outline-none focus:border-cyan-400"
            placeholder={vm ? `Ask about ${vm.name}` : 'Select a VM first'}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!vm}
            className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-900 bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="Send copilot message"
          >
            {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </aside>
  )
}
