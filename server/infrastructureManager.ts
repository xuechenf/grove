import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type {
  ApplicationEnvironment,
  ApplicationEnvironmentInput,
  GroveApplication,
  InfrastructureOperation,
  InfrastructureProvider,
  VmConnectionInput,
} from '../src/types'
import type { ApplicationWorkspace } from './applicationWorkspace'
import type { CredentialManager } from './credentialManager'
import { terraformTemplate } from './terraformTemplates'
import { TerraformRunner, type TerraformExecutor } from './terraformRunner'
import { NameComDnsManager, type NameComReconcileResult } from './nameComDns'

interface DnsManager {
  reconcile(environment: ApplicationEnvironment, publicIp: string): Promise<NameComReconcileResult>
  remove(environment: ApplicationEnvironment): Promise<void>
}

interface InfrastructureManagerOptions {
  terraform?: TerraformExecutor
  dns?: DnsManager
  onApplicationUpdated?: (application: GroveApplication) => void
  createVm: (input: VmConnectionInput, provider: InfrastructureProvider, region: string) => { id: string }
  removeVm: (vmId: string) => void
}

function nowIso() {
  return new Date().toISOString()
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
}

function outputString(value: unknown) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string')
  return undefined
}

function redact(value: string, secrets: Record<string, string>) {
  return Object.values(secrets)
    .filter((secret) => secret.length >= 4)
    .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
}

export class InfrastructureManager {
  private readonly workspace: ApplicationWorkspace
  private readonly credentials: CredentialManager
  private readonly terraform: TerraformExecutor
  private readonly options: InfrastructureManagerOptions
  private readonly active = new Set<string>()
  private readonly dns: DnsManager

  constructor(
    workspace: ApplicationWorkspace,
    credentials: CredentialManager,
    options: InfrastructureManagerOptions,
  ) {
    this.workspace = workspace
    this.credentials = credentials
    this.options = options
    this.terraform = options.terraform ?? new TerraformRunner()
    this.dns = options.dns ?? new NameComDnsManager(credentials)
  }

  terraformStatus() {
    return this.terraform.status()
  }

  async installTerraform() {
    if (!this.terraform.install) {
      throw new Error('This Terraform runtime cannot be installed automatically.')
    }
    return this.terraform.install()
  }

  createEnvironment(applicationId: string, input: ApplicationEnvironmentInput) {
    void applicationId
    void input
    throw new Error('Cloud resource creation is disabled. Grove manages existing resources only.')
  }

  async plan(applicationId: string, environmentId: string, destroy = false) {
    if (!destroy) {
      throw new Error('Cloud resource creation is disabled. Only destroy plans for existing managed environments are allowed.')
    }
    return this.withLock(environmentId, async () => {
      let application = this.requireApplication(applicationId)
      let environment = this.requireEnvironment(application, environmentId)
      const operation = this.newOperation(destroy ? 'destroy-plan' : 'plan', environment)
      environment = { ...environment, operations: [operation, ...environment.operations], updatedAt: nowIso() }
      application = this.saveEnvironment(application, environment)
      const directory = this.terraformDirectory(application, environment)
      let secretValues: Record<string, string> = {}
      try {
        secretValues = this.writeConfiguration(environment, directory)
        const result = await this.terraform.plan(directory, this.terraformEnvironment(environment), destroy)
        this.writeOperationLog(application, operation, redact(result.log, secretValues))
        const completed: InfrastructureOperation = {
          ...operation,
          status: 'succeeded',
          completedAt: nowIso(),
          planDigest: result.planDigest,
          planRelativePath: relative(this.workspace.applicationDirectory(application), join(directory, result.planFileName)),
          changes: result.changes,
        }
        environment = {
          ...environment,
          status: destroy ? 'destroy_planned' : 'planned',
          operations: environment.operations.map((item) => (item.id === completed.id ? completed : item)),
          updatedAt: nowIso(),
        }
        application = this.saveEnvironment(application, environment)
        return { application, environment: this.requireEnvironment(application, environmentId), operation: completed }
      } catch (error) {
        const failure = redact(error instanceof Error ? error.message : 'Terraform plan failed.', secretValues)
        this.writeOperationLog(application, operation, failure)
        const failed = { ...operation, status: 'failed' as const, completedAt: nowIso(), failure }
        environment = {
          ...environment,
          status: 'failed',
          operations: environment.operations.map((item) => (item.id === failed.id ? failed : item)),
          updatedAt: nowIso(),
        }
        this.saveEnvironment(application, environment)
        throw new Error(failure, { cause: error })
      }
    })
  }

  async apply(applicationId: string, environmentId: string, planOperationId: string) {
    return this.withLock(environmentId, async () => {
      let application = this.requireApplication(applicationId)
      let environment = this.requireEnvironment(application, environmentId)
      const plan = environment.operations.find((operation) => operation.id === planOperationId)
      if (!plan || !plan.planDigest || plan.status !== 'succeeded' || plan.kind !== 'destroy-plan') {
        throw new Error('Only a successful reviewed destroy plan can be applied in existing-resource mode.')
      }
      const destroying = plan.kind === 'destroy-plan'
      const operation = this.newOperation(destroying ? 'destroy-apply' : 'apply', environment)
      environment = {
        ...environment,
        status: 'provisioning',
        operations: [operation, ...environment.operations],
        updatedAt: nowIso(),
      }
      application = this.saveEnvironment(application, environment)
      const directory = this.terraformDirectory(application, environment)
      let secretValues: Record<string, string> = {}
      try {
        secretValues = this.credentialSecrets(environment)
        const result = await this.terraform.apply(directory, plan.planDigest, this.terraformEnvironment(environment))
        this.writeOperationLog(application, operation, redact(result.log, secretValues))
        let vmIds = environment.vmIds
        let publicIp = environment.publicIp
        let privateIp = environment.privateIp
        let dnsStatus = environment.dnsStatus
        let dnsRecordId = environment.dnsRecordId
        let dnsDetail = environment.dnsDetail
        if (destroying) {
          for (const vmId of vmIds) {
            this.options.removeVm(vmId)
          }
          vmIds = []
          publicIp = undefined
          privateIp = undefined
          if (environment.dnsRecordId) {
            try {
              await this.dns.remove(environment)
              dnsStatus = environment.hostname ? 'pending' : 'not_configured'
              dnsRecordId = undefined
              dnsDetail = environment.hostname ? 'DNS record removed with the environment.' : undefined
            } catch (error) {
              dnsStatus = 'failed'
              dnsDetail = error instanceof Error ? error.message : 'Name.com DNS removal failed.'
            }
          }
        } else {
          publicIp = outputString(result.outputs.public_ip) || undefined
          privateIp = outputString(result.outputs.private_ip) || undefined
          const connectionIp = publicIp || privateIp
          if (!connectionIp) {
            throw new Error('Terraform applied successfully but returned no VM IP address.')
          }
          if (vmIds.length === 0) {
            const sshProfile = this.credentials.profile(environment.sshCredentialProfileId)
            const pemPath = sshProfile.configuration.keyPath
            if (!pemPath) {
              throw new Error('The SSH profile needs a private key path before Grove can register the VM.')
            }
            const vm = this.options.createVm(
              {
                name: environment.vmName,
                ipAddress: connectionIp,
                user: environment.systemUser,
                port: 22,
                pemPath,
                os: 'Ubuntu Linux',
              },
              environment.provider,
              environment.region,
            )
            vmIds = [vm.id]
          }
          if (environment.nameComCredentialProfileId && environment.hostname && publicIp) {
            try {
              const dns = await this.dns.reconcile(environment, publicIp)
              dnsStatus = 'ready'
              dnsRecordId = dns.recordId
              dnsDetail = dns.detail
            } catch (error) {
              dnsStatus = 'failed'
              dnsDetail = error instanceof Error ? error.message : 'Name.com DNS reconciliation failed.'
            }
          }
        }
        const completed = { ...operation, status: 'succeeded' as const, completedAt: nowIso() }
        environment = {
          ...environment,
          status: destroying ? 'draft' : 'ready',
          vmIds,
          publicIp,
          privateIp,
          dnsStatus,
          dnsRecordId,
          dnsDetail,
          operations: environment.operations.map((item) => (item.id === completed.id ? completed : item)),
          updatedAt: nowIso(),
        }
        application = this.saveEnvironment(application, environment)
        return { application, environment: this.requireEnvironment(application, environmentId), operation: completed }
      } catch (error) {
        const failure = redact(error instanceof Error ? error.message : 'Terraform apply failed.', secretValues)
        this.writeOperationLog(application, operation, failure)
        const failed = { ...operation, status: 'failed' as const, completedAt: nowIso(), failure }
        environment = {
          ...environment,
          status: 'failed',
          operations: environment.operations.map((item) => (item.id === failed.id ? failed : item)),
          updatedAt: nowIso(),
        }
        this.saveEnvironment(application, environment)
        throw new Error(failure, { cause: error })
      }
    })
  }

  private newOperation(kind: InfrastructureOperation['kind'], environment: ApplicationEnvironment): InfrastructureOperation {
    const id = uniqueId('infra')
    return {
      id,
      kind,
      status: 'running',
      createdAt: nowIso(),
      logRelativePath: join('.grove', 'environments', environment.id, 'operations', `${id}.log`),
    }
  }

  private writeConfiguration(environment: ApplicationEnvironment, directory: string) {
    mkdirSync(directory, { recursive: true })
    const sshProfile = this.credentials.profile(environment.sshCredentialProfileId)
    const publicKeyPath = sshProfile.configuration.publicKeyPath ||
      (sshProfile.configuration.keyPath ? `${sshProfile.configuration.keyPath}.pub` : undefined)
    if (!publicKeyPath || !existsSync(publicKeyPath)) {
      throw new Error('The SSH profile needs a readable public key path for Terraform provisioning.')
    }
    const publicKey = readFileSync(publicKeyPath, 'utf8')
    const configuration = terraformTemplate(environment, publicKey)
    writeFileSync(join(directory, 'main.tf.json'), `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
    return this.credentialSecrets(environment)
  }

  private terraformEnvironment(environment: ApplicationEnvironment): NodeJS.ProcessEnv {
    const profile = this.credentials.profile(environment.providerCredentialProfileId)
    const secrets = this.credentials.secrets(profile.id)
    switch (environment.provider) {
      case 'aws':
        return {
          AWS_ACCESS_KEY_ID: profile.configuration.accessKeyId,
          AWS_SECRET_ACCESS_KEY: secrets.secretAccessKey,
          AWS_SESSION_TOKEN: secrets.sessionToken,
          AWS_REGION: environment.region,
        }
      case 'azure':
        return {
          ARM_TENANT_ID: profile.configuration.tenantId,
          ARM_CLIENT_ID: profile.configuration.clientId,
          ARM_CLIENT_SECRET: secrets.clientSecret,
          ARM_SUBSCRIPTION_ID: profile.configuration.subscriptionId,
        }
      case 'alicloud':
        return {
          ALICLOUD_ACCESS_KEY: profile.configuration.accessKeyId,
          ALICLOUD_SECRET_KEY: secrets.accessKeySecret,
          ALICLOUD_SECURITY_TOKEN: secrets.securityToken,
          ALICLOUD_REGION: environment.region,
        }
    }
  }

  private credentialSecrets(environment: ApplicationEnvironment) {
    return this.credentials.secrets(environment.providerCredentialProfileId)
  }

  private requireApplication(applicationId: string) {
    const application = this.workspace.getApplication(applicationId)
    if (!application) throw new Error('Application not found')
    return application
  }

  private requireEnvironment(application: GroveApplication, environmentId: string) {
    const environment = application.environments.find((item) => item.id === environmentId)
    if (!environment) throw new Error('Application environment not found')
    return environment
  }

  private saveEnvironment(application: GroveApplication, environment: ApplicationEnvironment) {
    const next = this.workspace.updateApplication(application.id, (current) => ({
      environments: [environment, ...current.environments.filter((item) => item.id !== environment.id)],
    }))
    this.options.onApplicationUpdated?.(next)
    return next
  }

  private terraformDirectory(application: GroveApplication, environment: ApplicationEnvironment) {
    const directory = join(this.workspace.environmentDirectory(application, environment.id), 'terraform')
    mkdirSync(directory, { recursive: true })
    return directory
  }

  private writeOperationLog(
    application: GroveApplication,
    operation: InfrastructureOperation,
    contents: string,
  ) {
    const path = join(this.workspace.applicationDirectory(application), operation.logRelativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
  }

  private async withLock<T>(environmentId: string, operation: () => Promise<T>) {
    if (this.active.has(environmentId)) {
      throw new Error('Another infrastructure operation is already running for this environment.')
    }
    this.active.add(environmentId)
    try {
      return await operation()
    } finally {
      this.active.delete(environmentId)
    }
  }
}
