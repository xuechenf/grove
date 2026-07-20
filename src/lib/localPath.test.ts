import { describe, expect, it } from 'vitest'
import { normalizeLocalPathInput, parentLocalPath } from './localPath'

describe('local path navigation', () => {
  it('turns a bare Windows drive into its root', () => {
    expect(normalizeLocalPathInput('d:', '\\')).toBe('D:\\')
  })

  it('normalizes Windows drive and UNC separators', () => {
    expect(normalizeLocalPathInput('d:/projects/grove', '\\')).toBe('D:\\projects\\grove')
    expect(normalizeLocalPathInput('//server/share/apps', '\\')).toBe('\\\\server\\share\\apps')
  })

  it('keeps drive and UNC roots stable when navigating up', () => {
    expect(parentLocalPath('D:\\', '\\')).toBe('D:\\')
    expect(parentLocalPath('D:\\projects', '\\')).toBe('D:\\')
    expect(parentLocalPath('\\\\server\\share\\', '\\')).toBe('\\\\server\\share\\')
    expect(parentLocalPath('\\\\server\\share\\apps', '\\')).toBe('\\\\server\\share\\')
  })

  it('keeps POSIX root navigation unchanged', () => {
    expect(parentLocalPath('/Users/grove', '/')).toBe('/Users')
    expect(parentLocalPath('/', '/')).toBe('/')
  })
})
