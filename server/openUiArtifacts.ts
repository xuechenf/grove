import type { CopilotMessage } from '../src/types'

export const OPENUI_ARTIFACT_MAX_CHARS = 20_000

export interface OpenUiExtraction {
  content: string
  openUi?: NonNullable<CopilotMessage['openUi']>
}

const openUiFencePattern = /(^|\r?\n)(```|~~~)[ \t]*openui[^\r\n]*\r?\n([\s\S]*?)\r?\n\2[ \t]*(?=\r?\n|$)/i

export function extractOpenUiArtifact(content: string): OpenUiExtraction {
  const match = openUiFencePattern.exec(content)
  if (!match) {
    return { content }
  }

  const artifactContent = match[3]?.trim() ?? ''
  if (!artifactContent || artifactContent.length > OPENUI_ARTIFACT_MAX_CHARS) {
    return { content }
  }

  const markdown = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    content: markdown,
    openUi: {
      type: 'openui',
      content: artifactContent,
    },
  }
}
