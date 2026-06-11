import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import type { NextFunction, Request, Response } from 'express'
import { projectStatePath } from './projectState'

/**
 * Per-boot UI bearer token. Mutating HTTP routes require it; it is handed to the React UI
 * at page load and never written into any copilot workspace, MCP config, or agent context.
 *
 * This is defense-in-depth for a single-user local tool: a co-resident agent process runs
 * as the same OS user and could in principle forge browser headers, so this is not an
 * absolute boundary. Its job is to make the scoped MCP endpoint the *only* convenient path
 * a copilot has to a VM, and to stop accidental or prompt-injected `curl localhost` calls
 * from reaching mutating routes. The agent never learns the token.
 */
export function generateUiToken() {
  return randomBytes(24).toString('hex')
}

/** Persist the token so the dev Vite middleware (and diagnostics) can read it locally. */
export function persistUiToken(token: string) {
  const path = projectStatePath('runtime', 'ui-token')
  mkdirSync(projectStatePath('runtime'), { recursive: true })
  writeFileSync(path, token, 'utf8')
  try {
    chmodSync(path, 0o600)
  } catch {
    // chmod is a best-effort hardening step; ignore on platforms that reject it.
  }
  return path
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Routes that must stay reachable without the token: the bootstrap handshake that delivers
 * it, health checks, and the scoped MCP endpoint (which carries its own scope token).
 */
function isExempt(request: Request) {
  if (!MUTATING_METHODS.has(request.method)) {
    return true
  }

  const path = request.path
  return path === '/api/bootstrap' || path === '/api/health' || path.startsWith('/api/mcp')
}

export function uiTokenMiddleware(token: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (isExempt(request)) {
      next()
      return
    }

    const provided = request.header('x-grove-token')
    if (provided && timingSafeEqualString(provided, token)) {
      next()
      return
    }

    response.status(401).json({ error: 'Missing or invalid Grove session token.' })
  }
}

function timingSafeEqualString(a: string, b: string) {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}
