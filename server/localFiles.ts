import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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

export function listLocalFiles(path = process.cwd()): FileNode[] {
  const directory = resolve(path)
  // Listing is a read: a missing path returns nothing rather than being created on disk.
  if (!existsSync(directory)) {
    return []
  }

  return readdirSync(directory)
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
  const directory = resolve(path)
  mkdirSync(directory, { recursive: true })

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
    name: basename(directory),
  }
}
