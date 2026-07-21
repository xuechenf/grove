import { describe, expect, it } from 'vitest'
import { CopilotPolicy } from './copilotPolicy'

describe('CopilotPolicy.allows', () => {
  it('auto-approves a remembered prefix', () => {
    const policy = new CopilotPolicy({ persist: false })
    policy.remember('fleet', 'systemctl restart nginx')

    expect(policy.allows('fleet', 'systemctl restart nginx')).toBe(true)
    expect(policy.allows('fleet', 'systemctl restart apache2')).toBe(true)
  })

  it('does not let a remembered prefix cover a chained tail', () => {
    const policy = new CopilotPolicy({ persist: false })
    policy.remember('fleet', 'systemctl restart nginx')

    expect(policy.allows('fleet', 'systemctl restart nginx; rm -rf /var/lib/data')).toBe(false)
    expect(policy.allows('fleet', 'systemctl restart nginx && userdel -r bob')).toBe(false)
  })

  it('allows chains where every segment is read-only or remembered', () => {
    const policy = new CopilotPolicy({ persist: false })
    policy.remember('fleet', 'systemctl restart nginx')

    expect(policy.allows('fleet', 'uptime; systemctl restart nginx')).toBe(true)
  })

  it('rejects command substitution even behind a remembered prefix', () => {
    const policy = new CopilotPolicy({ persist: false })
    policy.remember('fleet', 'systemctl restart nginx')

    expect(policy.allows('fleet', 'systemctl restart $(rm -rf /tmp/x)')).toBe(false)
  })

  it('scopes rules to their copilot scope', () => {
    const policy = new CopilotPolicy({ persist: false })
    policy.remember('fleet', 'systemctl restart nginx')

    expect(policy.allows('vm:vm-1', 'systemctl restart nginx')).toBe(false)
  })
})
