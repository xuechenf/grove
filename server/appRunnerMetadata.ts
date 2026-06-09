import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type { AppRunnerService } from '../src/types'
import { projectStatePath } from './projectState'

const appRunnerSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal('github'),
    repoUrl: z.string().min(1),
    ref: z.string().min(1).optional(),
  }),
])

const appRunnerServiceSchema = z.object({
  id: z.string().min(1),
  vmId: z.string().min(1),
  name: z.string().min(1),
  source: appRunnerSourceSchema,
  port: z.number().int().min(1).max(65535),
  remotePath: z.string().min(1),
  unitName: z.string().min(1),
  accessUrl: z.string().min(1),
  state: z.enum(['running', 'degraded', 'stopped', 'unknown']),
  pid: z.number().int().positive().optional(),
  cpuPercent: z.number(),
  memoryMb: z.number(),
  listening: z.boolean(),
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastDeployStatus: z.enum(['pending', 'completed', 'failed']),
  lastDeploySummary: z.string(),
})

const appRunnerFileSchema = z
  .object({
    services: z.array(appRunnerServiceSchema).default([]),
  })
  .strict()

export function defaultAppRunnerPath() {
  return projectStatePath('apprunner.yaml')
}

export function validateAppRunnerText(text: string) {
  const parsed = parse(text) as unknown
  return appRunnerFileSchema.parse(parsed).services
}

export function loadAppRunnerServices(path = defaultAppRunnerPath()): AppRunnerService[] {
  if (!existsSync(path)) {
    return []
  }

  return validateAppRunnerText(readFileSync(path, 'utf8')) as AppRunnerService[]
}

export function saveAppRunnerServices(services: AppRunnerService[], path = defaultAppRunnerPath()) {
  const text = stringify({ services: services.map(cleanServiceForStorage) })
  validateAppRunnerText(text)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function cleanServiceForStorage(service: AppRunnerService): AppRunnerService {
  return {
    id: service.id,
    vmId: service.vmId,
    name: service.name,
    source: service.source,
    port: service.port,
    remotePath: service.remotePath,
    unitName: service.unitName,
    accessUrl: service.accessUrl,
    state: service.state,
    pid: service.pid,
    cpuPercent: service.cpuPercent,
    memoryMb: service.memoryMb,
    listening: service.listening,
    installCommand: service.installCommand,
    buildCommand: service.buildCommand,
    startCommand: service.startCommand,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    lastDeployStatus: service.lastDeployStatus,
    lastDeploySummary: service.lastDeploySummary,
  }
}
