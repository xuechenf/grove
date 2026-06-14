import { describe, expect, it } from 'vitest'
import { classifyCommand, isReadOnlyCommand } from './commandProfiles'

describe('command classification', () => {
  it('treats space-less output redirections as mutating', () => {
    expect(classifyCommand('echo x>/tmp/p').mutating).toBe(true)
    expect(isReadOnlyCommand('echo x>/tmp/p')).toBe(false)
  })

  it('treats fd-prefixed redirections to a file as mutating', () => {
    expect(classifyCommand('cmd 2>/tmp/log').mutating).toBe(true)
    expect(classifyCommand('cmd 2>>/tmp/log').mutating).toBe(true)
  })

  it('still allows fd duplication, which writes nothing', () => {
    expect(classifyCommand('cmd 2>&1').mutating).toBe(false)
  })

  it('leaves genuinely read-only commands untouched', () => {
    expect(isReadOnlyCommand('uptime')).toBe(true)
    expect(isReadOnlyCommand('df -h')).toBe(true)
    expect(classifyCommand('uptime').mutating).toBe(false)
  })
})
