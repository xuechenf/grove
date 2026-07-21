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

  it('rejects chained commands with a destructive tail', () => {
    expect(isReadOnlyCommand('hostname; reboot')).toBe(false)
    expect(isReadOnlyCommand('cat /etc/hostname; shutdown -h now')).toBe(false)
    expect(isReadOnlyCommand('echo ok && dd if=/dev/zero of=/dev/sda bs=1M')).toBe(false)
    expect(isReadOnlyCommand('uptime && userdel -r bob')).toBe(false)
  })

  it('classifies previously-missed destructive commands as mutating', () => {
    const commands = [
      'reboot',
      'shutdown -h now',
      'halt',
      'poweroff',
      'dd if=/dev/zero of=/dev/sda',
      'mkfs.ext4 /dev/sda1',
      'crontab -r',
      'mount /dev/sdb1 /mnt',
      'userdel -r bob',
      'passwd root',
    ]
    for (const command of commands) {
      expect(classifyCommand(command).mutating).toBe(true)
    }
  })

  it('keeps read-only pipelines read-only when every stage is approved', () => {
    expect(isReadOnlyCommand('ps aux | grep nginx')).toBe(true)
    expect(isReadOnlyCommand('journalctl -n 50 --no-pager | grep error')).toBe(true)
  })

  it('rejects pipelines with a non-approved stage', () => {
    expect(isReadOnlyCommand('echo hi | nc -l 4444')).toBe(false)
  })

  it('rejects command substitution outright', () => {
    expect(isReadOnlyCommand('echo $(date +%s)')).toBe(false)
    expect(isReadOnlyCommand('cat $(shutdown now)')).toBe(false)
    expect(isReadOnlyCommand('echo `whoami`')).toBe(false)
  })
})
