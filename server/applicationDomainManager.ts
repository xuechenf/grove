import { isIP } from 'node:net'
import type { ApplicationDomain, ApplicationDomainInput, GroveApplication, VM } from '../src/types'
import type { ApplicationWorkspace } from './applicationWorkspace'
import { NameComDnsManager, type NameComDnsTarget, type NameComReconcileResult } from './nameComDns'
import type { CredentialManager } from './credentialManager'

export interface ApplicationDnsProvider {
  reconcile(target: NameComDnsTarget, publicIp: string): Promise<NameComReconcileResult>
  remove(target: NameComDnsTarget): Promise<void>
}

interface ApplicationDomainManagerOptions {
  dns?: ApplicationDnsProvider
  onApplicationUpdated?: (application: GroveApplication) => void
}

function failureDetail(error: unknown) {
  return error instanceof Error ? error.message : 'Name.com DNS operation failed.'
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export class ApplicationDomainManager {
  private readonly dns: ApplicationDnsProvider
  private readonly workspace: ApplicationWorkspace
  private readonly resolveVm: (vmId: string) => VM | undefined
  private readonly options: ApplicationDomainManagerOptions

  constructor(
    workspace: ApplicationWorkspace,
    credentials: CredentialManager,
    resolveVm: (vmId: string) => VM | undefined,
    options: ApplicationDomainManagerOptions = {},
  ) {
    this.workspace = workspace
    this.resolveVm = resolveVm
    this.options = options
    this.dns = options.dns ?? new NameComDnsManager(credentials)
  }

  async reconcile(applicationId: string, input: ApplicationDomainInput) {
    const application = this.requireApplication(applicationId)
    const hostname = normalizeHostname(input.hostname)
    const vm = this.requireDeploymentTarget(application, input.vmId)
    if (isIP(vm.ipAddress) !== 4) {
      throw new Error(`The selected VM does not have an IPv4 address that Name.com can use for an A record.`)
    }

    const previous = application.domain
    const sameRecord =
      previous?.hostname === hostname &&
      previous.nameComCredentialProfileId === input.nameComCredentialProfileId

    if (previous?.dnsRecordId && !sameRecord) {
      try {
        await this.dns.remove(previous)
      } catch (error) {
        this.update(applicationId, {
          ...previous,
          dnsStatus: 'failed',
          dnsDetail: `Could not replace the existing domain: ${failureDetail(error)}`,
          updatedAt: new Date().toISOString(),
        })
        throw error
      }
    }

    const pending = this.update(applicationId, {
      hostname,
      nameComCredentialProfileId: input.nameComCredentialProfileId,
      vmId: input.vmId,
      dnsStatus: 'pending',
      ...(sameRecord && previous?.dnsRecordId ? { dnsRecordId: previous.dnsRecordId } : {}),
      dnsDetail: `Reconciling ${hostname} with ${vm.ipAddress}.`,
      updatedAt: new Date().toISOString(),
    })

    try {
      const result = await this.dns.reconcile(pending.domain!, vm.ipAddress)
      return this.update(applicationId, {
        ...pending.domain!,
        dnsStatus: 'ready',
        dnsRecordId: result.recordId,
        dnsDetail: result.detail,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      this.update(applicationId, {
        ...pending.domain!,
        dnsStatus: 'failed',
        dnsDetail: failureDetail(error),
        updatedAt: new Date().toISOString(),
      })
      throw error
    }
  }

  async remove(applicationId: string) {
    const application = this.requireApplication(applicationId)
    if (!application.domain) return application
    try {
      await this.dns.remove(application.domain)
    } catch (error) {
      this.update(applicationId, {
        ...application.domain,
        dnsStatus: 'failed',
        dnsDetail: `The Grove-owned DNS record was not removed: ${failureDetail(error)}`,
        updatedAt: new Date().toISOString(),
      })
      throw error
    }
    const updated = this.workspace.updateApplication(applicationId, () => ({
      domain: undefined,
      updatedAt: new Date().toISOString(),
    }))
    this.options.onApplicationUpdated?.(updated)
    return updated
  }

  private requireApplication(applicationId: string) {
    const application = this.workspace.getApplication(applicationId)
    if (!application) throw new Error('Application not found.')
    return application
  }

  private requireDeploymentTarget(application: GroveApplication, vmId: string) {
    if (!application.instances.some((instance) => instance.vmId === vmId)) {
      throw new Error('Deploy the application to the selected VM before assigning its domain.')
    }
    const vm = this.resolveVm(vmId)
    if (!vm) throw new Error('The selected VM no longer exists.')
    return vm
  }

  private update(applicationId: string, domain: ApplicationDomain) {
    const application = this.workspace.updateApplication(applicationId, () => ({
      domain,
      updatedAt: new Date().toISOString(),
    }))
    this.options.onApplicationUpdated?.(application)
    return application
  }
}
