import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Plus, Terminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { apiDisabled, createTerminalSocket } from '../lib/api'
import type { ServerEvent, VM } from '../types'

interface TerminalTabProps {
  vm: VM
  onCommand: (command: string, output: string) => void
}

interface TerminalPane {
  id: string
  title: string
}

interface CommandDispatch {
  paneId: string
  command: string
  sequence: number
}

interface TerminalSessionViewProps {
  vm: VM
  pane: TerminalPane
  active: boolean
  commandDispatch?: CommandDispatch
  onCommand: (command: string, output: string) => void
}

const quickCommands = ['ls', 'uptime', 'df -h', 'systemctl --failed', 'top']

let paneSequence = 0

function nextPane(title?: string): TerminalPane {
  paneSequence += 1
  return {
    id: `term-pane-${Date.now()}-${paneSequence}`,
    title: title ?? `shell ${paneSequence}`,
  }
}

function outputFor(command: string, vm: VM) {
  if (vm.lifecycle !== 'running') {
    return `ssh: connect to host ${vm.connection.host} port ${vm.connection.port}: VM is not running`
  }

  if (command.includes('df')) {
    return `/dev/vda1   ${vm.resources.diskGb}G  ${Math.round(
      (vm.resources.diskGb * vm.metrics.diskPercent) / 100,
    )}G  ${Math.round(vm.resources.diskGb * (1 - vm.metrics.diskPercent / 100))}G  ${vm.metrics.diskPercent}% /`
  }

  if (command.includes('systemctl')) {
    return vm.services
      .filter((service) => service.state !== 'running')
      .map((service) => `${service.name}.service ${service.state}`)
      .join('\n') || '0 loaded units listed.'
  }

  if (command.trim() === 'ls') {
    return 'README.md\npackage.json\nserver\nsrc'
  }

  return `${vm.hostname} up ${vm.metrics.uptime}, load average: ${vm.metrics.loadAverage.join(', ')}`
}

function scrollTerminalToBottom(terminal: XTerm) {
  try {
    terminal.scrollToBottom()
  } catch {
    // xterm can finish a pending write after HMR or teardown has removed renderer dimensions.
  }
}

function writeLines(terminal: XTerm, text: string) {
  terminal.write(text.replace(/\n/g, '\r\n'), () => scrollTerminalToBottom(terminal))
}

function TerminalSessionView({ vm, pane, active, commandDispatch, onCommand }: TerminalSessionViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const promptBufferRef = useRef('')
  // -1 (not 0) so the very first dispatch, which carries sequence 0, is not mistaken
  // for one already handled and dropped.
  const lastDispatchRef = useRef(-1)
  const onCommandRef = useRef(onCommand)
  const vmRef = useRef(vm)
  const [status, setStatus] = useState(apiDisabled() ? 'local mock' : 'connecting')

  useEffect(() => {
    onCommandRef.current = onCommand
  }, [onCommand])

  useEffect(() => {
    vmRef.current = vm
  }, [vm])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return undefined
    }
    const vmId = vm.id
    const vmName = vm.name
    const vmHostname = vm.hostname
    const connectionUser = vm.connection.user

    if (typeof window.matchMedia !== 'function') {
      container.textContent = `Grove local mock shell for ${vmName}.\n${connectionUser}@${vmHostname}:~$ `
      return () => {
        container.textContent = ''
      }
    }

    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: false,
      fontFamily: '"Cascadia Code", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: {
        background: '#ffffff',
        foreground: '#1f2937',
        cursor: '#111827',
        selectionBackground: '#e2e8f0',
        black: '#111827',
        blue: '#334155',
        brightBlue: '#475569',
        brightCyan: '#475569',
        brightGreen: '#047857',
        brightRed: '#be123c',
        cyan: '#475569',
        green: '#059669',
        red: '#e11d48',
        white: '#f8fafc',
        yellow: '#64748b',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal

    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    let dataDisposable: { dispose: () => void } | undefined

    const fitAndResize = () => {
      if (disposed) {
        return
      }

      try {
        fitAddon.fit()
        const socket = socketRef.current
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
        }
      } catch {
        // xterm cannot fit while a hidden panel has no measurable size.
      }
    }

    const writePrompt = () => {
      terminal.write(`\r\n${connectionUser}@${vmHostname}:~$ `)
    }

    const runMockCommand = (command: string) => {
      const output = outputFor(command, vmRef.current)
      writeLines(terminal, `\r\n${output}\r\n`)
      writePrompt()
      onCommandRef.current(command, output)
    }

    window.requestAnimationFrame(() => {
      fitAndResize()

      if (apiDisabled() || typeof WebSocket === 'undefined') {
        setStatus('local mock')
        writeLines(terminal, `Grove local mock shell for ${vmName}.`)
        writePrompt()
        dataDisposable = terminal.onData((data) => {
          if (data === '\r') {
            const command = promptBufferRef.current.trim()
            promptBufferRef.current = ''
            if (command) {
              runMockCommand(command)
              return
            }
            writePrompt()
            return
          }

          if (data === '\u007f') {
            if (promptBufferRef.current.length > 0) {
              promptBufferRef.current = promptBufferRef.current.slice(0, -1)
              terminal.write('\b \b')
            }
            return
          }

          promptBufferRef.current += data
          terminal.write(data)
        })
        return
      }

      try {
        const socket = createTerminalSocket(
          vmId,
          (event: ServerEvent | { type: string; payload: unknown }) => {
            if (event.type === 'terminal.data') {
              const payload = event.payload as { data?: string; output?: string }
              writeLines(terminal, payload.data ?? payload.output ?? '')
              return
            }

            if (event.type === 'terminal.output') {
              const payload = event.payload as { output?: string }
              writeLines(terminal, payload.output ?? '')
              return
            }

            if (event.type === 'terminal.status') {
              const payload = event.payload as { status?: string }
              setStatus(payload.status ?? 'open')
            }
          },
          { cols: terminal.cols, rows: terminal.rows },
        )

        socketRef.current = socket
        dataDisposable = terminal.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }))
          }
        })
        socket.addEventListener('open', () => {
          setStatus('interactive SSH')
          fitAndResize()
        })
        socket.addEventListener('close', () => {
          setStatus('closed')
        })
      } catch (error) {
        setStatus('local fallback')
        writeLines(
          terminal,
          `Grove could not attach the SSH PTY: ${error instanceof Error ? error.message : 'unknown error'}\r\n`,
        )
        writePrompt()
      }
    })

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fitAndResize)
      resizeObserver.observe(container)
    }
    window.addEventListener('resize', fitAndResize)

    return () => {
      disposed = true
      dataDisposable?.dispose()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', fitAndResize)
      socketRef.current?.close()
      socketRef.current = null
      terminal.dispose()
      terminalRef.current = null
    }
  }, [pane.id, vm.id, vm.name, vm.hostname, vm.connection.user, vm.connection.host, vm.connection.port])

  useEffect(() => {
    if (!active) {
      return
    }

    window.requestAnimationFrame(() => {
      const terminal = terminalRef.current
      if (terminal) {
        scrollTerminalToBottom(terminal)
      }
    })
  }, [active])

  useEffect(() => {
    if (!commandDispatch || commandDispatch.paneId !== pane.id || lastDispatchRef.current === commandDispatch.sequence) {
      return
    }

    lastDispatchRef.current = commandDispatch.sequence
    const command = commandDispatch.command.trim()
    if (!command) {
      return
    }

    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'run', command }))
      onCommandRef.current(command, 'Queued in interactive SSH terminal.')
      return
    }

    const terminal = terminalRef.current
    if (terminal) {
      const currentVm = vmRef.current
      terminal.write(command)
      promptBufferRef.current = command
      const output = outputFor(command, currentVm)
      writeLines(terminal, `\r\n${output}\r\n`)
      terminal.write(`\r\n${currentVm.connection.user}@${currentVm.hostname}:~$ `)
      onCommandRef.current(command, output)
    }
  }, [commandDispatch, pane.id])

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-white px-3 py-1.5 text-[11px] text-slate-500">
        <span className="truncate">
          ssh -p {vm.connection.port} {vm.connection.user}@{vm.connection.host}
        </span>
        <span className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-slate-500">{status}</span>
      </div>
      <div ref={containerRef} className="grove-terminal min-h-0 flex-1 overflow-hidden bg-white" />
    </div>
  )
}

export function TerminalTab({ vm, onCommand }: TerminalTabProps) {
  const commandSequenceRef = useRef(0)
  const [panes, setPanes] = useState<TerminalPane[]>(() => [nextPane('shell 1')])
  const [activePaneId, setActivePaneId] = useState(() => panes[0]?.id)
  const [commandDispatch, setCommandDispatch] = useState<CommandDispatch>()

  function addPane() {
    const pane = nextPane(`shell ${panes.length + 1}`)
    setPanes((current) => [...current, pane])
    setActivePaneId(pane.id)
  }

  function closePane(paneId: string) {
    if (panes.length === 1) {
      return
    }

    const closingIndex = panes.findIndex((pane) => pane.id === paneId)
    const nextPanes = panes.filter((pane) => pane.id !== paneId)
    setPanes(nextPanes)
    if (activePaneId === paneId) {
      setActivePaneId(nextPanes[Math.max(0, closingIndex - 1)]?.id ?? nextPanes[0]?.id)
    }
  }

  function runQuickCommand(command: string) {
    if (!activePaneId) {
      return
    }

    setCommandDispatch({
      paneId: activePaneId,
      command,
      sequence: commandSequenceRef.current,
    })
    commandSequenceRef.current += 1
  }

  return (
    <section className="flex h-full min-h-[640px] flex-col rounded border border-slate-200 bg-white" data-testid="terminal-tab">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-slate-900">
          <Terminal className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {vm.connection.user}@{vm.hostname}
            </h2>
            <p className="truncate text-xs text-slate-500">
              Interactive PTY sessions. Copilot runs on separate SSH exec/SFTP channels.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {quickCommands.map((quickCommand) => (
            <button
              key={quickCommand}
              type="button"
              onClick={() => runQuickCommand(quickCommand)}
              className="h-7 rounded border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            >
              {quickCommand}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-100 bg-white px-2 py-1">
          {panes.map((pane) => (
            <button
              key={pane.id}
              type="button"
              onClick={() => setActivePaneId(pane.id)}
              className={`group inline-flex h-8 shrink-0 items-center gap-2 rounded border px-2 text-xs font-medium transition ${
                activePaneId === pane.id
                  ? 'border-slate-300 bg-slate-100 text-slate-950'
                  : 'border-transparent bg-white text-slate-500 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              {pane.title}
              {panes.length > 1 ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${pane.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    closePane(pane.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      closePane(pane.id)
                    }
                  }}
                  className="rounded p-0.5 text-slate-400 hover:bg-white hover:text-rose-600"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            onClick={addPane}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            aria-label="Open terminal tab"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {panes.map((pane) => (
          <TerminalSessionView
            key={pane.id}
            vm={vm}
            pane={pane}
            active={pane.id === activePaneId}
            commandDispatch={commandDispatch}
            onCommand={onCommand}
          />
        ))}
      </div>
    </section>
  )
}
