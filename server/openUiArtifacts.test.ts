import { describe, expect, it } from 'vitest'
import { OPENUI_ARTIFACT_MAX_CHARS, extractOpenUiArtifact } from './openUiArtifacts'

describe('extractOpenUiArtifact', () => {
  it('extracts one valid openui fence and removes it from markdown', () => {
    const extracted = extractOpenUiArtifact(
      [
        'Here is the brief.',
        '',
        '```openui',
        'root = OperatorBrief("Fleet", "fleet", "success", "All clear")',
        '```',
        '',
        'Use the buttons for safe follow-ups.',
      ].join('\n'),
    )

    expect(extracted.content).toBe('Here is the brief.\n\nUse the buttons for safe follow-ups.')
    expect(extracted.openUi).toEqual({
      type: 'openui',
      content: 'root = OperatorBrief("Fleet", "fleet", "success", "All clear")',
    })
  })

  it('leaves empty, oversized, and unterminated fences untouched', () => {
    const empty = '```openui\n\n```'
    const oversized = `\`\`\`openui\n${'x'.repeat(OPENUI_ARTIFACT_MAX_CHARS + 1)}\n\`\`\``
    const unterminated = '```openui\nroot = OperatorBrief("Fleet")'

    expect(extractOpenUiArtifact(empty)).toEqual({ content: empty })
    expect(extractOpenUiArtifact(oversized)).toEqual({ content: oversized })
    expect(extractOpenUiArtifact(unterminated)).toEqual({ content: unterminated })
  })
})
