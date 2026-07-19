import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { envValue } from './env'
import { projectStatePath } from './projectState'
import type { TerraformChangeSummary, TerraformRuntimeStatus } from '../src/types'

export interface TerraformPlanResult {
  planDigest: string
  planFileName: string
  changes: TerraformChangeSummary
  log: string
}

export interface TerraformApplyResult {
  outputs: Record<string, unknown>
  log: string
}

export interface TerraformExecutor {
  status(): TerraformRuntimeStatus
  install?(): Promise<TerraformRuntimeStatus>
  plan(directory: string, environment: NodeJS.ProcessEnv, destroy?: boolean): Promise<TerraformPlanResult>
  apply(directory: string, expectedPlanDigest: string, environment: NodeJS.ProcessEnv): Promise<TerraformApplyResult>
}

interface CommandResult {
  stdout: string
  stderr: string
}

function digestFile(path: string) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function restrict(path: string) {
  try {
    chmodSync(path, 0o600)
  } catch {
    // The Windows user profile ACL remains the protection boundary.
  }
}

function planSummary(plan: unknown): TerraformChangeSummary {
  const changes = (plan as { resource_changes?: Array<{ change?: { actions?: string[] } }> }).resource_changes ?? []
  const summary = { add: 0, change: 0, destroy: 0 }
  for (const resource of changes) {
    const actions = resource.change?.actions ?? []
    if (actions.includes('create')) summary.add += 1
    if (actions.includes('update')) summary.change += 1
    if (actions.includes('delete')) summary.destroy += 1
  }
  return summary
}

function terraformOutputs(value: unknown) {
  const raw = value as Record<string, { value?: unknown }>
  return Object.fromEntries(Object.entries(raw).map(([key, output]) => [key, output?.value]))
}

export class TerraformRunner implements TerraformExecutor {
  private executable?: string
  private runtimeStatus: TerraformRuntimeStatus

  constructor(executable?: string) {
    this.executable = executable ?? this.resolveExecutable()
    this.runtimeStatus = this.inspectStatus()
  }

  status() {
    return { ...this.runtimeStatus }
  }

  async install() {
    const version = '1.15.8'
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch
    if (!['windows', 'darwin', 'linux'].includes(platform) || !['amd64', 'arm64'].includes(architecture)) {
      throw new Error(`Automatic Terraform installation is unavailable for ${process.platform}/${process.arch}.`)
    }
    const directory = projectStatePath('tools', 'terraform')
    const archiveName = `terraform_${version}_${platform}_${architecture}.zip`
    const baseUrl = `https://releases.hashicorp.com/terraform/${version}`
    mkdirSync(directory, { recursive: true })
    const [archiveResponse, checksumsResponse] = await Promise.all([
      fetch(`${baseUrl}/${archiveName}`, { signal: AbortSignal.timeout(120_000) }),
      fetch(`${baseUrl}/terraform_${version}_SHA256SUMS`, { signal: AbortSignal.timeout(30_000) }),
    ])
    if (!archiveResponse.ok || !checksumsResponse.ok) {
      throw new Error('Terraform download failed from releases.hashicorp.com.')
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer())
    const checksums = await checksumsResponse.text()
    const expected = checksums
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts.at(-1) === archiveName)?.[0]
    const actual = createHash('sha256').update(archive).digest('hex')
    if (!expected || expected.toLowerCase() !== actual) {
      throw new Error('Terraform download checksum verification failed.')
    }
    const archivePath = join(directory, archiveName)
    writeFileSync(archivePath, archive, { mode: 0o600 })
    try {
      const attempts = [
        ['tar', ['-xf', archivePath, '-C', directory]],
        ['unzip', ['-o', archivePath, '-d', directory]],
      ] as const
      let detail = 'no supported archive utility was available'
      let extracted = false
      for (const [command, args] of attempts) {
        const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
        if (!result.error && result.status === 0) {
          extracted = true
          break
        }
        detail = result.stderr?.trim() || result.error?.message || detail
      }
      if (!extracted) {
        throw new Error(`Terraform archive extraction failed: ${detail}`)
      }
    } finally {
      rmSync(archivePath, { force: true })
    }
    const executable = join(directory, platform === 'windows' ? 'terraform.exe' : 'terraform')
    if (!existsSync(executable)) {
      throw new Error('Terraform executable was not present after extraction.')
    }
    try {
      chmodSync(executable, 0o700)
    } catch {
      // Windows executable permissions are governed by the profile ACL.
    }
    this.executable = executable
    this.runtimeStatus = this.inspectStatus()
    if (!this.runtimeStatus.available) {
      throw new Error(this.runtimeStatus.detail)
    }
    return this.status()
  }

  async plan(directory: string, environment: NodeJS.ProcessEnv, destroy = false) {
    this.assertAvailable()
    const planFileName = destroy ? 'destroy.tfplan' : 'tfplan'
    const planPath = join(directory, planFileName)
    const init = await this.run(['init', '-input=false', '-no-color'], directory, environment)
    const validate = await this.run(['validate', '-no-color'], directory, environment)
    const args = ['plan', '-input=false', '-no-color', `-out=${planFileName}`]
    if (destroy) args.push('-destroy')
    const planned = await this.run(args, directory, environment)
    restrict(planPath)
    const shown = await this.run(['show', '-json', planFileName], directory, environment)
    const parsed = JSON.parse(shown.stdout) as unknown
    return {
      planDigest: digestFile(planPath),
      planFileName,
      changes: planSummary(parsed),
      log: [init.stdout, init.stderr, validate.stdout, validate.stderr, planned.stdout, planned.stderr]
        .filter(Boolean)
        .join('\n'),
    }
  }

  async apply(directory: string, expectedPlanDigest: string, environment: NodeJS.ProcessEnv) {
    this.assertAvailable()
    const candidates = ['tfplan', 'destroy.tfplan'].map((name) => join(directory, name))
    const planPath = candidates.find((path) => existsSync(path) && digestFile(path) === expectedPlanDigest)
    if (!planPath) {
      throw new Error('The reviewed Terraform plan is missing or has changed. Create a new plan before applying.')
    }
    const applied = await this.run(['apply', '-input=false', '-no-color', basename(planPath)], directory, environment)
    const output = await this.run(['output', '-json'], directory, environment)
    return {
      outputs: output.stdout.trim() ? terraformOutputs(JSON.parse(output.stdout)) : {},
      log: [applied.stdout, applied.stderr].filter(Boolean).join('\n'),
    }
  }

  private resolveExecutable() {
    const configured = envValue('GROVE_TERRAFORM_PATH')?.trim()
    const localName = process.platform === 'win32' ? 'terraform.exe' : 'terraform'
    const local = projectStatePath('tools', 'terraform', localName)
    for (const candidate of [configured, local, 'terraform'].filter((value): value is string => Boolean(value))) {
      const result = spawnSync(candidate, ['version', '-json'], { encoding: 'utf8', windowsHide: true })
      if (!result.error && result.status === 0) {
        return candidate
      }
    }
    return undefined
  }

  private inspectStatus(): TerraformRuntimeStatus {
    if (!this.executable) {
      return {
        available: false,
        detail: 'Terraform is not installed. Install Terraform or set GROVE_TERRAFORM_PATH.',
      }
    }
    const result = spawnSync(this.executable, ['version', '-json'], { encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) {
      return { available: false, executable: this.executable, detail: 'Terraform could not be started.' }
    }
    try {
      const parsed = JSON.parse(result.stdout) as { terraform_version?: string }
      return {
        available: true,
        executable: this.executable,
        version: parsed.terraform_version,
        detail: `Terraform ${parsed.terraform_version ?? ''} is ready.`.trim(),
      }
    } catch {
      return { available: false, executable: this.executable, detail: 'Terraform returned an invalid version response.' }
    }
  }

  private assertAvailable() {
    if (!this.executable || !this.runtimeStatus.available) {
      throw new Error(this.runtimeStatus.detail)
    }
  }

  private run(args: string[], directory: string, environment: NodeJS.ProcessEnv) {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.executable!, args, {
        cwd: directory,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          ...environment,
          TF_IN_AUTOMATION: '1',
          TF_INPUT: '0',
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`Terraform ${args[0]} failed (exit ${code ?? 'unknown'}). ${stderr.trim() || stdout.trim()}`))
        }
      })
    })
  }
}
