import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { useState } from 'react'
import { operatorBriefLibrary, type OperatorBriefAction } from '../openui/operatorBriefLibrary'
import type { CopilotMessage, TabId } from '../types'

interface OpenUiArtifactProps {
  artifact: NonNullable<CopilotMessage['openUi']>
  disabled?: boolean
  onAction: (action: OperatorBriefAction) => void
}

const actionKinds = new Set<OperatorBriefAction['kind']>(['focus_vm', 'open_tab', 'ask_followup', 'request_fix'])
const tabs = new Set<TabId>(['overview', 'files', 'terminal', 'apprunner', 'activity', 'settings'])

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeAction(event: ActionEvent): OperatorBriefAction | undefined {
  const kind = typeof event.type === 'string' ? event.type : String(event.type)
  if (!actionKinds.has(kind as OperatorBriefAction['kind'])) {
    return undefined
  }

  const params = event.params ?? {}
  const tab = stringValue(params.tab)
  return {
    kind: kind as OperatorBriefAction['kind'],
    label: stringValue(params.label) ?? event.humanFriendlyMessage,
    vmId: stringValue(params.vmId),
    tab: tab && tabs.has(tab as TabId) ? (tab as TabId) : undefined,
    message: stringValue(params.message),
  }
}

export function OpenUiArtifact({ artifact, disabled = false, onAction }: OpenUiArtifactProps) {
  const [errors, setErrors] = useState<OpenUIError[]>([])

  return (
    <div className="my-2" data-testid="openui-artifact">
      <Renderer
        response={artifact.content}
        library={operatorBriefLibrary}
        isStreaming={disabled}
        onAction={(event) => {
          const action = normalizeAction(event)
          if (action) {
            onAction(action)
          }
        }}
        onError={setErrors}
      />
      {errors.length > 0 ? (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          Operator brief could not fully render.
        </div>
      ) : null}
    </div>
  )
}

export type { OperatorBriefAction }
