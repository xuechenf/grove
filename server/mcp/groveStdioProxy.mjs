#!/usr/bin/env node
// Self-contained MCP stdio server that kimi-code CLI spawns. It exposes Grove's scoped VM
// tools to the agent and forwards every call to the Grove backend over loopback HTTP, with
// the scope token that pins this session to one context. No project imports: it runs as a
// plain Node ESM script under whatever node kimi finds.
//
// Env:
//   GROVE_MCP_URL          backend base url, e.g. http://127.0.0.1:8787
//   GROVE_MCP_SCOPE_TOKEN  per-scope token issued by the supervisor

import { createInterface } from 'node:readline'

const BASE_URL = (process.env.GROVE_MCP_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const SCOPE_TOKEN = process.env.GROVE_MCP_SCOPE_TOKEN || ''
const PROTOCOL_VERSION = '2024-11-05'
// Backend tool calls (gated fleet apt upgrades, etc.) can legitimately run for minutes. Without
// this, Node fetch's ~300s undici default would abort the call early; the supervisor sets this to
// outlast kimi's own tool-call timeout so the proxy never gives up before kimi would.
const REQUEST_TIMEOUT_MS = Math.max(60000, Number(process.env.GROVE_MCP_PROXY_TIMEOUT_MS) || 960000)

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function backend(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-grove-scope': SCOPE_TOKEN, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`Grove backend ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json()
}

async function listTools() {
  const data = await backend('/api/mcp/tools', { method: 'GET' })
  return Array.isArray(data.tools) ? data.tools : []
}

async function callTool(name, args) {
  const data = await backend('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name, arguments: args || {} }),
  })
  return data.result || { ok: false, summary: 'No result.', error: 'Empty backend response.' }
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'grove', version: '1.0.0' },
      })
      return
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return
    }

    if (method === 'ping') {
      reply(id, {})
      return
    }

    if (method === 'tools/list') {
      const tools = await listTools()
      reply(id, { tools })
      return
    }

    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments || {}
      const result = await callTool(name, args)
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      reply(id, { content: [{ type: 'text', text }], isError: result?.ok === false })
      return
    }

    if (isRequest) {
      replyError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Grove MCP proxy error.'
    if (isRequest) {
      reply(id, { content: [{ type: 'text', text }], isError: true })
    }
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  void handle(message)
})
