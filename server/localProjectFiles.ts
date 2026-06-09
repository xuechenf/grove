import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export interface LocalProjectFile {
  localPath: string
  relativePath: string
}

const generatedFolders = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.next', 'coverage'])

function expandLocalPath(path: string) {
  if (path.startsWith('~/')) {
    return resolve(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), path.slice(2))
  }

  return resolve(path)
}

function normalizeRelativePath(path: string) {
  return path.split(sep).join('/')
}

function gitignoreRules(root: string) {
  const gitignorePath = join(root, '.gitignore')
  if (!existsSync(gitignorePath)) {
    return []
  }

  return readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
}

function wildcardMatch(pattern: string, value: string) {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${expression}$`).test(value)
}

function ignoredByRule(relativePath: string, rule: string) {
  const normalizedRule = rule.replace(/\\/g, '/').replace(/\/$/, '')
  const anchored = normalizedRule.startsWith('/')
  const pattern = anchored ? normalizedRule.slice(1) : normalizedRule
  const segments = relativePath.split('/')

  if (!pattern.includes('/')) {
    return segments.some((segment) => wildcardMatch(pattern, segment))
  }

  if (anchored) {
    return relativePath === pattern || relativePath.startsWith(`${pattern}/`) || wildcardMatch(pattern, relativePath)
  }

  return relativePath === pattern || relativePath.endsWith(`/${pattern}`) || relativePath.includes(`/${pattern}/`)
}

function shouldSkip(relativePath: string, rules: string[]) {
  const segments = relativePath.split('/')
  if (segments.some((segment) => generatedFolders.has(segment))) {
    return true
  }

  return rules.some((rule) => ignoredByRule(relativePath, rule))
}

export function collectLocalProjectFiles(sourcePath: string): LocalProjectFile[] {
  const root = expandLocalPath(sourcePath)
  if (!existsSync(root)) {
    throw new Error(`Local source folder does not exist: ${sourcePath}`)
  }

  const rootStat = statSync(root)
  if (!rootStat.isDirectory()) {
    throw new Error(`Local source must be a folder: ${sourcePath}`)
  }

  const rules = gitignoreRules(root)
  const files: LocalProjectFile[] = []

  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      const localPath = join(directory, entry)
      const relativePath = normalizeRelativePath(relative(root, localPath))
      if (shouldSkip(relativePath, rules)) {
        continue
      }

      const stat = statSync(localPath)
      if (stat.isDirectory()) {
        walk(localPath)
        continue
      }

      if (stat.isFile()) {
        files.push({ localPath, relativePath })
      }
    }
  }

  walk(root)
  return files
}
