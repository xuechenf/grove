import { randomBytes } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { CopilotScope } from '../../src/types'
import type { CopilotToolHost } from '../copilotTypes'
import { buildToolsForScope } from './tools'

/**
 * Maps random per-boot tokens to copilot scopes. A kimi session is handed exactly one
 * token via its MCP config; that token is the only thing that decides which VM tools the
 * session can see. Tokens never appear in agent-readable workspace files.
 */
export class ScopeTokenRegistry {
  private readonly byToken = new Map<string, CopilotScope>()
  private readonly byScope = new Map<CopilotScope, string>()

  tokenForScope(scope: CopilotScope): string {
    const existing = this.byScope.get(scope)
    if (existing) {
      return existing
    }
    const token = randomBytes(18).toString('hex')
    this.byToken.set(token, scope)
    this.byScope.set(scope, token)
    return token
  }

  scopeForToken(token: string | undefined): CopilotScope | undefined {
    return token ? this.byToken.get(token) : undefined
  }
}

export function mountMcpEndpoint(app: Express, host: CopilotToolHost, tokens: ScopeTokenRegistry) {
  function resolveScope(request: Request, response: Response): CopilotScope | undefined {
    const token = request.header('x-grove-scope')
    const scope = tokens.scopeForToken(token)
    if (!scope) {
      response.status(401).json({ error: 'Invalid or missing Grove MCP scope token.' })
      return undefined
    }
    return scope
  }

  app.get('/api/mcp/tools', (request, response) => {
    const scope = resolveScope(request, response)
    if (!scope) {
      return
    }
    const tools = buildToolsForScope(scope, host).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
    response.json({ tools })
  })

  app.post('/api/mcp/call', (request, response) => {
    const scope = resolveScope(request, response)
    if (!scope) {
      return
    }

    const body = (request.body ?? {}) as { name?: unknown; arguments?: unknown }
    const name = typeof body.name === 'string' ? body.name : ''
    const args = (body.arguments && typeof body.arguments === 'object' ? body.arguments : {}) as Record<string, unknown>
    const tool = buildToolsForScope(scope, host).find((candidate) => candidate.name === name)
    if (!tool) {
      response.status(404).json({ error: `Unknown tool ${name} for this scope.` })
      return
    }

    Promise.resolve(tool.run(args))
      .then((result) => response.json({ result }))
      .catch((error: unknown) => {
        response.json({
          result: {
            ok: false,
            summary: 'Tool execution failed.',
            error: error instanceof Error ? error.message : 'Unknown tool error.',
          },
        })
      })
  })
}
