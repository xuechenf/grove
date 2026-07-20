import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProtectedLocalEntry, listLocalFiles, normalizeLocalDirectoryPath } from './localFiles'

describe('local file browser safety', () => {
  it('hides credentials and generated workspace folders by default', () => {
    const directory = mkdtempSync(join(tmpdir(), 'grove-files-'))
    writeFileSync(join(directory, 'README.md'), 'safe')
    writeFileSync(join(directory, '.env.example'), 'SAFE=1')
    writeFileSync(join(directory, 'cloud-access.csv'), 'secret')
    writeFileSync(join(directory, 'server.pem'), 'secret')
    mkdirSync(join(directory, '.git'))
    mkdirSync(join(directory, 'node_modules'))

    expect(listLocalFiles(directory).map((entry) => entry.name)).toEqual(['.env.example', 'README.md'])
  })

  it('recognizes credential-like entries without hiding the safe environment example', () => {
    expect(isProtectedLocalEntry('.env.local')).toBe(true)
    expect(isProtectedLocalEntry('credentials.json')).toBe(true)
    expect(isProtectedLocalEntry('deploy.key')).toBe(true)
    expect(isProtectedLocalEntry('.env.example')).toBe(false)
  })

  it('normalizes Windows drive roots and absolute drive paths', () => {
    expect(normalizeLocalDirectoryPath('D:', 'win32')).toBe('D:\\')
    expect(normalizeLocalDirectoryPath('D:/projects/grove', 'win32')).toBe('D:\\projects\\grove')
    expect(normalizeLocalDirectoryPath('\\\\server\\share\\apps', 'win32')).toBe('\\\\server\\share\\apps')
  })

  it('rejects an empty local directory path', () => {
    expect(() => normalizeLocalDirectoryPath('  ', 'win32')).toThrow('Enter a local directory path')
  })
})
