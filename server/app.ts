import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  ActionProposal,
  AlicloudCredentialCsvImport,
  AppRunnerServiceInput,
  AwsCredentialCsvImport,
  CloudFirewallRuleInput,
  CopilotScope,
  CredentialProfileInput,
  GroveApplicationInput,
  TabId,
  TransferJob,
  VmConnectionInput,
} from '../src/types'
import { uiTokenMiddleware } from './apiToken'
import { copilotProviderDefaults } from './copilotProvider'
import { listLocalFiles, localDefaults, openLocalFolder } from './localFiles'
import { mountMcpEndpoint } from './mcp/endpoint'
import { GroveStore } from './store'

const transferRequestSchema = z.object({
  vmId: z.string(),
  direction: z.enum(['upload', 'download']),
  source: z.string(),
  target: z.string(),
  fileName: z.string(),
  conflict: z.enum(['overwrite', 'rename', 'skip']).optional(),
})

const tabSchema = z.enum(['overview', 'monitoring', 'applications', 'files', 'terminal', 'activity', 'settings'])

const appRunnerSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    path: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('github'),
    repoUrl: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  }),
])

const appRunnerServiceSchema = z.object({
  name: z.string().trim().min(1),
  source: appRunnerSourceSchema,
  port: z.coerce.number().int().min(1).max(65535),
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().trim().min(1),
})

const applicationSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), path: z.string().trim().min(1) }),
  z.object({
    type: z.literal('git'),
    repoUrl: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  }),
])

const applicationConfigurationSchema = z.object({
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  artifactPath: z.string().trim().min(1).default('dist'),
  startCommand: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  healthCheckPath: z.string().trim().min(1).refine((value) => value.startsWith('/'), {
    message: 'Health check path must start with /.',
  }),
  healthCheckTimeoutSeconds: z.coerce.number().int().min(1).max(600).default(60),
  environment: z.record(z.string(), z.string()).default({}),
})

const applicationInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  source: applicationSourceSchema,
  configuration: applicationConfigurationSchema,
})

const applicationDeploymentSchema = z.object({
  versionId: z.string().min(1),
  vmIds: z.array(z.string().min(1)).min(1),
  environment: z.string().trim().min(1).default('production'),
})

const infrastructurePlanSchema = z.object({ destroy: z.boolean().default(false) })
const infrastructureApplySchema = z.object({ planOperationId: z.string().min(1) })

const workspaceRelocationSchema = z.object({
  workspacePath: z.string().trim().min(1),
})

const credentialProfileSchema: z.ZodType<CredentialProfileInput> = z.object({
  kind: z.enum(['ssh', 'aws', 'azure', 'alicloud', 'name.com']),
  name: z.string().trim().min(1),
  isDefault: z.boolean().optional(),
  configuration: z.record(z.string(), z.string()).default({}),
  secrets: z.record(z.string(), z.string()).optional(),
})

const awsCredentialCsvImportSchema: z.ZodType<AwsCredentialCsvImport> = z.object({
  name: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  isDefault: z.boolean().optional(),
  csvText: z.string().min(1).max(64 * 1024),
})

const alicloudCredentialCsvImportSchema: z.ZodType<AlicloudCredentialCsvImport> = z.object({
  name: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  isDefault: z.boolean().optional(),
  csvText: z.string().min(1).max(64 * 1024),
})

const cloudFirewallRuleSchema: z.ZodType<CloudFirewallRuleInput> = z.object({
  firewallId: z.string().trim().min(1),
  protocol: z.enum(['tcp', 'udp']),
  fromPort: z.coerce.number().int().min(0).max(65535),
  toPort: z.coerce.number().int().min(0).max(65535),
  cidr: z.string().trim().min(3).max(64),
  description: z.string().trim().max(255).optional(),
})

const cloudPowerSchema = z.object({ action: z.enum(['start', 'stop', 'reboot']) })

const scopeSchema = z.custom<CopilotScope>(
  (value) => typeof value === 'string' && (value === 'fleet' || value.startsWith('vm:')),
  { message: 'scope must be "fleet" or "vm:<id>".' },
)

const copilotMessageSchema = z.object({
  scope: scopeSchema,
  message: z.string().min(1),
  referenceHistory: z.boolean().optional(),
})

const copilotCancelSchema = z.object({
  scope: scopeSchema,
})

const copilotDecisionSchema = z.object({
  decision: z.enum(['allow_once', 'always_allow', 'deny']),
})

const copilotProposalSchema = z.object({
  vmId: z.string(),
  activeTab: tabSchema,
  actionType: z.enum(['inspect_logs', 'restart_service', 'snapshot', 'transfer_file', 'explain_metrics', 'patch_vms']),
})

const copilotProviderSchema = z.object({
  provider: z.enum(['moonshot', 'glm-cn']).default('moonshot'),
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})

const terminalCommandSchema = z.object({
  command: z.string().min(1),
})

const localPathSchema = z.object({
  path: z.string().min(1),
})

const vmConnectionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    ipAddress: z.string().trim().refine((value) => isIP(value) > 0, {
      message: 'Enter a valid IP address.',
    }),
    user: z.string().trim().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535),
    pemPath: z.string().trim(),
    // Auth-mode declaration for VMs without a PEM file: true = ssh-agent, false = keyless.
    useAgent: z.boolean().optional(),
    os: z.string().trim().min(1).optional(),
  })
  // A key file is required unless the caller explicitly declares the auth mode instead.
  .refine((value) => value.pemPath.length > 0 || value.useAgent !== undefined, {
    message: 'Enter a PEM file path.',
    path: ['pemPath'],
  })

type AsyncHandler = (request: Request, response: Response) => Promise<void>
type SyncHandler = (request: Request, response: Response) => void

function errorPayload(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      message: error.issues[0]?.message ?? 'Invalid request.',
    }
  }

  const message = error instanceof Error ? error.message : 'Unknown server error'
  const status = message.includes('not found') || message.includes('Not found') ? 404 : 400
  return { status, message }
}

function sendErrorResponse(response: Response, error: unknown) {
  const { status, message } = errorPayload(error)
  response.status(status).json({ error: message })
}

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response) => {
    handler(request, response).catch((error: unknown) => {
      sendErrorResponse(response, error)
    })
  }
}

function syncRoute(handler: SyncHandler) {
  return (request: Request, response: Response) => {
    try {
      handler(request, response)
    } catch (error) {
      sendErrorResponse(response, error)
    }
  }
}

function requireParam(value: string | string[] | undefined, name: string) {
  if (typeof value !== 'string') {
    throw new Error(`Missing ${name}`)
  }

  return value
}

export interface CreateGroveAppOptions {
  /** When set, mutating routes require this token in the x-grove-token header. */
  uiToken?: string
  /**
   * When set to a directory containing a built Vite UI (an `index.html`), the app serves it as
   * static files with an SPA fallback. Lets the packaged desktop app load the UI from the same
   * origin as the API, so the frontend's relative `/api` and same-origin WebSocket URLs just work.
   */
  staticDir?: string
}

export function createGroveApp(store = new GroveStore(), options: CreateGroveAppOptions = {}) {
  const app = express()

  app.use(express.json())

  // Scoped MCP endpoint (its own scope-token auth) must mount before the UI token gate.
  mountMcpEndpoint(app, store, store.scopeTokens)

  if (options.uiToken) {
    app.use(uiTokenMiddleware(options.uiToken))
  }

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, service: 'grove-backend' })
  })

  app.get('/api/bootstrap', (_request, response) => {
    // Deliberately no token here: the per-boot UI token is delivered out of band (Electron
    // IPC bridge, or the Vite dev middleware reading the local token file), so the HTTP API
    // alone never discloses it. See server/apiToken.ts.
    response.json({ runtime: store.copilotRuntimeStatus() })
  })

  app.get(
    '/api/snapshot',
    asyncRoute(async (_request, response) => {
      await store.refreshAllVmInfoOnce()
      response.json(store.snapshot())
    }),
  )

  app.get(
    '/api/vms',
    asyncRoute(async (_request, response) => {
      await store.refreshAllVmInfoOnce()
      response.json(store.listVms())
    }),
  )

  app.get('/api/settings', (_request, response) => {
    response.json(store.groveSettings())
  })

  app.get('/api/storage/status', (_request, response) => {
    response.json(store.storageStatus())
  })

  app.patch('/api/settings/workspace', (request, response) => {
    const body = workspaceRelocationSchema.parse(request.body)
    response.json(store.relocateWorkspace(body.workspacePath))
  })

  app.post('/api/settings/credentials', (request, response) => {
    const body = credentialProfileSchema.parse(request.body)
    response.status(201).json(store.createCredentialProfile(body))
  })

  app.post(
    '/api/settings/credentials/import/aws-csv',
    asyncRoute(async (request, response) => {
      const body = awsCredentialCsvImportSchema.parse(request.body)
      response.status(201).json(await store.importAwsCredentialCsv(body))
    }),
  )

  app.post(
    '/api/settings/credentials/import/alicloud-csv',
    asyncRoute(async (request, response) => {
      const body = alicloudCredentialCsvImportSchema.parse(request.body)
      response.status(201).json(await store.importAlicloudCredentialCsv(body))
    }),
  )

  app.patch('/api/settings/credentials/:profileId', (request, response) => {
    const profileId = requireParam(request.params.profileId, 'profileId')
    const body = credentialProfileSchema.parse(request.body)
    response.json(store.updateCredentialProfile(profileId, body))
  })

  app.post(
    '/api/settings/credentials/:profileId/test',
    asyncRoute(async (request, response) => {
      const profileId = requireParam(request.params.profileId, 'profileId')
      response.json(await store.testCredentialProfile(profileId))
    }),
  )

  app.delete('/api/settings/credentials/:profileId', (request, response) => {
    const profileId = requireParam(request.params.profileId, 'profileId')
    store.deleteCredentialProfile(profileId)
    response.json({ profileId })
  })

  app.get(
    '/api/cloud/machines',
    asyncRoute(async (request, response) => {
      const profileId = typeof request.query.profileId === 'string' ? request.query.profileId : undefined
      response.json(await store.listCloudMachines(profileId))
    }),
  )

  app.get(
    '/api/vms/:vmId/overview',
    asyncRoute(async (request, response) => {
      const hours = typeof request.query.hours === 'string' ? Number(request.query.hours) : 1
      response.json(await store.getVmOverview(
        requireParam(request.params.vmId, 'vmId'),
        Number.isFinite(hours) ? hours : 1,
      ))
    }),
  )

  app.get(
    '/api/cloud/machines/:machineId/firewall-rules',
    asyncRoute(async (request, response) => {
      response.json(await store.listCloudFirewallRules(requireParam(request.params.machineId, 'machineId')))
    }),
  )

  app.post(
    '/api/cloud/machines/:machineId/firewall-rules',
    asyncRoute(async (request, response) => {
      const input = cloudFirewallRuleSchema.parse(request.body)
      response.status(201).json(
        await store.addCloudFirewallRule(requireParam(request.params.machineId, 'machineId'), input),
      )
    }),
  )

  app.delete(
    '/api/cloud/machines/:machineId/firewall-rules/:ruleId',
    asyncRoute(async (request, response) => {
      response.json(
        await store.removeCloudFirewallRule(
          requireParam(request.params.machineId, 'machineId'),
          requireParam(request.params.ruleId, 'ruleId'),
        ),
      )
    }),
  )

  app.get(
    '/api/cloud/machines/:machineId/metrics',
    asyncRoute(async (request, response) => {
      const hours = typeof request.query.hours === 'string' ? Number(request.query.hours) : undefined
      response.json(
        await store.getCloudMachineMetrics(
          requireParam(request.params.machineId, 'machineId'),
          Number.isFinite(hours) ? hours : undefined,
        ),
      )
    }),
  )

  app.post(
    '/api/cloud/machines/:machineId/power',
    asyncRoute(async (request, response) => {
      const body = cloudPowerSchema.parse(request.body)
      response.json(await store.cloudMachinePower(requireParam(request.params.machineId, 'machineId'), body.action))
    }),
  )

  app.get('/api/applications', (_request, response) => {
    response.json(store.listApplications())
  })

  app.get('/api/infrastructure/terraform/status', (_request, response) => {
    response.json(store.terraformStatus())
  })

  app.post(
    '/api/infrastructure/terraform/install',
    asyncRoute(async (_request, response) => {
      response.json(await store.installTerraform())
    }),
  )

  app.post(
    '/api/applications',
    asyncRoute(async (request, response) => {
      const body = applicationInputSchema.parse(request.body) as GroveApplicationInput
      response.status(201).json(await store.createApplication(body))
    }),
  )

  app.get('/api/applications/:applicationId', (request, response) => {
    const application = store.getApplication(request.params.applicationId)
    if (!application) {
      response.status(404).json({ error: 'Application not found' })
      return
    }
    response.json(application)
  })

  app.patch('/api/applications/:applicationId', (request, response) => {
    const body = applicationInputSchema.parse(request.body) as GroveApplicationInput
    response.json(store.updateApplication(request.params.applicationId, body))
  })

  app.post(
    '/api/applications/:applicationId/source/sync',
    asyncRoute(async (request, response) => {
      response.json(await store.syncApplicationSource(requireParam(request.params.applicationId, 'applicationId')))
    }),
  )

  app.post(
    '/api/applications/:applicationId/builds',
    asyncRoute(async (request, response) => {
      response.status(201).json(await store.buildApplication(requireParam(request.params.applicationId, 'applicationId')))
    }),
  )

  app.post(
    '/api/applications/:applicationId/deployments',
    asyncRoute(async (request, response) => {
      const body = applicationDeploymentSchema.parse(request.body)
      response.status(201).json(
        await store.deployApplication(
          requireParam(request.params.applicationId, 'applicationId'),
          body.versionId,
          body.vmIds,
          body.environment,
        ),
      )
    }),
  )

  app.get(
    '/api/applications/:applicationId/logs',
    asyncRoute(async (request, response) => {
      const vmId = typeof request.query.vmId === 'string' ? request.query.vmId : undefined
      if (!vmId) {
        throw new Error('Missing vmId')
      }
      const lines = typeof request.query.lines === 'string' ? Number(request.query.lines) : undefined
      response.json(
        await store.readApplicationLogs(
          requireParam(request.params.applicationId, 'applicationId'),
          vmId,
          Number.isFinite(lines) ? lines : undefined,
        ),
      )
    }),
  )

  app.post('/api/applications/:applicationId/environments', (_request, response) => {
    response.status(403).json({ error: 'Cloud resource creation is disabled. Grove manages existing resources only.' })
  })

  app.post(
    '/api/applications/:applicationId/environments/:environmentId/plan',
    asyncRoute(async (request, response) => {
      const applicationId = requireParam(request.params.applicationId, 'applicationId')
      const environmentId = requireParam(request.params.environmentId, 'environmentId')
      const body = infrastructurePlanSchema.parse(request.body ?? {})
      if (!body.destroy) {
        response.status(403).json({ error: 'Cloud resource creation is disabled. Only destroy plans are allowed.' })
        return
      }
      response.status(201).json(await store.planApplicationEnvironment(applicationId, environmentId, body.destroy))
    }),
  )

  app.post(
    '/api/applications/:applicationId/environments/:environmentId/apply',
    asyncRoute(async (request, response) => {
      const applicationId = requireParam(request.params.applicationId, 'applicationId')
      const environmentId = requireParam(request.params.environmentId, 'environmentId')
      const body = infrastructureApplySchema.parse(request.body)
      response.status(201).json(
        await store.applyApplicationEnvironment(applicationId, environmentId, body.planOperationId),
      )
    }),
  )

  app.post('/api/vms', (request, response) => {
    const body = vmConnectionSchema.parse(request.body) as VmConnectionInput
    response.status(201).json(store.createVm(body))
  })

  app.get(
    '/api/vms/:vmId',
    asyncRoute(async (request, response) => {
      response.json(await store.refreshVmInfo(requireParam(request.params.vmId, 'vmId')))
    }),
  )

  app.patch('/api/vms/:vmId', (request, response) => {
    const body = vmConnectionSchema.parse(request.body) as VmConnectionInput
    response.json(store.updateVm(requireParam(request.params.vmId, 'vmId'), body))
  })

  app.get('/api/vms/:vmId/metrics', (request, response) => {
    const vm = store.getVm(request.params.vmId)
    if (!vm) {
      response.status(404).json({ error: 'VM not found' })
      return
    }

    response.json(vm.metrics)
  })

  app.get(
    '/api/vms/:vmId/app-services',
    asyncRoute(async (request, response) => {
      response.json(await store.listAppRunnerServices(requireParam(request.params.vmId, 'vmId')))
    }),
  )

  app.post(
    '/api/vms/:vmId/app-services',
    asyncRoute(async (request, response) => {
      const body = appRunnerServiceSchema.parse(request.body) as AppRunnerServiceInput
      response.status(201).json(await store.createAppRunnerService(requireParam(request.params.vmId, 'vmId'), body))
    }),
  )

  app.patch(
    '/api/vms/:vmId/app-services/:serviceName',
    asyncRoute(async (request, response) => {
      const body = appRunnerServiceSchema.parse(request.body) as AppRunnerServiceInput
      response.json(
        await store.updateAppRunnerService(
          requireParam(request.params.vmId, 'vmId'),
          requireParam(request.params.serviceName, 'serviceName'),
          body,
        ),
      )
    }),
  )

  app.delete(
    '/api/vms/:vmId/app-services/:serviceName',
    asyncRoute(async (request, response) => {
      response.json(
        await store.removeAppRunnerService(
          requireParam(request.params.vmId, 'vmId'),
          requireParam(request.params.serviceName, 'serviceName'),
        ),
      )
    }),
  )

  app.post(
    '/api/vms/:vmId/actions/reboot',
    asyncRoute(async (request, response) => {
      response.json(await store.rebootVm(requireParam(request.params.vmId, 'vmId')))
    }),
  )

  app.delete('/api/vms/:vmId', (request, response) => {
    try {
      response.json(store.deleteVm(request.params.vmId))
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : 'VM not found' })
    }
  })

  app.get(
    '/api/vms/:vmId/files',
    asyncRoute(async (request, response) => {
      const path = typeof request.query.path === 'string' ? request.query.path : '/'
      response.json(await store.listFiles(requireParam(request.params.vmId, 'vmId'), path))
    }),
  )

  app.get('/api/local/files', syncRoute((request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : process.cwd()
    response.json(listLocalFiles(path))
  }))

  app.get('/api/local/defaults', (_request, response) => {
    response.json(localDefaults())
  })

  app.post('/api/local/open-folder', syncRoute((request, response) => {
    const body = localPathSchema.parse(request.body)
    response.json(openLocalFolder(body.path))
  }))

  app.post(
    '/api/vms/:vmId/commands',
    asyncRoute(async (request, response) => {
      const body = terminalCommandSchema.parse(request.body)
      response.json(await store.runTerminalCommand(requireParam(request.params.vmId, 'vmId'), body.command))
    }),
  )

  app.get('/api/transfers', (_request, response) => {
    response.json(store.snapshot().transfers)
  })

  app.post(
    '/api/transfers',
    asyncRoute(async (request, response) => {
      const body = transferRequestSchema.parse(request.body) as {
        vmId: string
        direction: TransferJob['direction']
        source: string
        target: string
        fileName: string
        conflict?: TransferJob['conflict']
      }
      response.status(201).json(await store.createTransfer(body))
    }),
  )

  app.post(
    '/api/copilot/messages',
    asyncRoute(async (request, response) => {
      const body = copilotMessageSchema.parse(request.body)
      response.status(201).json(await store.sendCopilotMessage(body))
    }),
  )

  app.post('/api/copilot/cancel', (request, response) => {
    const body = copilotCancelSchema.parse(request.body)
    response.json(store.cancelCopilot(body.scope))
  })

  app.get('/api/copilot/provider', (_request, response) => {
    response.json(store.copilotProviderStatus())
  })

  app.get('/api/copilot/runtime', (_request, response) => {
    response.json(store.copilotRuntimeStatus())
  })

  app.post(
    '/api/copilot/install',
    asyncRoute(async (_request, response) => {
      response.json(await store.installKimi())
    }),
  )

  app.post('/api/copilot/provider', (request, response) => {
    const body = copilotProviderSchema.parse(request.body)
    const defaults = copilotProviderDefaults(body.provider)
    response.json(
      store.configureCopilotProvider({
        provider: body.provider,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl ?? defaults.baseUrl,
        model: body.model ?? defaults.model,
      }),
    )
  })

  app.post('/api/copilot/proposals', (request, response) => {
    const body = copilotProposalSchema.parse(request.body) as {
      vmId: string
      activeTab: TabId
      actionType: ActionProposal['actionType']
    }
    response.status(201).json(store.createCopilotProposal(body))
  })

  app.post(
    '/api/copilot/proposals/:proposalId/decision',
    asyncRoute(async (request, response) => {
      const body = copilotDecisionSchema.parse(request.body)
      response.json(await store.decideProposal(requireParam(request.params.proposalId, 'proposalId'), body.decision))
    }),
  )

  app.post(
    '/api/copilot/proposals/:proposalId/confirm',
    asyncRoute(async (request, response) => {
      response.json(await store.decideProposal(requireParam(request.params.proposalId, 'proposalId'), 'allow_once'))
    }),
  )

  // Serve the built UI (packaged desktop app) from the same origin as the API. Mounted after
  // the API routes so `/api/*` always wins; the SPA fallback only answers non-API GET requests,
  // leaving unknown `/api/*` paths to 404 as JSON. GET is already exempt from the UI-token gate.
  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
    // Resolve to absolute: express.static would otherwise resolve against cwd, and res.sendFile
    // rejects relative paths outright.
    const staticDir = resolve(options.staticDir)
    app.use(express.static(staticDir))
    app.get(/^\/(?!api\/).*/, (_request, response) => {
      response.sendFile(join(staticDir, 'index.html'))
    })
  }

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next
    sendErrorResponse(response, error)
  })

  return { app, store }
}
