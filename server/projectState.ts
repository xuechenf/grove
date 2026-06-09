import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export function projectStateDir() {
  const configured = process.env.GROVE_STATE_DIR?.trim()
  return configured ? resolve(process.cwd(), configured) : resolve(process.cwd(), '.grove')
}

export function projectStatePath(...segments: string[]) {
  return join(projectStateDir(), ...segments)
}

export function ensureProjectStateDir(...segments: string[]) {
  const path = projectStatePath(...segments)
  mkdirSync(path, { recursive: true })
  return path
}

export function resolveProjectStateReference(path: string) {
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }

  if (isAbsolute(path)) {
    return resolve(path)
  }

  return projectStatePath(path)
}

export function localDefaults() {
  return {
    workspacePath: process.cwd(),
    downloadsPath: ensureProjectStateDir('downloads'),
    localFilesPath: ensureProjectStateDir('local-files'),
    pathSeparator: sep,
  }
}
