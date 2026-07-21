import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { localFiles, vms as fixtureVms } from './data/fixtures'
import { ApiError } from './lib/api'
import type { AppSnapshot, ServerEvent, VmOverviewTelemetry } from './types'

/**
 * Unlike App.test.tsx (which runs with the API disabled), this suite enables the API and
 * drives the backend-facing flows: error discrimination, socket-event races, and the
 * copilot busy lifecycle.
 */
const mocks = vi.hoisted(() => ({
  getBootstrap: vi.fn(),
  createEventsSocket: vi.fn(),
  getVmOverview: vi.fn(),
  refreshVm: vi.fn(),
  rebootVm: vi.fn(),
  deleteVm: vi.fn(),
  decideCopilotProposal: vi.fn(),
  sendCopilotMessage: vi.fn(),
  createTransfer: vi.fn(),
  getCopilotProvider: vi.fn(),
  getTerraformStatus: vi.fn(),
  listLocalFiles: vi.fn(),
  getLocalDefaults: vi.fn(),
}))

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    apiDisabled: () => false,
    getBootstrap: mocks.getBootstrap,
    createEventsSocket: mocks.createEventsSocket,
    getVmOverview: mocks.getVmOverview,
    refreshVm: mocks.refreshVm,
    rebootVm: mocks.rebootVm,
    deleteVm: mocks.deleteVm,
    decideCopilotProposal: mocks.decideCopilotProposal,
    sendCopilotMessage: mocks.sendCopilotMessage,
    createTransfer: mocks.createTransfer,
    getCopilotProvider: mocks.getCopilotProvider,
    getTerraformStatus: mocks.getTerraformStatus,
    listLocalFiles: mocks.listLocalFiles,
    getLocalDefaults: mocks.getLocalDefaults,
  }
})

let emitServerEvent: (event: ServerEvent) => void = () => undefined

function emit(event: ServerEvent) {
  act(() => emitServerEvent(event))
}

function snapshotPayload(): AppSnapshot {
  return {
    vms: fixtureVms,
    applications: [],
    settings: { schemaVersion: 2, workspacePath: 'D:\\grove', workspaceStatus: 'healthy', credentialProfiles: [] },
    transfers: [],
    messages: [],
    proposals: [],
    toolCalls: [],
    plans: [],
    runtime: { driver: 'mock', state: 'ready' },
    install: { status: 'idle', log: '' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  emitServerEvent = () => undefined
  mocks.getBootstrap.mockRejectedValue(new Error('no backend in test'))
  mocks.getCopilotProvider.mockRejectedValue(new Error('no backend in test'))
  mocks.getTerraformStatus.mockRejectedValue(new Error('no backend in test'))
  mocks.getVmOverview.mockReturnValue(new Promise(() => undefined))
  mocks.listLocalFiles.mockResolvedValue(localFiles)
  mocks.getLocalDefaults.mockResolvedValue({
    workspacePath: 'D:\\grove',
    homePath: 'C:\\Users\\test',
    downloadsPath: 'C:\\Users\\test\\Downloads',
    localFilesPath: 'D:\\',
    pathSeparator: '\\',
  })
  mocks.createEventsSocket.mockImplementation((onEvent: (event: ServerEvent) => void) => {
    emitServerEvent = onEvent
    return { close: vi.fn() }
  })
})

describe('Grove VM console (API mode)', () => {
  it('tolerates a failing copilot provider request without an unhandled rejection', async () => {
    mocks.getCopilotProvider.mockRejectedValue(new ApiError('provider endpoint exploded', 500))

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'All VMs' })).toBeInTheDocument()
  })

  it('does not resurrect a deleted VM from a late telemetry response or vm.updated', async () => {
    let resolveOverview: (value: VmOverviewTelemetry) => void = () => undefined
    const overviewPending = new Promise<VmOverviewTelemetry>((resolve) => {
      resolveOverview = resolve
    })
    mocks.getVmOverview.mockImplementation((vmId: string) =>
      vmId === 'vm-orchid' ? overviewPending : new Promise(() => undefined),
    )
    render(<App />)

    // The server confirms the delete while the overview fetch is still in flight.
    emit({ type: 'vm.deleted', payload: { vmId: 'vm-orchid' } })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Select orchid-build-01/i })).not.toBeInTheDocument(),
    )

    // The late response must not bring the VM back.
    await act(async () => {
      resolveOverview({
        vm: fixtureVms[0],
        source: 'host',
        sourceLabel: 'Host over SSH',
        sampledAt: 'now',
        warnings: [],
      })
      await overviewPending
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: /Select orchid-build-01/i })).not.toBeInTheDocument()

    // Neither does a vm.updated for the deleted id...
    emit({ type: 'vm.updated', payload: { ...fixtureVms[0], name: 'orchid-ghost' } })
    expect(screen.queryByRole('button', { name: /orchid-ghost/i })).not.toBeInTheDocument()

    // ...while vm.updated still refreshes VMs that are actually present.
    emit({ type: 'vm.updated', payload: { ...fixtureVms[1], name: 'cedar-renamed' } })
    expect(await screen.findByRole('button', { name: /Select cedar-renamed/i })).toBeInTheDocument()
  })

  it('re-enables the composer when the turn POST resolves without a progress event', async () => {
    mocks.sendCopilotMessage.mockResolvedValue({ messages: [], proposals: [] })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.type(screen.getByLabelText('Copilot message'), 'check disk')
    await user.click(screen.getByRole('button', { name: 'Send copilot message' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument())
  })

  it('clears a stuck busy scope when a fresh snapshot arrives', async () => {
    // The turn POST never settles client-side, simulating a backend restart mid-turn.
    mocks.sendCopilotMessage.mockReturnValue(new Promise(() => undefined))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.type(screen.getByLabelText('Copilot message'), 'long turn')
    await user.click(screen.getByRole('button', { name: 'Send copilot message' }))
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()

    emit({ type: 'snapshot', payload: snapshotPayload() })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument())
  })

  it('surfaces a real SSH test failure instead of faking a pass', async () => {
    mocks.refreshVm.mockRejectedValue(new ApiError('permission denied (publickey)', 500))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.click(screen.getByRole('tab', { name: /Settings/i }))
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await user.click(screen.getByRole('tab', { name: /Activity/i }))
    expect(await screen.findByText('SSH test failed')).toBeInTheDocument()
    expect(screen.queryByText('SSH test passed')).not.toBeInTheDocument()
  })

  it('keeps the offline test-connection fallback when the backend is unavailable', async () => {
    mocks.refreshVm.mockRejectedValue(new ApiError('backend restarting', 503))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.click(screen.getByRole('tab', { name: /Settings/i }))
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('passed')).toBeInTheDocument()
  })

  it('records a failed reboot instead of a fake "Reboot requested"', async () => {
    mocks.rebootVm.mockRejectedValue(new ApiError('reboot command failed', 500))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.click(screen.getByRole('button', { name: /Reboot selected VM/i }))
    await user.click(screen.getByRole('button', { name: 'Confirm action' }))

    await user.click(screen.getByRole('tab', { name: /Activity/i }))
    expect(await screen.findByText('Reboot failed')).toBeInTheDocument()
    expect(screen.queryByText('Reboot requested')).not.toBeInTheDocument()
  })

  it('reverts the optimistic proposal decision when the backend rejects it', async () => {
    mocks.decideCopilotProposal.mockRejectedValue(new ApiError('policy engine exploded', 500))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select cedar-db-02/i }))
    const proposalTitle = screen.getByText('Explain disk pressure')
    await user.click(within(proposalTitle.closest('article') as HTMLElement).getByRole('button', { name: 'Allow once' }))

    // The card becomes actionable again instead of pretending the command executed.
    const proposal = screen.getByText('Explain disk pressure').closest('article') as HTMLElement
    await waitFor(() => expect(within(proposal).getByRole('button', { name: 'Allow once' })).toBeInTheDocument())
    expect(screen.queryByText(/Executed: Mock command completed/)).not.toBeInTheDocument()
  })

  it('shows a failed transfer with the server error instead of fabricated progress', async () => {
    mocks.createTransfer.mockRejectedValue(new ApiError('No space left on device', 400))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.click(screen.getByRole('tab', { name: /Files/i }))
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText('No space left on device')).toBeInTheDocument()
    expect(screen.queryByText('12.4 MB/s')).not.toBeInTheDocument()
  })

  it('keeps the mock transfer fallback when the backend is unavailable', async () => {
    mocks.createTransfer.mockRejectedValue(new ApiError('backend restarting', 503))
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
    await user.click(screen.getByRole('tab', { name: /Files/i }))
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText('12.4 MB/s')).toBeInTheDocument()
  })
})
