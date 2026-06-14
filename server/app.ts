import express, { type NextFunction, type Request, type Response } from 'express'
import { isIP } from 'node:net'
import { z } from 'zod'
import type {
  ActionProposal,
  AppRunnerServiceInput,
  CopilotScope,
  TabId,
  TransferJob,
  VmConnectionInput,
} from '../src/types'
import { uiTokenMiddleware } from './apiToken'
import { listLocalFiles, localDefaults, openLocalFolder } from './localFiles'
import { mountMcpEndpoint } from './mcp/endpoint'
import { GroveStore } from './store'

const transferRequestSchema = z.object({
  vmId: z.string(),
  direction: z.enum(['upload', 'download', 'copy']),
  source: z.string(),
  target: z.string(),
  fileName: z.string(),
  conflict: z.enum(['overwrite', 'rename', 'skip']).optional(),
})

const tabSchema = z.enum(['overview', 'files', 'terminal', 'apprunner', 'activity', 'settings'])

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
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1).default('https://api.moonshot.cn/v1'),
  model: z.string().min(1).default('kimi-k2.6'),
})

const terminalCommandSchema = z.object({
  command: z.string().min(1),
})

const localPathSchema = z.object({
  path: z.string().min(1),
})

const vmConnectionSchema = z.object({
  name: z.string().trim().min(1).optional(),
  ipAddress: z.string().trim().refine((value) => isIP(value) > 0, {
    message: 'Enter a valid IP address.',
  }),
  user: z.string().trim().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535),
  pemPath: z.string().trim().min(1),
  os: z.string().trim().min(1).optional(),
})

type AsyncHandler = (request: Request, response: Response) => Promise<void>

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

function requireParam(value: string | string[] | undefined, name: string) {
  if (typeof value !== 'string') {
    throw new Error(`Missing ${name}`)
  }

  return value
}

export interface CreateGroveAppOptions {
  /** When set, mutating routes require this token in the x-grove-token header. */
  uiToken?: string
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
    response.json({ token: options.uiToken ?? null, runtime: store.copilotRuntimeStatus() })
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

  app.get('/api/local/files', (request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : process.cwd()
    response.json(listLocalFiles(path))
  })

  app.get('/api/local/defaults', (_request, response) => {
    response.json(localDefaults())
  })

  app.post('/api/local/open-folder', (request, response) => {
    const body = localPathSchema.parse(request.body)
    response.json(openLocalFolder(body.path))
  })

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

  app.post('/api/copilot/provider', (request, response) => {
    const body = copilotProviderSchema.parse(request.body)
    response.json(
      store.configureCopilotProvider({
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        model: body.model,
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

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next
    sendErrorResponse(response, error)
  })

  return { app, store }
}
