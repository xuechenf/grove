import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write a state file atomically: the payload goes to a temporary sibling first and is then
 * renamed over the target, so a crash mid-write can never leave a truncated file behind for
 * the next boot to choke on. (credentialVault.ts uses the same pattern, plus 0600 perms.)
 */
export function atomicWriteFileSync(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, contents, 'utf8')
  renameSync(temporaryPath, path)
}

/**
 * Move an unreadable state file aside (`<file>.corrupt-<timestamp>`) so startup can continue
 * with defaults instead of crashing. Best effort: returns the quarantine path, or undefined
 * when the rename itself failed.
 */
export function quarantineCorruptFile(path: string) {
  const quarantinePath = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, quarantinePath)
    return quarantinePath
  } catch {
    return undefined
  }
}
