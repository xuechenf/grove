import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type { VM, VmConfig } from '../src/types'
import { vms as fixtureVms } from '../src/data/fixtures'
import { envFlag } from './env'
import { projectStatePath } from './projectState'

const providerSchema = z
  .object({
    name: z.string().optional(),
    region: z.string().optional(),
    node: z.string().optional(),
  })
  .optional()

const vmConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  user: z.string().min(1),
  port: z.number().int().positive().default(22),
  keyPath: z.string().optional(),
  useAgent: z.boolean().optional(),
  os: z.string().optional(),
  labels: z.array(z.string()).optional(),
  provider: providerSchema,
})

const inventorySchema = z
  .object({
    vms: z.array(vmConfigSchema),
  })
  .strict()

export function defaultInventoryPath() {
  return projectStatePath('inventory.yaml')
}

export function validateInventoryText(text: string) {
  const parsed = parse(text) as unknown
  const rawText = text.toLowerCase()

  if (rawText.includes('privatekey') || rawText.includes('private_key') || rawText.includes('password:')) {
    throw new Error('Inventory must not contain private key material or passwords.')
  }

  return inventorySchema.parse(parsed).vms
}

export function loadInventory(path = defaultInventoryPath()): VmConfig[] {
  if (envFlag('GROVE_USE_FIXTURES')) {
    return fixtureVmConfigs()
  }

  if (!existsSync(path)) {
    return fixtureVmConfigs()
  }

  return validateInventoryText(readFileSync(path, 'utf8'))
}

export function saveInventory(configs: VmConfig[], path = defaultInventoryPath()) {
  const text = stringify({ vms: configs.map(cleanConfigForInventory) })
  validateInventoryText(text)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function cleanConfigForInventory(config: VmConfig): VmConfig {
  return {
    id: config.id,
    name: config.name,
    host: config.host,
    user: config.user,
    port: config.port,
    keyPath: config.keyPath,
    useAgent: config.useAgent,
    os: config.os,
    labels: config.labels,
    provider: config.provider,
  }
}

function fixtureVmConfigs(): VmConfig[] {
  return fixtureVms.map((vm) => ({
    id: vm.id,
    name: vm.name,
    host: vm.connection.host,
    user: vm.connection.user,
    port: vm.connection.port,
    keyPath: vm.connection.keyStatus === 'present' ? `~/.ssh/${vm.connection.keyLabel}` : undefined,
    useAgent: true,
    os: vm.os,
    labels: vm.tags,
    provider: vm.provider,
  }))
}

export function vmFromConfig(config: VmConfig, fixture?: VM): VM {
  const base = fixture ?? fixtureVms[0]

  return {
    ...base,
    id: config.id,
    name: config.name,
    hostname: config.host,
    ipAddress: config.host,
    os: config.os ?? base.os,
    provider: {
      name: config.provider?.name ?? 'SSH',
      region: config.provider?.region ?? 'local',
      node: config.provider?.node ?? 'inventory',
    },
    tags: config.labels ?? [],
    appServices: fixture?.appServices ?? [],
    connection: {
      host: config.host,
      user: config.user,
      port: config.port,
      keyLabel: config.keyPath ?? (config.useAgent ? 'ssh-agent' : 'not configured'),
      keyStatus: config.keyPath || config.useAgent ? 'present' : 'unknown',
      lastConnected: 'not connected',
      testStatus: 'idle',
    },
  }
}
