import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  ApplicationDeployment,
  ApplicationDeploymentTarget,
  ApplicationInstance,
  ApplicationVersion,
  AppRunnerService,
  GroveApplication,
  GroveApplicationInput,
  VM,
} from '../src/types'
import type { SshSessionManager } from './sshSessionManager'
import { ApplicationWorkspace, slugify } from './applicationWorkspace'

export interface ApplicationManagerOptions {
  onApplicationUpdated?: (application: GroveApplication) => void
  onDeploymentUpdated?: (deployment: ApplicationDeployment) => void
}

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

const ignoredSourceSegments = new Set(['.git', '.grove', 'node_modules'])
const secretFileNames = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'terraform.tfstate',
  'terraform.tfstate.backup',
  'tfplan',
  'destroy.tfplan',
])
const secretFileExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.jks'])

function nowIso() {
  return new Date().toISOString()
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function safeUnitSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function appUnitName(application: Pick<GroveApplication, 'slug'>) {
  return `grove-${safeUnitSlug(application.slug)}.service`
}

function remoteApplicationPath(application: Pick<GroveApplication, 'slug'>) {
  return `~/grove/${application.slug}`
}

function pathIsWithin(parent: string, child: string) {
  const relativePath = relative(resolve(parent), resolve(child))
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function sourceCopyFilter(root: string) {
  const sourceRoot = resolve(root)
  return (path: string) => {
    const relativePath = relative(sourceRoot, resolve(path))
    const segments = relativePath.split(/[\\/]+/).filter(Boolean)
    if (segments.some((segment) => ignoredSourceSegments.has(segment))) {
      return false
    }
    const name = segments.at(-1)?.toLowerCase() ?? ''
    if (secretFileNames.has(name) || (name.startsWith('.env.') && !name.endsWith('.example'))) {
      return false
    }
    return ![...secretFileExtensions].some((extension) => name.endsWith(extension))
  }
}

function directorySize(path: string): number {
  if (!existsSync(path)) {
    return 0
  }
  const stat = lstatSync(path)
  if (stat.isFile()) {
    return stat.size
  }
  if (!stat.isDirectory()) {
    return 0
  }
  return readdirSync(path).reduce((total, name) => total + directorySize(join(path, name)), 0)
}

function digestPath(path: string) {
  const hash = createHash('sha256')
  const visit = (current: string, prefix: string) => {
    const stat = lstatSync(current)
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        visit(join(current, name), prefix ? `${prefix}/${name}` : name)
      }
      return
    }
    if (!stat.isFile()) {
      return
    }
    hash.update(prefix)
    hash.update('\0')
    hash.update(readFileSync(current))
    hash.update('\0')
  }
  visit(path, '')
  return `sha256:${hash.digest('hex')}`
}

/** Exported for tests: the stdin-EOF behavior is covered by a regression test. */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; logPath?: string; shell?: boolean; environment?: Record<string, string> },
) {
  return new Promise<ProcessResult>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      env: { ...process.env, ...options.environment },
      windowsHide: true,
    })
    // Close stdin immediately: a child that reads it (package managers, credential prompts)
    // gets a clean EOF instead of blocking forever on a pipe nobody ever writes to.
    child.stdin.on('error', () => {})
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    const record = (label: string, chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (options.logPath) {
        appendFileSync(options.logPath, `[${label}] ${text}`)
      }
      return text
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += record('stdout', chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += record('stderr', chunk)
    })
    child.once('error', rejectRun)
    child.once('close', (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }))
  })
}

function runShellCommand(command: string, cwd: string, logPath: string, environment: Record<string, string>) {
  appendFileSync(logPath, `\n$ ${command}\n`)
  return runProcess(command, [], { cwd, logPath, shell: true, environment })
}

function deriveHealth(instances: ApplicationInstance[]): GroveApplication['health'] {
  if (!instances.length) {
    return 'not_deployed'
  }
  if (instances.every((instance) => instance.status === 'healthy')) {
    return 'healthy'
  }
  if (instances.some((instance) => instance.status === 'failed')) {
    return instances.every((instance) => instance.status === 'failed') ? 'failed' : 'degraded'
  }
  if (instances.some((instance) => instance.status === 'degraded' || instance.status === 'stopped')) {
    return 'degraded'
  }
  return 'unknown'
}

function replaceDirectoryAtomically(stagingPath: string, targetPath: string) {
  const backupPath = `${targetPath}.previous-${Date.now()}`
  if (existsSync(targetPath)) {
    renameSync(targetPath, backupPath)
  }
  try {
    renameSync(stagingPath, targetPath)
    rmSync(backupPath, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(backupPath) && !existsSync(targetPath)) {
      renameSync(backupPath, targetPath)
    }
    throw error
  }
}

export class ApplicationManager {
  private readonly workspace: ApplicationWorkspace
  private readonly ssh: SshSessionManager
  private readonly resolveVm: (vmId: string) => VM | undefined
  private readonly options: ApplicationManagerOptions

  constructor(
    workspace: ApplicationWorkspace,
    ssh: SshSessionManager,
    resolveVm: (vmId: string) => VM | undefined,
    options: ApplicationManagerOptions = {},
  ) {
    this.workspace = workspace
    this.ssh = ssh
    this.resolveVm = resolveVm
    this.options = options
  }

  listApplications() {
    return this.workspace.listApplications()
  }

  getApplication(applicationId: string) {
    return this.workspace.getApplication(applicationId)
  }

  async createApplication(input: GroveApplicationInput) {
    const application = this.workspace.createApplication(input)
    try {
      const next = await this.syncSource(application.id)
      return next
    } catch (error) {
      this.workspace.removeApplicationMetadata(application.id)
      throw error
    }
  }

  updateConfiguration(applicationId: string, input: GroveApplicationInput) {
    this.requireApplication(applicationId)
    const next = this.workspace.updateApplication(applicationId, () => ({
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      source: input.source,
      configuration: input.configuration,
    }))
    this.options.onApplicationUpdated?.(next)
    return next
  }

  async syncSource(applicationId: string) {
    const application = this.requireApplication(applicationId)
    const appDirectory = this.workspace.applicationDirectory(application)
    const sourcePath = application.managedSourcePath
    const stagingPath = join(appDirectory, `.source-stage-${Date.now()}`)
    rmSync(stagingPath, { recursive: true, force: true })

    if (application.source.type === 'local') {
      const selectedPath = resolve(application.source.path)
      if (!existsSync(selectedPath) || !statSync(selectedPath).isDirectory()) {
        throw new Error(`Local source folder does not exist: ${selectedPath}`)
      }
      if (pathIsWithin(selectedPath, sourcePath) || pathIsWithin(sourcePath, selectedPath)) {
        throw new Error('The selected source folder must be outside Grove\'s managed application source folder.')
      }
      cpSync(selectedPath, stagingPath, { recursive: true, filter: sourceCopyFilter(selectedPath) })
    } else {
      const args = ['clone', '--depth', '1']
      if (application.source.ref) {
        args.push('--branch', application.source.ref)
      }
      args.push('--', application.source.repoUrl, stagingPath)
      // Fail fast on private repos instead of prompting for credentials on a terminal
      // nobody is watching (which would hang the request and leak the clone).
      const result = await runProcess('git', args, { cwd: dirname(stagingPath), environment: { GIT_TERMINAL_PROMPT: '0' } })
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'Git clone failed.')
      }
    }

    replaceDirectoryAtomically(stagingPath, sourcePath)
    // The record itself is unchanged; touch updatedAt via a no-op merge against the
    // current record so concurrent edits made during the clone are preserved.
    const next = this.workspace.updateApplication(application.id, () => ({}))
    this.options.onApplicationUpdated?.(next)
    return next
  }

  async buildApplication(applicationId: string) {
    let application = this.requireApplication(applicationId)
    if (!existsSync(application.managedSourcePath)) {
      application = await this.syncSource(application.id)
    }

    const sequence = Math.max(0, ...application.versions.map((version) => version.sequence)) + 1
    const versionId = `v${String(sequence).padStart(4, '0')}-${Date.now().toString(36)}`
    const versionDirectory = this.workspace.versionDirectory(application, versionId)
    const frozenSourcePath = join(versionDirectory, 'source')
    const artifactTargetPath = join(versionDirectory, 'artifact')
    const buildLogPath = join(versionDirectory, 'build.log')
    mkdirSync(versionDirectory, { recursive: true })
    cpSync(application.managedSourcePath, frozenSourcePath, {
      recursive: true,
      filter: sourceCopyFilter(application.managedSourcePath),
    })

    const version: ApplicationVersion = {
      id: versionId,
      label: `v${sequence}`,
      sequence,
      status: 'building',
      createdAt: nowIso(),
      buildLogRelativePath: relative(this.workspace.applicationDirectory(application), buildLogPath),
    }
    application = this.workspace.updateApplication(application.id, (current) => ({
      versions: [version, ...current.versions],
    }))
    this.options.onApplicationUpdated?.(application)

    try {
      const environment = application.configuration.environment
      if (application.configuration.installCommand?.trim()) {
        const install = await runShellCommand(
          application.configuration.installCommand,
          frozenSourcePath,
          buildLogPath,
          environment,
        )
        if (install.exitCode !== 0) {
          throw new Error(install.stderr.trim() || `Install command exited with ${install.exitCode}.`)
        }
      }
      if (application.configuration.buildCommand?.trim()) {
        const build = await runShellCommand(
          application.configuration.buildCommand,
          frozenSourcePath,
          buildLogPath,
          environment,
        )
        if (build.exitCode !== 0) {
          throw new Error(build.stderr.trim() || `Build command exited with ${build.exitCode}.`)
        }
      }

      const artifactSourcePath = resolve(frozenSourcePath, application.configuration.artifactPath)
      if (!pathIsWithin(frozenSourcePath, artifactSourcePath)) {
        throw new Error('Artifact path must stay inside the frozen source snapshot.')
      }
      if (!existsSync(artifactSourcePath)) {
        throw new Error(`Build artifact was not found: ${application.configuration.artifactPath}`)
      }
      if (statSync(artifactSourcePath).isDirectory()) {
        cpSync(artifactSourcePath, artifactTargetPath, {
          recursive: true,
          filter: sourceCopyFilter(artifactSourcePath),
        })
      } else {
        mkdirSync(artifactTargetPath, { recursive: true })
        cpSync(artifactSourcePath, join(artifactTargetPath, basename(artifactSourcePath)))
      }
      const completed: ApplicationVersion = {
        ...version,
        status: 'succeeded',
        completedAt: nowIso(),
        sourceRevision: await this.sourceRevision(application.managedSourcePath),
        artifactRelativePath: relative(this.workspace.applicationDirectory(application), artifactTargetPath),
        artifactDigest: digestPath(artifactTargetPath),
        artifactSizeBytes: directorySize(artifactTargetPath),
      }
      application = this.replaceVersion(application, completed)
      this.options.onApplicationUpdated?.(application)
      return completed
    } catch (error) {
      const failed: ApplicationVersion = {
        ...version,
        status: 'failed',
        completedAt: nowIso(),
        failure: error instanceof Error ? error.message : String(error),
      }
      appendFileSync(buildLogPath, `\n[grove] Build failed: ${failed.failure}\n`)
      application = this.replaceVersion(application, failed)
      this.options.onApplicationUpdated?.(application)
      return failed
    }
  }

  async deployApplication(applicationId: string, versionId: string, vmIds: string[], environment = 'production') {
    let application = this.requireApplication(applicationId)
    const version = application.versions.find((item) => item.id === versionId)
    if (!version || version.status !== 'succeeded' || !version.artifactRelativePath) {
      throw new Error('Only a successful application version can be deployed.')
    }
    const targets = [...new Set(vmIds)]
    if (!targets.length) {
      throw new Error('Select at least one target VM.')
    }
    for (const vmId of targets) {
      if (!this.resolveVm(vmId)) {
        throw new Error(`VM not found: ${vmId}`)
      }
    }

    let deployment: ApplicationDeployment = {
      id: `deploy-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      applicationId: application.id,
      versionId: version.id,
      environment,
      strategy: 'rolling',
      status: 'running',
      createdAt: nowIso(),
      targetVmIds: targets,
      targets: targets.map((vmId) => ({ vmId, status: 'queued' })),
    }
    application = this.workspace.updateApplication(application.id, (current) => ({
      deployments: [deployment, ...current.deployments],
      instances: targets.reduce(
        (instances, vmId) => this.upsertInstance(instances, {
          vmId,
          desiredVersionId: version.id,
          status: 'uploading',
          remotePath: remoteApplicationPath(application),
          unitName: appUnitName(application),
          updatedAt: nowIso(),
          lastDeploymentId: deployment.id,
        }),
        current.instances,
      ),
    }))
    this.publishDeployment(application, deployment)

    for (const vmId of targets) {
      const startedAt = nowIso()
      deployment = this.updateDeploymentTarget(deployment, vmId, { status: 'uploading', startedAt })
      application = this.persistDeployment(application, deployment)
      try {
        const detail = await this.deployTarget(application, version, this.requireVm(vmId))
        deployment = this.updateDeploymentTarget(deployment, vmId, {
          status: 'healthy',
          completedAt: nowIso(),
          detail,
        })
        application = this.workspace.updateApplication(application.id, (current) => ({
          activeVersionId: version.id,
          instances: this.upsertInstance(current.instances, {
            vmId,
            versionId: version.id,
            desiredVersionId: version.id,
            status: 'healthy',
            remotePath: remoteApplicationPath(application),
            unitName: appUnitName(application),
            updatedAt: nowIso(),
            healthDetail: detail,
            lastDeploymentId: deployment.id,
          }),
        }))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        deployment = this.updateDeploymentTarget(deployment, vmId, {
          status: 'failed',
          completedAt: nowIso(),
          detail,
        })
        application = this.workspace.updateApplication(application.id, (current) => ({
          instances: this.upsertInstance(current.instances, {
            vmId,
            desiredVersionId: version.id,
            status: 'failed',
            remotePath: remoteApplicationPath(application),
            unitName: appUnitName(application),
            updatedAt: nowIso(),
            healthDetail: detail,
            lastDeploymentId: deployment.id,
          }),
        }))
      }
      application = this.persistDeployment(application, deployment)
    }

    const healthy = deployment.targets.filter((target) => target.status === 'healthy').length
    deployment = {
      ...deployment,
      status: healthy === targets.length ? 'succeeded' : healthy > 0 ? 'partial' : 'failed',
      completedAt: nowIso(),
    }
    application = this.persistDeployment(application, deployment)
    application = this.workspace.updateApplication(application.id, (current) => ({
      health: deriveHealth(current.instances),
    }))
    this.publishDeployment(application, deployment)
    return { application, deployment }
  }

  async readApplicationLogs(applicationId: string, vmId: string, lines = 200) {
    const application = this.requireApplication(applicationId)
    const vm = this.requireVm(vmId)
    const boundedLines = Math.max(1, Math.min(lines, 2000))
    const run = await this.ssh.executeCommand({
      vm,
      command: `journalctl -u ${shellQuote(appUnitName(application))} -n ${boundedLines} --no-pager 2>&1`,
      actor: 'system',
      mutating: false,
    })
    if (run.status === 'failed') {
      throw new Error(run.stderr || run.summary)
    }
    return { vmId, lines: (run.stdout ?? '').split(/\r?\n/) }
  }

  migrateLegacyAppRunnerServices(services: AppRunnerService[]) {
    // One-shot import: the completion marker lives in settings.yaml so a restart cannot
    // re-import services (which previously created duplicates after a rename).
    if (this.workspace.legacyAppRunnerMigrationCompleted()) {
      return []
    }
    const grouped = new Map<string, AppRunnerService[]>()
    for (const service of services) {
      grouped.set(service.name, [...(grouped.get(service.name) ?? []), service])
    }
    const migrated: GroveApplication[] = []
    let failed = false
    for (const [name, serviceGroup] of grouped) {
      // Match by slug as well as name: a renamed application keeps its slug, so the guard
      // still recognizes it and cannot produce a duplicate.
      const slug = slugify(name)
      if (this.workspace.listApplications().some((application) => application.name === name || (slug && application.slug === slug))) {
        continue
      }
      const first = serviceGroup[0]
      if (!first) {
        continue
      }
      try {
        const source = first.source.type === 'github'
          ? { type: 'git' as const, repoUrl: first.source.repoUrl, ref: first.source.ref }
          : first.source
        let application = this.workspace.createApplication({
          name,
          description: 'Imported from Grove v0.1 AppRunner metadata.',
          source,
          configuration: {
            installCommand: first.installCommand,
            buildCommand: first.buildCommand,
            artifactPath: '.',
            startCommand: first.startCommand,
            port: first.port,
            healthCheckPath: '/',
            healthCheckTimeoutSeconds: 30,
            environment: {},
          },
        })
        const instances: ApplicationInstance[] = serviceGroup.map((service) => ({
          vmId: service.vmId,
          status: service.state === 'running' && service.listening ? 'healthy' : service.state === 'stopped' ? 'stopped' : 'degraded',
          remotePath: service.remotePath,
          unitName: service.unitName,
          updatedAt: service.updatedAt,
          healthDetail: service.lastDeploySummary,
        }))
        application = this.workspace.updateApplication(application.id, () => ({ instances, health: deriveHealth(instances) }))
        this.options.onApplicationUpdated?.(application)
        migrated.push(application)
      } catch (error) {
        // One unreadable legacy service must not abort the import (or startup): skip it and
        // leave the marker unset so it is retried on the next boot.
        failed = true
        console.warn(`Grove: legacy AppRunner service "${name}" could not be imported.`, error)
      }
    }
    if (!failed) {
      this.workspace.markLegacyAppRunnerMigrationCompleted()
    }
    return migrated
  }

  private requireApplication(applicationId: string) {
    const application = this.workspace.getApplication(applicationId)
    if (!application) {
      throw new Error('Application not found')
    }
    return application
  }

  private requireVm(vmId: string) {
    const vm = this.resolveVm(vmId)
    if (!vm) {
      throw new Error('VM not found')
    }
    return vm
  }

  private replaceVersion(application: GroveApplication, version: ApplicationVersion) {
    return this.workspace.updateApplication(application.id, (current) => ({
      versions: current.versions.map((item) => (item.id === version.id ? version : item)),
    }))
  }

  private async sourceRevision(frozenSourcePath: string) {
    if (existsSync(join(frozenSourcePath, '.git'))) {
      const result = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: frozenSourcePath })
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout.trim()
      }
    }
    return digestPath(frozenSourcePath)
  }

  private upsertInstance(instances: ApplicationInstance[], next: ApplicationInstance) {
    return instances.some((instance) => instance.vmId === next.vmId)
      ? instances.map((instance) => (instance.vmId === next.vmId ? { ...instance, ...next } : instance))
      : [next, ...instances]
  }

  private updateDeploymentTarget(
    deployment: ApplicationDeployment,
    vmId: string,
    patch: Partial<ApplicationDeploymentTarget>,
  ) {
    return {
      ...deployment,
      targets: deployment.targets.map((target) => (target.vmId === vmId ? { ...target, ...patch } : target)),
    }
  }

  private persistDeployment(application: GroveApplication, deployment: ApplicationDeployment) {
    const next = this.workspace.updateApplication(application.id, (current) => ({
      deployments: current.deployments.map((item) => (item.id === deployment.id ? deployment : item)),
    }))
    this.publishDeployment(next, deployment)
    return next
  }

  private publishDeployment(application: GroveApplication, deployment: ApplicationDeployment) {
    this.options.onApplicationUpdated?.(application)
    this.options.onDeploymentUpdated?.(deployment)
  }

  private async resolveRemoteHome(vm: VM) {
    const run = await this.ssh.executeCommand({
      vm,
      command: ['printf "__GROVE_HOME__\\n"', 'printf "%s\\n" "$HOME"'].join('\n'),
      actor: 'system',
      mutating: false,
    })
    if (run.status === 'failed') {
      throw new Error(run.stderr || run.summary)
    }
    const home = (run.stdout ?? '').split('__GROVE_HOME__')[1]?.trim().split(/\r?\n/)[0]?.trim()
    if (!home?.startsWith('/')) {
      throw new Error(`Could not resolve remote home directory on ${vm.name}.`)
    }
    return home.replace(/\/$/, '')
  }

  private async deployTarget(application: GroveApplication, version: ApplicationVersion, vm: VM) {
    if (!this.ssh.uploadDirectory) {
      throw new Error('This SSH adapter cannot upload application artifacts.')
    }
    const appDirectory = this.workspace.applicationDirectory(application)
    const artifactPath = resolve(appDirectory, version.artifactRelativePath!)
    if (!pathIsWithin(appDirectory, artifactPath) || !existsSync(artifactPath)) {
      throw new Error('The local application artifact is missing or invalid.')
    }
    const home = await this.resolveRemoteHome(vm)
    const remoteRoot = `${home}/grove/${application.slug}`
    const candidatePath = `${remoteRoot}/releases/.${version.id}.candidate`
    const prepare = await this.ssh.executeCommand({
      vm,
      command: [
        'set -eu',
        `mkdir -p ${shellQuote(`${remoteRoot}/artifacts`)} ${shellQuote(`${remoteRoot}/releases`)} ${shellQuote(`${remoteRoot}/shared/runtime`)} ${shellQuote(`${remoteRoot}/logs`)}`,
        `rm -rf ${shellQuote(candidatePath)}`,
        `mkdir -p ${shellQuote(candidatePath)}`,
      ].join('\n'),
      actor: 'user',
      mutating: true,
    })
    if (prepare.status === 'failed') {
      throw new Error(prepare.stderr || prepare.summary)
    }
    await this.ssh.uploadDirectory({ vm, sourcePath: artifactPath, targetPath: candidatePath })

    const unitName = appUnitName(application)
    const startCommand = application.configuration.startCommand.replace(/'/g, `'"'"'`)
    const environmentLines = Object.entries(application.configuration.environment)
      .map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`)}`)
      .join('\n')
    const unit = [
      '[Unit]',
      `Description=Grove application ${application.name}`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      `User=${vm.connection.user}`,
      `WorkingDirectory=${remoteRoot}/current`,
      `ExecStart=/bin/sh -lc '${startCommand}'`,
      'Restart=on-failure',
      'RestartSec=3',
      `Environment=PORT=${application.configuration.port}`,
      environmentLines,
      `StandardOutput=append:${remoteRoot}/logs/application.log`,
      `StandardError=append:${remoteRoot}/logs/application.log`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].filter((line) => line !== undefined).join('\n')
    const unitBase64 = Buffer.from(unit).toString('base64')
    const releasePath = `${remoteRoot}/releases/${version.id}`
    const healthUrl = `http://127.0.0.1:${application.configuration.port}${application.configuration.healthCheckPath}`
    const timeout = application.configuration.healthCheckTimeoutSeconds
    const activate = await this.ssh.executeCommand({
      vm,
      command: [
        'set -eu',
        'SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi',
        `ROOT=${shellQuote(remoteRoot)}`,
        `CANDIDATE=${shellQuote(candidatePath)}`,
        `RELEASE=${shellQuote(releasePath)}`,
        'OLD=""; if [ -L "$ROOT/current" ]; then OLD=$(readlink -f "$ROOT/current" || true); fi',
        'rm -rf "$RELEASE"',
        'mv "$CANDIDATE" "$RELEASE"',
        'if [ -n "$OLD" ] && [ -d "$OLD" ]; then ln -sfn "$OLD" "$ROOT/previous"; fi',
        'ln -sfn "$RELEASE" "$ROOT/current"',
        `printf %s ${shellQuote(unitBase64)} | base64 -d | $SUDO tee ${shellQuote(`/etc/systemd/system/${unitName}`)} >/dev/null`,
        '$SUDO systemctl daemon-reload',
        `$SUDO systemctl enable ${shellQuote(unitName)} >/dev/null`,
        `$SUDO systemctl restart ${shellQuote(unitName)}`,
        'healthy=0',
        `deadline=$(( $(date +%s) + ${timeout} ))`,
        'while [ "$(date +%s)" -le "$deadline" ]; do',
        `  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 5 ${shellQuote(healthUrl)} >/dev/null; then healthy=1; break; fi`,
        `  if ! command -v curl >/dev/null 2>&1 && command -v wget >/dev/null 2>&1 && wget -q -T 5 -O /dev/null ${shellQuote(healthUrl)}; then healthy=1; break; fi`,
        '  sleep 2',
        'done',
        'if [ "$healthy" -ne 1 ]; then',
        '  if [ -n "$OLD" ] && [ -d "$OLD" ]; then ln -sfn "$OLD" "$ROOT/current"; $SUDO systemctl restart ' + shellQuote(unitName) + '; fi',
        '  echo "Health check failed; previous release restored." >&2',
        '  exit 20',
        'fi',
        `printf '%s\n' ${shellQuote(JSON.stringify({ versionId: version.id, status: 'healthy' }))} > "$ROOT/state.json"`,
      ].join('\n'),
      actor: 'user',
      mutating: true,
      timeoutMs: Math.max(120_000, (timeout + 30) * 1000),
    })
    if (activate.status === 'failed') {
      throw new Error(activate.stderr || activate.summary)
    }
    return `${version.label} activated and ${healthUrl} passed on ${vm.name}.`
  }
}
