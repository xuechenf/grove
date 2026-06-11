import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

/**
 * Minimal Agent Client Protocol (ACP) connection over a child process's stdio. ACP is
 * newline-delimited JSON-RPC 2.0: the client (Grove) drives the agent (kimi acp) with
 * requests, receives `session/update` notifications, and answers server->client requests
 * such as `session/request_permission`.
 */

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type NotificationHandler = (method: string, params: unknown) => void
export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly reader: Interface
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private notificationHandler?: NotificationHandler
  private requestHandler?: RequestHandler
  private closed = false

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.onLine(line))
    child.on('exit', () => this.onClosed(new Error('ACP agent process exited.')))
    child.on('error', (error) => this.onClosed(error instanceof Error ? error : new Error(String(error))))
  }

  onNotification(handler: NotificationHandler) {
    this.notificationHandler = handler
  }

  onRequest(handler: RequestHandler) {
    this.requestHandler = handler
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('ACP connection is closed.'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    if (this.closed) {
      return
    }
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: JsonRpcMessage) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return
    }

    // Response to one of our requests.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const entry = this.pending.get(message.id)
      if (!entry) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(message.error.message))
      } else {
        entry.resolve(message.result)
      }
      return
    }

    // Server -> client request (expects a response).
    if (message.method && message.id !== undefined) {
      void this.dispatchRequest(message.id, message.method, message.params)
      return
    }

    // Notification.
    if (message.method) {
      this.notificationHandler?.(message.method, message.params)
    }
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown) {
    if (!this.requestHandler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `No handler for ${method}` } })
      return
    }
    try {
      const result = await this.requestHandler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : 'Handler failed.' },
      })
    }
  }

  private onClosed(error: Error) {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const entry of this.pending.values()) {
      entry.reject(error)
    }
    this.pending.clear()
    this.reader.close()
  }

  isClosed() {
    return this.closed
  }
}
