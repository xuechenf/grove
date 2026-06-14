import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { WebSocket, WebSocketServer } from 'ws'
import type { ServerEvent } from '../src/types'
import { createGroveApp } from './app'
import { generateUiToken, persistUiToken } from './apiToken'
import { envValue, loadLocalEnv } from './env'
import { GroveStore } from './store'

export interface StartGroveServerOptions {
  /** Port to bind. `0` picks a free ephemeral port. Defaults to GROVE_PORT or 8787. */
  port?: number
  /** Host/interface to bind. Defaults to GROVE_HOST or 127.0.0.1. */
  host?: string
  /** Directory of the built Vite UI to serve from the API origin (packaged desktop app). */
  staticDir?: string
}

export interface GroveServerHandle {
  store: GroveStore
  /** Actual bound port (resolved even when `port: 0` was requested). */
  port: number
  host: string
  /** Local URL the UI is reachable at, e.g. http://127.0.0.1:8787. */
  url: string
  /** Stop accepting connections and close the HTTP server. */
  close: () => Promise<void>
}

/**
 * Boot the Grove backend: HTTP API plus the events and terminal WebSocket endpoints. Both the
 * CLI entry (`server/index.ts`) and the Electron main process call this; the only difference is
 * Electron passes `port: 0` (ephemeral) and a `staticDir` so the UI is served same-origin.
 */
export function startGroveServer(options: StartGroveServerOptions = {}): Promise<GroveServerHandle> {
  loadLocalEnv()

  const port = options.port ?? Number(envValue('GROVE_PORT') ?? 8787)
  const host = options.host ?? envValue('GROVE_HOST') ?? '127.0.0.1'
  const uiToken = generateUiToken()
  persistUiToken(uiToken)
  const { app, store } = createGroveApp(new GroveStore(), { uiToken, staticDir: options.staticDir })
  const server = createServer(app)
  const eventsWss = new WebSocketServer({ noServer: true })
  const terminalWss = new WebSocketServer({ noServer: true })

  function send(socket: WebSocket, event: ServerEvent | { type: string; payload: unknown }) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event))
    }
  }

  eventsWss.on('connection', (socket) => {
    send(socket, { type: 'snapshot', payload: store.snapshot() })
    const unsubscribe = store.onEvent((event) => send(socket, event))
    socket.on('close', unsubscribe)
  })

  terminalWss.on('connection', async (socket, request) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    const match = url.pathname.match(/^\/api\/vms\/([^/]+)\/terminal$/)
    const vmId = match?.[1]
    const cols = Math.max(20, Number(url.searchParams.get('cols') ?? 120))
    const rows = Math.max(8, Number(url.searchParams.get('rows') ?? 32))

    if (!vmId) {
      socket.close(1008, 'Missing VM id')
      return
    }

    try {
      const { session, stream } = await store.openTerminalShell(vmId, { cols, rows })
      send(socket, { type: 'terminal.status', payload: session })
      send(socket, {
        type: 'terminal.data',
        payload: {
          sessionId: session.id,
          vmId,
          data: `\r\n\x1b[36mGrove attached interactive SSH PTY for ${vmId}. Copilot actions run on separate exec channels.\x1b[0m\r\n`,
        },
      })

      // Per-stream decoders: PTY chunks can split multi-byte UTF-8 characters, which
      // per-chunk toString() would render as replacement characters in the terminal.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')

      stream.on('data', (data: Buffer) => {
        const text = stdoutDecoder.write(data)
        if (!text) {
          return
        }
        send(socket, {
          type: 'terminal.data',
          payload: {
            sessionId: session.id,
            vmId,
            data: text,
          },
        })
      })

      stream.stderr.on('data', (data: Buffer) => {
        const text = stderrDecoder.write(data)
        if (!text) {
          return
        }
        send(socket, {
          type: 'terminal.data',
          payload: {
            sessionId: session.id,
            vmId,
            data: text,
          },
        })
      })

      stream.on('close', () => {
        send(socket, {
          type: 'terminal.status',
          payload: {
            ...session,
            status: 'closed',
            lastActivityAt: new Date().toISOString(),
          },
        })
        socket.close()
      })

      stream.on('error', (error: Error) => {
        send(socket, {
          type: 'terminal.data',
          payload: {
            sessionId: session.id,
            vmId,
            data: `\r\n${error.message}\r\n`,
          },
        })
        socket.close()
      })

      socket.on('message', async (raw) => {
        try {
          const message = JSON.parse(String(raw)) as {
            type?: string
            data?: string
            command?: string
            cols?: number
            rows?: number
          }
          if (message.type === 'input' && typeof message.data === 'string') {
            stream.write(message.data)
            return
          }

          if (message.type === 'run' && message.command) {
            stream.write(`${message.command}\r`)
            return
          }

          if (message.type === 'resize' && message.cols && message.rows) {
            stream.setWindow(message.rows, message.cols, Math.max(message.rows * 16, 480), Math.max(message.cols * 8, 640))
          }
        } catch (error) {
          send(socket, {
            type: 'terminal.data',
            payload: {
              sessionId: session.id,
              vmId,
              data: `\r\n${error instanceof Error ? error.message : 'Terminal message failed.'}\r\n`,
            },
          })
        }
      })

      socket.on('close', () => {
        stream.end()
      })
    } catch (error) {
      send(socket, {
        type: 'terminal.data',
        payload: {
          sessionId: 'failed',
          vmId,
          data: `\r\n${error instanceof Error ? error.message : 'Terminal failed.'}\r\n`,
        },
      })
    }
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)

    if (url.pathname === '/api/events') {
      eventsWss.handleUpgrade(request, socket, head, (ws) => eventsWss.emit('connection', ws, request))
      return
    }

    if (/^\/api\/vms\/[^/]+\/terminal$/.test(url.pathname)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => terminalWss.emit('connection', ws, request))
      return
    }

    socket.destroy()
  })

  return new Promise<GroveServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const boundPort = (server.address() as AddressInfo).port
      const url = `http://${host}:${boundPort}`
      console.log(`Grove backend listening on ${url}`)
      resolve({
        store,
        port: boundPort,
        host,
        url,
        close: () =>
          new Promise<void>((resolveClose) => {
            eventsWss.close()
            terminalWss.close()
            server.close(() => resolveClose())
          }),
      })
    })
  })
}
