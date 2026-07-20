function windowsRoot(path: string) {
  const drive = path.match(/^([A-Za-z]):(?:\\|$)/)
  if (drive) {
    return `${drive[1].toUpperCase()}:\\`
  }

  const share = path.match(/^\\\\([^\\]+)\\([^\\]+)/)
  return share ? `\\\\${share[1]}\\${share[2]}\\` : undefined
}

export function normalizeLocalPathInput(path: string, pathSeparator: string) {
  const trimmed = path.trim()
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:${trimmed.slice(2).replaceAll('/', '\\')}`
  }

  if (/^[\\/]{2}[^\\/]/.test(trimmed)) {
    return `\\\\${trimmed.slice(2).replace(/[\\/]+/g, '\\')}`
  }

  return pathSeparator === '\\' ? trimmed.replaceAll('/', '\\') : trimmed
}

export function parentLocalPath(path: string, pathSeparator: string) {
  const normalized = normalizeLocalPathInput(path, pathSeparator)
  const root = windowsRoot(normalized)
  if (root) {
    const withoutTrailingSeparators = normalized.replace(/[\\/]+$/, '')
    const rootWithoutTrailingSeparator = root.replace(/\\$/, '')
    if (withoutTrailingSeparators.toLowerCase() === rootWithoutTrailingSeparator.toLowerCase()) {
      return root
    }

    const separatorIndex = withoutTrailingSeparators.lastIndexOf('\\')
    const candidate = withoutTrailingSeparators.slice(0, separatorIndex)
    return candidate.length <= rootWithoutTrailingSeparator.length ? root : candidate
  }

  const withoutTrailingSeparators = normalized.replace(/\/+$/, '')
  if (!withoutTrailingSeparators) {
    return '/'
  }

  const separatorIndex = withoutTrailingSeparators.lastIndexOf('/')
  if (separatorIndex <= 0) {
    return separatorIndex === 0 ? '/' : withoutTrailingSeparators
  }
  return withoutTrailingSeparators.slice(0, separatorIndex)
}
