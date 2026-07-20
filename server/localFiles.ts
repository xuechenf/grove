import { readdirSync, statSync } from 'node:fs'
import { basename, join, posix, win32 } from 'node:path'
import { spawn } from 'node:child_process'
import type { FileNode } from '../src/types'
import { localDefaults } from './projectState'

export { localDefaults }

function formatModifiedTime(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function localId(path: string) {
  return `local-${path.replace(/[^a-z0-9_-]+/gi, '-')}`
}

const hiddenWorkspaceFolders = new Set([
  '.git',
  '.grove',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
])

export function isProtectedLocalEntry(name: string) {
  const normalized = name.toLowerCase()
  if (hiddenWorkspaceFolders.has(normalized) || normalized.startsWith('release-')) return true
  if (normalized === '.env.example') return false
  return normalized === '.env'
    || normalized.startsWith('.env.')
    || /\.(pem|key|pfx|p12|csv)$/i.test(normalized)
    || /(^|[-_.])(secret|secrets|credential|credentials|accesskey|accesskeys)([-_.]|$)/i.test(normalized)
}

export function normalizeLocalDirectoryPath(path: string, platform = process.platform) {
  const trimmed = path.trim()
  if (!trimmed) {
    throw new Error('Enter a local directory path.')
  }

  if (platform === 'win32') {
    const candidate = /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
    return win32.resolve(candidate)
  }

  return posix.resolve(trimmed)
}

function localDirectoryStat(path: string) {
  try {
    return statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new Error(`Local directory not found: ${path}`, { cause: error })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Access denied to local directory: ${path}`, { cause: error })
    }
    throw new Error(`Local directory could not be opened: ${path}`, { cause: error })
  }
}

export function resolveLocalDirectory(path = process.cwd()) {
  const directory = normalizeLocalDirectoryPath(path)
  const stat = localDirectoryStat(directory)
  if (!stat.isDirectory()) {
    throw new Error(`The selected local path is not a directory: ${directory}`)
  }
  return directory
}

export function listLocalFiles(path = process.cwd()): FileNode[] {
  const directory = resolveLocalDirectory(path)

  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Access denied to local directory: ${directory}`, { cause: error })
    }
    throw new Error(`Local directory could not be read: ${directory}`, { cause: error })
  }

  return names
    .filter((name) => !isProtectedLocalEntry(name))
    .map((name): FileNode | undefined => {
      const fullPath = join(directory, name)
      // Skip entries we cannot stat (dangling symlinks, Windows junctions that EPERM,
      // races where the file vanished) instead of failing the whole listing.
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch {
        return undefined
      }
      return {
        id: localId(fullPath),
        scope: 'local' as const,
        type: stat.isDirectory() ? 'folder' as const : 'file' as const,
        name,
        path: fullPath,
        size: stat.isDirectory() ? 0 : stat.size,
        modified: formatModifiedTime(stat.mtime),
        owner: 'local',
      }
    })
    .filter((node): node is FileNode => Boolean(node))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1
      }

      return left.name.localeCompare(right.name)
    })
}

export function openLocalFolder(path = process.cwd()) {
  const directory = resolveLocalDirectory(path)

  const command =
    process.platform === 'win32'
      ? { file: 'explorer.exe', args: [directory] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [directory] }
        : { file: 'xdg-open', args: [directory] }

  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()

  return {
    path: directory,
    name: basename(directory) || directory,
  }
}
