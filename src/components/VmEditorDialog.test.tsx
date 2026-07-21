import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { vms } from '../data/fixtures'
import { VmEditorDialog } from './VmEditorDialog'

function renderEdit(keyLabel: string) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const vm = { ...vms[0], connection: { ...vms[0].connection, keyLabel } }
  render(<VmEditorDialog open mode="edit" vm={vm} onOpenChange={() => undefined} onSave={onSave} />)
  const pemInput = screen.getByPlaceholderText('keys/example.pem') as HTMLInputElement
  return { onSave, pemInput, form: pemInput.closest('form') as HTMLFormElement }
}

describe('VmEditorDialog keyless auth modes', () => {
  it('saves an ssh-agent VM without a PEM path, preserving agent auth', async () => {
    const { onSave, pemInput, form } = renderEdit('ssh-agent')

    expect(pemInput.value).toBe('')
    fireEvent.submit(form)

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ pemPath: '', useAgent: true }))
  })

  it('saves a not-configured VM without a PEM path, preserving keyless auth', async () => {
    const { onSave, pemInput, form } = renderEdit('not configured')

    expect(pemInput.value).toBe('')
    fireEvent.submit(form)

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ pemPath: '', useAgent: false }))
  })

  it('still requires a PEM path for key-file VMs', async () => {
    const { onSave, pemInput, form } = renderEdit('ed25519-grove-lab')

    fireEvent.change(pemInput, { target: { value: '' } })
    fireEvent.submit(form)

    expect(await screen.findByText('Enter a PEM file path.')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('switches an ssh-agent VM to key auth once a PEM path is entered', async () => {
    const { onSave, pemInput, form } = renderEdit('ssh-agent')

    fireEvent.change(pemInput, { target: { value: 'keys/orchid.pem' } })
    fireEvent.submit(form)

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ pemPath: 'keys/orchid.pem', useAgent: undefined }))
  })

  it('lets a new VM explicitly use the SSH agent without a key path', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<VmEditorDialog open mode="add" onOpenChange={() => undefined} onSave={onSave} />)

    fireEvent.change(screen.getByLabelText('IP address *'), { target: { value: '192.0.2.10' } })
    fireEvent.change(screen.getByLabelText('SSH authentication *'), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save VM' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ pemPath: '', useAgent: true }))
  })
})
