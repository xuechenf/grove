import type { ApplicationEnvironment } from '../src/types'
import type { CredentialManager } from './credentialManager'

interface NameComRecord {
  id?: number | string
  host?: string
  type?: string
  answer?: string
  ttl?: number
}

export interface NameComReconcileResult {
  recordId: string
  detail: string
}

function authHeader(username: string, token: string) {
  return `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`
}

function relativeHost(hostname: string, domain: string) {
  return hostname === domain ? '@' : hostname.slice(0, -(domain.length + 1))
}

export class NameComDnsManager {
  private readonly credentials: CredentialManager

  constructor(credentials: CredentialManager) {
    this.credentials = credentials
  }

  async reconcile(environment: ApplicationEnvironment, publicIp: string): Promise<NameComReconcileResult> {
    if (!environment.nameComCredentialProfileId || !environment.hostname) {
      throw new Error('Name.com profile and hostname are required.')
    }
    const access = this.access(environment.nameComCredentialProfileId)
    const hostname = environment.hostname.toLowerCase().replace(/\.$/, '')
    const domains = (await this.listAllPages<{ domainName?: string }>(access, '/domains', 'domains'))
      .map((domain) => domain.domainName?.toLowerCase())
      .filter((domain): domain is string => Boolean(domain))
      .filter((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
      .sort((left, right) => right.length - left.length)
    const domain = domains[0]
    if (!domain) {
      throw new Error(`The Name.com profile does not have DNS access to ${hostname}.`)
    }
    const host = relativeHost(hostname, domain)
    const records = await this.listAllPages<NameComRecord>(
      access,
      `/domains/${encodeURIComponent(domain)}/records`,
      'records',
    )
    let existing: NameComRecord | undefined
    if (environment.dnsRecordId) {
      existing = records.find((record) => String(record.id) === environment.dnsRecordId)
      if (!existing) {
        throw new Error('The recorded Grove-owned Name.com record no longer exists. Reconcile it manually before retrying.')
      }
    } else {
      const conflicting = records.find((record) => record.host === host && record.type === 'A')
      if (conflicting) {
        throw new Error(`${hostname} already has an A record that is not owned by this Grove environment.`)
      }
    }

    const recordBody = { host, type: 'A', answer: publicIp, ttl: 300 }
    const response = existing
      ? await this.request<{ id?: number | string; record?: NameComRecord }>(
          access,
          `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(String(existing.id))}`,
          { method: 'PUT', body: JSON.stringify(recordBody) },
        )
      : await this.request<{ id?: number | string; record?: NameComRecord }>(
          access,
          `/domains/${encodeURIComponent(domain)}/records`,
          { method: 'POST', body: JSON.stringify(recordBody) },
        )
    const recordId = String(response.record?.id ?? response.id ?? existing?.id ?? '')
    if (!recordId) {
      throw new Error('Name.com created the record but returned no record ID.')
    }
    return { recordId, detail: `${hostname} points to ${publicIp} with TTL 300.` }
  }

  async remove(environment: ApplicationEnvironment) {
    if (!environment.nameComCredentialProfileId || !environment.hostname || !environment.dnsRecordId) {
      return
    }
    const access = this.access(environment.nameComCredentialProfileId)
    const hostname = environment.hostname.toLowerCase().replace(/\.$/, '')
    const domain = (await this.listAllPages<{ domainName?: string }>(access, '/domains', 'domains'))
      .map((item) => item.domainName?.toLowerCase())
      .filter((item): item is string => Boolean(item))
      .filter((item) => hostname === item || hostname.endsWith(`.${item}`))
      .sort((left, right) => right.length - left.length)[0]
    if (!domain) {
      throw new Error('The Name.com domain is no longer accessible; the recorded DNS entry was not deleted.')
    }
    await this.request(
      access,
      `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(environment.dnsRecordId)}`,
      { method: 'DELETE' },
    )
  }

  private access(profileId: string) {
    const profile = this.credentials.profile(profileId)
    if (profile.kind !== 'name.com') {
      throw new Error('The selected DNS credential is not a Name.com profile.')
    }
    const secrets = this.credentials.secrets(profileId)
    return {
      baseUrl: (profile.configuration.apiBaseUrl || 'https://api.name.com/v4').replace(/\/$/, ''),
      authorization: authHeader(profile.configuration.username!, secrets.apiToken!),
    }
  }

  /**
   * Follow the v4 pagination (nextPage/lastPage) instead of reading only page 1: accounts
   * with more than one page of domains/records otherwise produced false "not found" errors
   * and duplicate A records. Bounded so a misbehaving API cannot loop forever.
   */
  private async listAllPages<T>(
    access: { baseUrl: string; authorization: string },
    path: string,
    key: 'domains' | 'records',
  ): Promise<T[]> {
    const results: T[] = []
    let page = 1
    for (let fetched = 0; fetched < 100; fetched += 1) {
      const payload = await this.request<Record<string, unknown> & { nextPage?: number; lastPage?: number }>(
        access,
        `${path}?page=${page}&perPage=1000`,
      )
      const entries = payload[key]
      if (Array.isArray(entries)) {
        results.push(...(entries as T[]))
      }
      const lastPage = payload.lastPage ?? page
      if (page >= lastPage) {
        break
      }
      page = payload.nextPage ?? page + 1
    }
    return results
  }

  private async request<T = unknown>(
    access: { baseUrl: string; authorization: string },
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${access.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: access.authorization,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      throw new Error(
        `Name.com DNS request failed: ${error instanceof Error ? error.message : 'network error'}`,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new Error(`Name.com DNS request failed (HTTP ${response.status}).`)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }
}
