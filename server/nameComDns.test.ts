import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationEnvironment, CredentialProfile } from '../src/types'
import type { CredentialManager } from './credentialManager'
import { NameComDnsManager } from './nameComDns'

const profile: CredentialProfile = {
  id: 'name-profile',
  kind: 'name.com',
  name: 'Name.com production',
  isDefault: true,
  secretConfigured: true,
  configuration: { username: 'grove-user', apiBaseUrl: 'https://api.name.test/v4' },
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}

function credentials() {
  return {
    profile: () => profile,
    secrets: () => ({ apiToken: 'write-only-token' }),
  } as unknown as CredentialManager
}

function environment(overrides: Partial<ApplicationEnvironment> = {}): ApplicationEnvironment {
  return {
    id: 'environment-1',
    slug: 'production',
    name: 'Production',
    provider: 'aws',
    region: 'us-east-1',
    providerCredentialProfileId: 'aws-profile',
    sshCredentialProfileId: 'ssh-profile',
    vmName: 'example-production',
    instanceType: 't3.small',
    imageId: 'ami-example',
    systemUser: 'ubuntu',
    diskSizeGb: 20,
    assignPublicIp: true,
    ingressRules: [],
    nameComCredentialProfileId: profile.id,
    hostname: 'api.example.com',
    dnsStatus: 'pending',
    status: 'ready',
    vmIds: ['vm-example'],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    operations: [],
    ...overrides,
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NameComDnsManager', () => {
  it('creates and later deletes only the record ID owned by the Grove environment', async () => {
    const calls: Array<{ url: string; method: string; authorization?: string }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      if (url.endsWith('/domains?page=1&perPage=1000')) return json({ domains: [{ domainName: 'example.com' }] })
      if (url.endsWith('/domains/example.com/records?page=1&perPage=1000')) return json({ records: [] })
      if (url.endsWith('/domains/example.com/records') && method === 'POST') return json({ id: 42 })
      if (url.endsWith('/domains/example.com/records/42') && method === 'DELETE') return new Response(null, { status: 204 })
      return json({ error: 'unexpected request' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const manager = new NameComDnsManager(credentials())

    const reconciled = await manager.reconcile(environment(), '203.0.113.45')
    expect(reconciled.recordId).toBe('42')
    await manager.remove(environment({ dnsStatus: 'ready', dnsRecordId: reconciled.recordId }))

    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/records'))).toBe(true)
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/records/42'))).toBe(true)
    expect(calls.every((call) => call.authorization?.startsWith('Basic '))).toBe(true)
  })

  it('refuses to overwrite a pre-existing A record not owned by Grove', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/domains?page=1&perPage=1000')) return json({ domains: [{ domainName: 'example.com' }] })
      return json({ records: [{ id: 9, host: 'api', type: 'A', answer: '192.0.2.10' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new NameComDnsManager(credentials()).reconcile(environment(), '203.0.113.45'))
      .rejects.toThrow('not owned by this Grove environment')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('follows pagination when matching the domain and scanning for conflicting records', async () => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/domains?page=1&perPage=1000')) {
        return json({ domains: [{ domainName: 'other-example.org' }], nextPage: 2, lastPage: 2 })
      }
      if (url.endsWith('/domains?page=2&perPage=1000')) {
        return json({ domains: [{ domainName: 'example.com' }], lastPage: 2 })
      }
      if (url.endsWith('/domains/example.com/records?page=1&perPage=1000')) {
        return json({ records: [], nextPage: 2, lastPage: 2 })
      }
      if (url.endsWith('/domains/example.com/records?page=2&perPage=1000')) {
        return json({ records: [{ id: 9, host: 'api', type: 'A', answer: '192.0.2.10' }], lastPage: 2 })
      }
      return json({ error: 'unexpected request' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    // The conflicting A record only exists on page 2: page-1-only scanning would miss it
    // and create a duplicate.
    await expect(new NameComDnsManager(credentials()).reconcile(environment(), '203.0.113.45'))
      .rejects.toThrow('not owned by this Grove environment')
    expect(requested).toContain('https://api.name.test/v4/domains?page=2&perPage=1000')
    expect(requested).toContain('https://api.name.test/v4/domains/example.com/records?page=2&perPage=1000')
  })

  it('removes a record whose domain sits beyond page 1', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/domains?page=1&perPage=1000')) {
        return json({ domains: [{ domainName: 'unrelated.org' }], nextPage: 2, lastPage: 2 })
      }
      if (url.endsWith('/domains?page=2&perPage=1000')) {
        return json({ domains: [{ domainName: 'example.com' }], lastPage: 2 })
      }
      if (url.endsWith('/domains/example.com/records/42') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return json({ error: 'unexpected request' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    await new NameComDnsManager(credentials()).remove(environment({ dnsStatus: 'ready', dnsRecordId: '42' }))

    expect(calls).toContain('DELETE https://api.name.test/v4/domains/example.com/records/42')
  })
})
