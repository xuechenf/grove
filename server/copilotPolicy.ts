import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import type { CopilotScope } from '../src/types'
import { projectStatePath } from './projectState'

interface PolicyRule {
  scope: CopilotScope
  prefix: string
}

/**
 * "Always allow" rules. When the user picks Always allow on a confirmation, a narrow
 * scope+command-prefix rule is stored here; matching future mutating commands auto-approve
 * without a new proposal. Rules are visible and revocable in Settings.
 */
export class CopilotPolicy {
  private rules: PolicyRule[]
  private readonly path: string
  private readonly persist: boolean

  constructor(options: { path?: string; persist?: boolean } = {}) {
    this.path = options.path ?? projectStatePath('copilot', 'policy.yaml')
    this.persist = options.persist ?? true
    this.rules = this.load()
  }

  list() {
    return this.rules
  }

  allows(scope: CopilotScope, command: string) {
    const normalized = command.trim()
    return this.rules.some((rule) => rule.scope === scope && normalized.startsWith(rule.prefix))
  }

  /** Remember a narrow rule from the leading token(s) of an approved command. */
  remember(scope: CopilotScope, command: string) {
    const prefix = commandPrefix(command)
    if (!prefix || this.rules.some((rule) => rule.scope === scope && rule.prefix === prefix)) {
      return
    }
    this.rules = [...this.rules, { scope, prefix }]
    this.save()
  }

  private load(): PolicyRule[] {
    if (!this.persist || !existsSync(this.path)) {
      return []
    }
    try {
      const parsed = parse(readFileSync(this.path, 'utf8')) as { rules?: PolicyRule[] } | null
      return Array.isArray(parsed?.rules) ? parsed!.rules : []
    } catch {
      return []
    }
  }

  private save() {
    if (!this.persist) {
      return
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, stringify({ rules: this.rules }), 'utf8')
  }
}

/** First two tokens of a command, e.g. `systemctl restart` — a deliberately narrow prefix. */
function commandPrefix(command: string) {
  const tokens = command.trim().split(/\s+/).slice(0, 2)
  return tokens.join(' ')
}
