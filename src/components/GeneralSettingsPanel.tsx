import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, Monitor, Moon, Save, Settings, Sun, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { cx } from '../lib/format'
import type { CopilotProvider, CopilotProviderStatus } from '../types'
import { IconButton } from './IconButton'

export type AppTheme = 'system' | 'light' | 'dark'

interface ProviderOption {
  value: CopilotProvider
  label: string
  detail: string
  baseUrl: string
  model: string
}

const providerOptions: ProviderOption[] = [
  {
    value: 'moonshot',
    label: 'Moonshot',
    detail: 'Kimi API',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  },
  {
    value: 'glm-cn',
    label: 'GLM-CN',
    detail: 'Z.AI coding API',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.2',
  },
]

const themeOptions: Array<{ value: AppTheme; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

interface GeneralSettingsPanelProps {
  providerStatus: CopilotProviderStatus
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onSaveProvider: (input: {
    provider: CopilotProvider
    apiKey: string
    baseUrl: string
    model: string
  }) => Promise<void>
}

function optionFor(provider: CopilotProvider) {
  return providerOptions.find((option) => option.value === provider) ?? providerOptions[0]
}

export function GeneralSettingsPanel({
  providerStatus,
  theme,
  onThemeChange,
  onSaveProvider,
}: GeneralSettingsPanelProps) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<CopilotProvider>(providerStatus.provider)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(providerStatus.baseUrl)
  const [model, setModel] = useState(providerStatus.model)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | undefined>()

  function selectProvider(nextProvider: CopilotProvider) {
    const defaults = optionFor(nextProvider)
    setProvider(nextProvider)
    setBaseUrl(defaults.baseUrl)
    setModel(defaults.model)
    setSaveMessage(undefined)
  }

  async function saveProvider() {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      setSaveMessage('Enter an API key before saving.')
      return
    }

    setSaving(true)
    setSaveMessage(undefined)
    try {
      await onSaveProvider({
        provider,
        apiKey: trimmedKey,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      })
      setApiKey('')
      setSaveMessage(`${optionFor(provider).label} provider saved.`)
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Provider save failed.')
    } finally {
      setSaving(false)
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      setProvider(providerStatus.provider)
      setBaseUrl(providerStatus.baseUrl)
      setModel(providerStatus.model)
      setSaveMessage(undefined)
    }
    setOpen(nextOpen)
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open Grove settings"
          className="fixed bottom-3 left-3 z-40 inline-flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 shadow-lg shadow-slate-950/10 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content className="fixed bottom-16 left-3 z-50 max-h-[calc(100svh-88px)] w-[min(440px,calc(100vw-24px))] overflow-auto rounded border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 focus:outline-none">
          <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <Dialog.Title className="text-sm font-semibold text-slate-950">Grove settings</Dialog.Title>
              <Dialog.Description className="text-xs text-slate-500">Copilot provider and theme</Dialog.Description>
            </div>
            <IconButton label="Close Grove settings" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="grid gap-4 p-4">
            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xs font-semibold uppercase text-slate-500">Copilot provider</h2>
                <div className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
                  <CheckCircle2
                    className={cx(
                      'h-3.5 w-3.5',
                      providerStatus.configured ? 'text-emerald-600' : 'text-slate-400',
                    )}
                    aria-hidden="true"
                  />
                  {providerStatus.configured ? 'Configured' : 'Not configured'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Copilot provider">
                {providerOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={provider === option.value}
                    onClick={() => selectProvider(option.value)}
                    className={cx(
                      'rounded border p-3 text-left transition',
                      provider === option.value
                        ? 'border-slate-900 bg-slate-950 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className={cx('block text-xs', provider === option.value ? 'text-slate-200' : 'text-slate-500')}>
                      {option.detail}
                    </span>
                  </button>
                ))}
              </div>

              <label className="grid gap-1 text-xs font-medium text-slate-600">
                API key
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder={providerStatus.configured ? 'Saved; enter a new key to replace' : 'sk-...'}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Base URL
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Model
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-h-4 text-xs text-slate-500">{saveMessage}</div>
                <button
                  type="button"
                  onClick={saveProvider}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {saving ? 'Saving' : 'Save'}
                </button>
              </div>
            </section>

            <section className="grid gap-3 border-t border-slate-200 pt-4">
              <h2 className="text-xs font-semibold uppercase text-slate-500">Theme</h2>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Theme">
                {themeOptions.map((option) => {
                  const Icon = option.icon
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={theme === option.value}
                      onClick={() => onThemeChange(option.value)}
                      className={cx(
                        'inline-flex h-9 items-center justify-center gap-2 rounded border px-2 text-xs font-medium transition',
                        theme === option.value
                          ? 'border-slate-900 bg-slate-950 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
