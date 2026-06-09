import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { ServerEvent } from '../src/types'
import { createGroveApp } from './app'
import { envValue, loadLocalEnv } from './env'

loadLocalEnv()

const port = Number(envValue('GROVE_PORT') ?? 8787)
const host = envValue('GROVE_HOST') ?? '127.0.0.1'
const { app, store } = createGroveApp()
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

    stream.on('data', (data: Buffer) => {
      send(socket, {
        type: 'terminal.data',
        payload: {
          sessionId: session.id,
          vmId,
          data: data.toString('utf8'),
        },
      })
    })

    stream.stderr.on('data', (data: Buffer) => {
      send(socket, {
        type: 'terminal.data',
        payload: {
          sessionId: session.id,
          vmId,
          data: data.toString('utf8'),
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

server.listen(port, host, () => {
  console.log(`Grove backend listening on http://${host}:${port}`)
})
