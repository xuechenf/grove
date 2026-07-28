import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { CredentialProfile, CredentialProfileTestResult } from '../src/types'
import { verifyAzureCapabilities } from './azureCloudAdapter'

interface TestContext {
  profile: CredentialProfile
  secrets: Record<string, string>
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, value: string, encoding?: 'hex') {
  const digest = createHmac('sha256', key).update(value, 'utf8')
  return encoding === 'hex' ? digest.digest('hex') : digest.digest()
}

function awsSigningKey(secret: string, date: string, region: string) {
  const dateKey = hmac(`AWS4${secret}`, date)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, 'sts')
  return hmac(serviceKey, 'aws4_request')
}

function xmlValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))
  return match?.[1]
}

function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

async function fetchChecked(url: string, init: RequestInit, provider: string) {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    throw new Error(
      `${provider} credential check could not reach the provider API: ${error instanceof Error ? error.message : 'network error'}`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(`${provider} rejected the credential profile (HTTP ${response.status}).`)
  }
  return response
}

async function testAws({ profile, secrets }: TestContext) {
  const region = profile.configuration.region || 'us-east-1'
  const china = region.startsWith('cn-')
  const host = `sts.${region}.amazonaws.com${china ? '.cn' : ''}`
  const endpoint = `https://${host}/`
  const body = 'Action=GetCallerIdentity&Version=2011-06-15'
  const now = new Date()
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = dateTime.slice(0, 8)
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host,
    'x-amz-date': dateTime,
  }
  if (secrets.sessionToken) {
    headers['x-amz-security-token'] = secrets.sessionToken
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.trim()}\n`)
    .join('')
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n')
  const scope = `${shortDate}/${region}/sts/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', awsSigningKey(secrets.secretAccessKey!, shortDate, region))
    .update(stringToSign, 'utf8')
    .digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${profile.configuration.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const response = await fetchChecked(endpoint, {
    method: 'POST',
    headers: { ...headers, authorization },
    body,
  }, 'AWS')
  const xml = await response.text()
  const accountId = xmlValue(xml, 'Account')
  const arn = xmlValue(xml, 'Arn')
  if (!accountId || !arn) {
    throw new Error('AWS returned an unexpected identity response.')
  }
  return { detail: `AWS identity verified for account ${accountId}.`, identity: { accountId, arn } }
}

async function testAzure({ profile, secrets }: TestContext) {
  const subscriptionId = profile.configuration.subscriptionId!
  const capabilities = await verifyAzureCapabilities({ profile, secrets })
  const metricDetail = capabilities.metricsVerified ? ' Azure Monitor metrics verified.' : ' No VM exists, so metrics were not queried.'
  return {
    detail: `Azure subscription access verified: ${capabilities.vmCount} VM${capabilities.vmCount === 1 ? '' : 's'} and ${capabilities.nsgCount} NSG${capabilities.nsgCount === 1 ? '' : 's'} readable.${metricDetail} Write permissions are checked when power or NSG actions are used.`,
    identity: {
      subscriptionId,
      azureVmCount: String(capabilities.vmCount),
      azureNsgCount: String(capabilities.nsgCount),
      azureMetricsVerified: String(capabilities.metricsVerified),
    },
  }
}

async function testAlicloud({ profile, secrets }: TestContext) {
  const parameters: Record<string, string> = {
    AccessKeyId: profile.configuration.accessKeyId!,
    Action: 'GetCallerIdentity',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2015-04-01',
  }
  if (secrets.securityToken) {
    parameters.SecurityToken = secrets.securityToken
  }
  const canonicalQuery = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join('&')
  const stringToSign = `GET&%2F&${percentEncode(canonicalQuery)}`
  const signature = createHmac('sha1', `${secrets.accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64')
  const response = await fetchChecked(
    `https://sts.aliyuncs.com/?${canonicalQuery}&Signature=${percentEncode(signature)}`,
    { method: 'GET' },
    'Alibaba Cloud',
  )
  const identity = (await response.json()) as { AccountId?: string; Arn?: string; IdentityType?: string }
  if (!identity.AccountId || !identity.Arn) {
    throw new Error('Alibaba Cloud returned an unexpected identity response.')
  }
  return {
    detail: `Alibaba Cloud identity verified for account ${identity.AccountId}.`,
    identity: {
      accountId: identity.AccountId,
      arn: identity.Arn,
      identityType: identity.IdentityType ?? 'unknown',
    },
  }
}

async function testNameCom({ profile, secrets }: TestContext) {
  const baseUrl = (profile.configuration.apiBaseUrl || 'https://api.name.com/v4').replace(/\/$/, '')
  const authorization = Buffer.from(`${profile.configuration.username}:${secrets.apiToken}`, 'utf8').toString('base64')
  const response = await fetchChecked(`${baseUrl}/domains?page=1&perPage=1000`, {
    headers: { authorization: `Basic ${authorization}` },
  }, 'Name.com')
  const payload = (await response.json()) as { domains?: Array<{ domainName?: string }> }
  const domains = (payload.domains ?? []).map((domain) => domain.domainName).filter((value): value is string => Boolean(value))
  return {
    detail: `Name.com verified with access to ${domains.length} domain${domains.length === 1 ? '' : 's'}.`,
    identity: { verifiedDomains: domains.join(',') },
  }
}

export class ProviderCredentialTester {
  async test(context: TestContext): Promise<Pick<CredentialProfileTestResult, 'detail' | 'identity'>> {
    switch (context.profile.kind) {
      case 'aws':
        return testAws(context)
      case 'azure':
        return testAzure(context)
      case 'alicloud':
        return testAlicloud(context)
      case 'name.com':
        return testNameCom(context)
      default:
        return { detail: 'Credential profile is complete and available to Grove.' }
    }
  }
}
