import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyAzureCapabilities = vi.hoisted(() => vi.fn())

vi.mock('./azureCloudAdapter', () => ({ verifyAzureCapabilities }))

import { ProviderCredentialTester } from './providerCredentialTester'

describe('Azure credential capability test', () => {
  beforeEach(() => verifyAzureCapabilities.mockReset())

  it('reports read capabilities without returning the client secret', async () => {
    verifyAzureCapabilities.mockResolvedValue({ vmCount: 2, nsgCount: 3, metricsVerified: true })
    const result = await new ProviderCredentialTester().test({
      profile: {
        id: 'credential-azure', kind: 'azure', name: 'Azure', isDefault: true, secretConfigured: true,
        configuration: { tenantId: 'tenant', clientId: 'client', subscriptionId: 'subscription' },
        createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      },
      secrets: { clientSecret: 'TEST_ONLY_CLIENT_SECRET' },
    })

    expect(result.detail).toContain('2 VMs and 3 NSGs readable')
    expect(result.detail).toContain('Write permissions are checked when power or NSG actions are used')
    expect(JSON.stringify(result)).not.toContain('TEST_ONLY_CLIENT_SECRET')
    expect(verifyAzureCapabilities).toHaveBeenCalledWith(expect.objectContaining({ secrets: { clientSecret: 'TEST_ONLY_CLIENT_SECRET' } }))
  })
})
