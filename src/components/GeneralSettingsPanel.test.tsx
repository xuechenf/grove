import { describe, expect, it } from 'vitest'
import { azureIamCommands } from '../lib/azureIam'

describe('Azure IAM onboarding commands', () => {
  it('generates subscription-scoped least-privilege commands without embedding a secret', () => {
    const commands = azureIamCommands('00000000-1111-2222-3333-444444444444', 'abc12345')

    expect(commands).toContain('$scope = "/subscriptions/00000000-1111-2222-3333-444444444444"')
    expect(commands).toContain('--name "grove-local-abc12345"')
    expect(commands).toContain('--role "Monitoring Reader"')
    expect(commands).toContain('--role "Virtual Machine Contributor"')
    expect(commands).toContain('--role "Network Contributor"')
    expect(commands).not.toContain('Owner')
    expect(commands).not.toMatch(/client[_ -]?secret|password/i)
  })

  it('uses a safe placeholder until the subscription ID is valid', () => {
    expect(azureIamCommands('bad"; Remove-Item C:\\', 'abc12345')).toContain('/subscriptions/<subscription-id>')
  })
})
