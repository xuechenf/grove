import { describe, expect, it } from 'vitest'
import { formatFirewallRule } from './format'

describe('formatFirewallRule', () => {
  it('renders provider all-traffic sentinels readably', () => {
    expect(formatFirewallRule({ protocol: '-1', fromPort: -1, toPort: -1 })).toBe('all traffic')
    expect(formatFirewallRule({ protocol: 'all' })).toBe('all traffic')
  })

  it('preserves normal protocol and port ranges', () => {
    expect(formatFirewallRule({ protocol: 'TCP', fromPort: 443, toPort: 443 })).toBe('tcp 443-443')
    expect(formatFirewallRule({ protocol: 'icmp', fromPort: -1, toPort: -1 })).toBe('icmp all ports')
  })
})
