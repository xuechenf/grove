import * as Dialog from '@radix-ui/react-dialog'
import { Save, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { VM, VmConnectionInput } from '../types'
import { IconButton } from './IconButton'

type VmEditorMode = 'add' | 'edit'

interface VmEditorDialogProps {
  open: boolean
  mode: VmEditorMode
  vm?: VM
  onOpenChange: (open: boolean) => void
  onSave: (input: VmConnectionInput) => Promise<void>
}

interface FormState {
  name: string
  ipAddress: string
  user: string
  port: string
  pemPath: string
  os: string
}

const emptyForm: FormState = {
  name: '',
  ipAddress: '',
  user: 'root',
  port: '22',
  pemPath: '',
  os: 'Linux',
}

function formFromVm(vm: VM | undefined): FormState {
  if (!vm) {
    return emptyForm
  }

  const keyLabel = ['ssh-agent', 'not configured'].includes(vm.connection.keyLabel) ? '' : vm.connection.keyLabel

  return {
    name: vm.name,
    ipAddress: vm.ipAddress,
    user: vm.connection.user,
    port: String(vm.connection.port),
    pemPath: keyLabel,
    os: vm.os,
  }
}

function Field({
  label,
  children,
  required,
}: {
  label: string
  children: ReactNode
  required?: boolean
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600">
      <span>
        {label}
        {required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {children}
    </label>
  )
}

export function VmEditorDialog({ open, mode, vm, onOpenChange, onSave }: VmEditorDialogProps) {
  const [form, setForm] = useState<FormState>(mode === 'edit' ? formFromVm(vm) : emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function saveVm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const ipAddress = form.ipAddress.trim()
    const pemPath = form.pemPath.trim()
    const port = Number(form.port)

    if (!ipAddress) {
      setError('Enter an IP address.')
      return
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Enter a port from 1 to 65535.')
      return
    }

    if (!pemPath) {
      setError('Enter a PEM file path.')
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await onSave({
        name: form.name.trim() || undefined,
        ipAddress,
        user: form.user.trim() || undefined,
        port,
        pemPath,
        os: form.os.trim() || undefined,
      })
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'VM save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white p-4 shadow-xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-slate-950">
                {mode === 'add' ? 'Add VM' : 'Modify VM'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">
                Store the SSH endpoint and PEM file path in the local inventory.
              </Dialog.Description>
            </div>
            <IconButton label="Close VM editor" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>

          <form onSubmit={saveVm} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="IP address" required>
                <input
                  value={form.ipAddress}
                  onChange={(event) => updateField('ipAddress', event.target.value)}
                  autoFocus
                  placeholder="192.168.1.20"
                  className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </Field>
              <Field label="Port" required>
                <input
                  value={form.port}
                  onChange={(event) => updateField('port', event.target.value)}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </Field>
            </div>

            <Field label="PEM file path" required>
              <input
                value={form.pemPath}
                onChange={(event) => updateField('pemPath', event.target.value)}
                placeholder="keys/example.pem"
                className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Display name">
                <input
                  value={form.name}
                  onChange={(event) => updateField('name', event.target.value)}
                  placeholder="remote-build-01"
                  className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </Field>
              <Field label="SSH user">
                <input
                  value={form.user}
                  onChange={(event) => updateField('user', event.target.value)}
                  placeholder="root"
                  className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </Field>
              <Field label="OS">
                <input
                  value={form.os}
                  onChange={(event) => updateField('os', event.target.value)}
                  placeholder="Linux"
                  className="h-9 rounded border border-slate-300 px-3 text-sm font-normal text-slate-900 outline-none focus:border-slate-500"
                />
              </Field>
            </div>

            {error ? <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-8 rounded border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-8 items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <Save className="h-3.5 w-3.5" aria-hidden="true" />
                {saving ? 'Saving' : 'Save VM'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
