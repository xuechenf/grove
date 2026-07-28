import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { vms as fixtureVms } from '../src/data/fixtures'
import { createGroveApp } from './app'
import { ApplicationWorkspace } from './applicationWorkspace'
import { MockSshSessionManager } from './sshSessionManager'
import { GroveStore } from './store'
import type { TerraformExecutor, TerraformPlanResult } from './terraformRunner'
import type { ApplicationDnsProvider } from './applicationDomainManager'

const originalUseFixtures = process.env.GROVE_USE_FIXTURES
const temporaryDirectories: string[] = []

class MockTerraform implements TerraformExecutor {
  installCalls = 0

  status() {
    return { available: true, executable: 'mock-terraform', version: '1.15.8', detail: 'Terraform is ready.' }
  }

  async install() {
    this.installCalls += 1
    return this.status()
  }

  async plan(_directory: string, _environment: NodeJS.ProcessEnv, destroy = false): Promise<TerraformPlanResult> {
    return {
      planDigest: destroy ? 'sha256:destroy-plan' : 'sha256:create-plan',
      planFileName: destroy ? 'destroy.tfplan' : 'tfplan',
      changes: destroy ? { add: 0, change: 0, destroy: 7 } : { add: 7, change: 0, destroy: 0 },
      log: destroy ? 'Plan: 0 to add, 0 to change, 7 to destroy.' : 'Plan: 7 to add, 0 to change, 0 to destroy.',
    }
  }

  async apply(_directory: string, expectedPlanDigest: string) {
    return {
      outputs:
        expectedPlanDigest === 'sha256:destroy-plan'
          ? {}
          : { public_ip: '203.0.113.45', private_ip: '10.42.1.4' },
      log: 'Apply complete.',
    }
  }
}

function createTestApp(terraform?: TerraformExecutor, applicationDns?: ApplicationDnsProvider) {
  const root = mkdtempSync(join(tmpdir(), 'grove-application-api-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'dist', 'index.js'), 'console.log("ok")\n')
  const workspace = new ApplicationWorkspace({
    settingsPath: join(root, 'state', 'settings.yaml'),
    workspacePath: join(root, 'workspace'),
  })
  const store = new GroveStore(new MockSshSessionManager(), { applicationWorkspace: workspace, terraform, applicationDns })
  return { ...createGroveApp(store), source }
}

beforeEach(() => {
  process.env.GROVE_USE_FIXTURES = 'true'
})

afterAll(() => {
  if (originalUseFixtures === undefined) {
    delete process.env.GROVE_USE_FIXTURES
  } else {
    process.env.GROVE_USE_FIXTURES = originalUseFixtures
  }
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('application API', () => {
  it('creates, builds, and deploys an application without changing the VM inventory', async () => {
    const { app, source } = createTestApp()
    const originalVmIds = (await request(app).get('/api/vms').expect(200)).body.map((vm: { id: string }) => vm.id)

    const created = await request(app)
      .post('/api/applications')
      .send({
        name: 'Example API',
        source: { type: 'local', path: source },
        configuration: {
          artifactPath: 'dist',
          startCommand: 'node index.js',
          port: 8080,
          healthCheckPath: '/healthz',
          healthCheckTimeoutSeconds: 15,
          environment: {},
        },
      })
      .expect(201)

    const built = await request(app).post(`/api/applications/${created.body.id}/builds`).expect(201)
    expect(built.body.status).toBe('succeeded')

    const deployed = await request(app)
      .post(`/api/applications/${created.body.id}/deployments`)
      .send({ versionId: built.body.id, vmIds: [fixtureVms[0]!.id], environment: 'production' })
      .expect(201)
    expect(deployed.body.deployment.status).toBe('succeeded')

    const snapshot = await request(app).get('/api/snapshot').expect(200)
    expect(snapshot.body.applications).toHaveLength(1)
    expect(snapshot.body.settings.workspacePath).toContain('workspace')
    expect(snapshot.body.vms.map((vm: { id: string }) => vm.id)).toEqual(originalVmIds)
  })

  it('rejects deployment to an unknown VM before changing application state', async () => {
    const { app, source } = createTestApp()
    const created = await request(app)
      .post('/api/applications')
      .send({
        name: 'Worker',
        source: { type: 'local', path: source },
        configuration: {
          artifactPath: 'dist',
          startCommand: 'node index.js',
          port: 9090,
          healthCheckPath: '/healthz',
          healthCheckTimeoutSeconds: 15,
          environment: {},
        },
      })
      .expect(201)
    const built = await request(app).post(`/api/applications/${created.body.id}/builds`).expect(201)

    await request(app)
      .post(`/api/applications/${created.body.id}/deployments`)
      .send({ versionId: built.body.id, vmIds: ['vm-missing'] })
      .expect(404)

    const application = await request(app).get(`/api/applications/${created.body.id}`).expect(200)
    expect(application.body.deployments).toEqual([])
    expect(application.body.instances).toEqual([])
  })

  it('configures and removes a Name.com domain for a deployed VM', async () => {
    const calls: Array<{ operation: string; hostname?: string; publicIp?: string; recordId?: string }> = []
    const dns: ApplicationDnsProvider = {
      async reconcile(target, publicIp) {
        calls.push({ operation: 'reconcile', hostname: target.hostname, publicIp, recordId: target.dnsRecordId })
        return { recordId: 'record-42', detail: `${target.hostname} points to ${publicIp} with TTL 300.` }
      },
      async remove(target) {
        calls.push({ operation: 'remove', hostname: target.hostname, recordId: target.dnsRecordId })
      },
    }
    const { app, source } = createTestApp(undefined, dns)
    const created = await request(app)
      .post('/api/applications')
      .send({
        name: 'Domain API',
        source: { type: 'local', path: source },
        configuration: {
          artifactPath: 'dist',
          startCommand: 'node index.js',
          port: 8080,
          healthCheckPath: '/healthz',
          healthCheckTimeoutSeconds: 15,
          environment: {},
        },
      })
      .expect(201)
    const built = await request(app).post(`/api/applications/${created.body.id}/builds`).expect(201)
    await request(app)
      .post(`/api/applications/${created.body.id}/deployments`)
      .send({ versionId: built.body.id, vmIds: [fixtureVms[0]!.id], environment: 'production' })
      .expect(201)

    const configured = await request(app)
      .put(`/api/applications/${created.body.id}/domain`)
      .send({
        hostname: 'App.Example.com.',
        nameComCredentialProfileId: 'namecom-profile',
        vmId: fixtureVms[0]!.id,
      })
      .expect(200)
    expect(configured.body.domain).toMatchObject({
      hostname: 'app.example.com',
      dnsStatus: 'ready',
      dnsRecordId: 'record-42',
      vmId: fixtureVms[0]!.id,
    })
    expect(calls[0]).toMatchObject({
      operation: 'reconcile',
      hostname: 'app.example.com',
      publicIp: fixtureVms[0]!.ipAddress,
    })

    const removed = await request(app).delete(`/api/applications/${created.body.id}/domain`).expect(200)
    expect(removed.body.domain).toBeUndefined()
    expect(calls[1]).toEqual({
      operation: 'remove',
      hostname: 'app.example.com',
      recordId: 'record-42',
    })
  })
})

describe('credential profile API', () => {
  it('stores write-only cloud secrets outside settings snapshots', async () => {
    const { app } = createTestApp()
    const created = await request(app)
      .post('/api/settings/credentials')
      .send({
        kind: 'aws',
        name: 'AWS production',
        isDefault: true,
        configuration: { accessKeyId: 'AKIAEXAMPLE', region: 'us-east-1' },
        secrets: { secretAccessKey: 'never-return-this' },
      })
      .expect(201)

    expect(created.body.secretConfigured).toBe(true)
    expect(created.body.configuration.accessKeyId).toBe('AKIAEXAMPLE')
    expect(JSON.stringify(created.body)).not.toContain('never-return-this')

    const settings = await request(app).get('/api/settings').expect(200)
    expect(settings.body.credentialProfiles).toHaveLength(1)
    expect(JSON.stringify(settings.body)).not.toContain('never-return-this')

    const updated = await request(app)
      .patch(`/api/settings/credentials/${created.body.id}`)
      .send({
        kind: 'aws',
        name: 'AWS primary',
        configuration: { accessKeyId: 'AKIAEXAMPLE', region: 'us-west-2' },
      })
      .expect(200)
    expect(updated.body.secretConfigured).toBe(true)

    await request(app).delete(`/api/settings/credentials/${created.body.id}`).expect(200)
    expect((await request(app).get('/api/settings').expect(200)).body.credentialProfiles).toEqual([])
  })

  it('validates an SSH key path without returning key material', async () => {
    const { app, source } = createTestApp()
    const keyPath = join(source, 'test-key.pem')
    writeFileSync(keyPath, 'fake key material for path validation only')
    const created = await request(app)
      .post('/api/settings/credentials')
      .send({
        kind: 'ssh',
        name: 'Default SSH',
        configuration: { keyPath, username: 'ubuntu' },
      })
      .expect(201)

    const tested = await request(app).post(`/api/settings/credentials/${created.body.id}/test`).expect(200)
    expect(tested.body.status).toBe('passed')
    expect(tested.body.detail).toContain('readable')
  })
})

describe('Terraform environment API', () => {
  it('exposes the Terraform runtime status and installer through the local API', async () => {
    const terraform = new MockTerraform()
    const { app } = createTestApp(terraform)

    const status = await request(app).get('/api/infrastructure/terraform/status').expect(200)
    expect(status.body).toMatchObject({ available: true, version: '1.15.8' })

    const installed = await request(app).post('/api/infrastructure/terraform/install').expect(200)
    expect(installed.body).toMatchObject({ available: true, executable: 'mock-terraform' })
    expect(terraform.installCalls).toBe(1)
  })

  it('rejects cloud resource creation and leaves pre-existing VM records unchanged', async () => {
    const { app, source } = createTestApp(new MockTerraform())
    const privateKeyPath = join(source, '..', 'terraform-test.pem')
    const publicKeyPath = `${privateKeyPath}.pub`
    writeFileSync(privateKeyPath, 'mock private key')
    writeFileSync(publicKeyPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGrovetest grove@test\n')

    const sshProfile = await request(app)
      .post('/api/settings/credentials')
      .send({
        kind: 'ssh',
        name: 'Terraform SSH',
        configuration: { keyPath: privateKeyPath, publicKeyPath, username: 'ubuntu' },
      })
      .expect(201)
    const awsProfile = await request(app)
      .post('/api/settings/credentials')
      .send({
        kind: 'aws',
        name: 'AWS test',
        configuration: { accessKeyId: 'AKIAEXAMPLE', region: 'us-east-1' },
        secrets: { secretAccessKey: 'secret-value-for-test' },
      })
      .expect(201)
    const application = await request(app)
      .post('/api/applications')
      .send({
        name: 'Terraform App',
        source: { type: 'local', path: source },
        configuration: {
          artifactPath: '.',
          startCommand: 'node index.js',
          port: 8080,
          healthCheckPath: '/',
          healthCheckTimeoutSeconds: 15,
          environment: {},
        },
      })
      .expect(201)
    const originalVmIds = (await request(app).get('/api/vms').expect(200)).body.map((vm: { id: string }) => vm.id)

    const rejected = await request(app)
      .post(`/api/applications/${application.body.id}/environments`)
      .send({
        name: 'Production AWS',
        provider: 'aws',
        region: 'us-east-1',
        providerCredentialProfileId: awsProfile.body.id,
        sshCredentialProfileId: sshProfile.body.id,
        vmName: 'terraform-app-prod',
        instanceType: 't3.small',
        imageId: 'ami-example',
        systemUser: 'ubuntu',
        diskSizeGb: 20,
        assignPublicIp: true,
        ingressRules: [
          { description: 'SSH', protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['0.0.0.0/0'] },
          { description: 'Application', protocol: 'tcp', fromPort: 8080, toPort: 8080, cidrs: ['0.0.0.0/0'] },
        ],
      })
      .expect(403)

    expect(rejected.body.error).toContain('creation is disabled')
    const finalVmIds = (await request(app).get('/api/vms').expect(200)).body.map((vm: { id: string }) => vm.id)
    expect(finalVmIds).toEqual(originalVmIds)
  })
})
