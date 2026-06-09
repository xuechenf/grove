import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { CopilotPanel } from './components/CopilotPanel'
import { vms as fixtureVms } from './data/fixtures'

function setup() {
  return {
    user: userEvent.setup(),
    ...render(<App />),
  }
}

describe('Grove VM console', () => {
  it('renders the VM inventory and switches selected VM context', async () => {
    const { user } = setup()

    expect(screen.getByRole('heading', { name: 'orchid-build-01' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /cedar-db-02/i }))

    expect(screen.getByRole('heading', { name: 'cedar-db-02' })).toBeInTheDocument()
    expect(screen.getByText('postgresql')).toBeInTheDocument()
  })

  it('switches to the dual-pane file explorer', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('tab', { name: /Files/i }))

    expect(screen.getByTestId('files-tab')).toBeInTheDocument()
    expect(screen.getByText('Local machine')).toBeInTheDocument()
    expect(screen.getAllByText('compose-prod.yml').length).toBeGreaterThan(1)
  })

  it('keeps the transfer queue scoped to the files tab', async () => {
    const { user } = setup()

    expect(screen.queryByText('Transfer queue')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Files/i }))
    expect(screen.getByText('Transfer queue')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Terminal/i }))
    expect(screen.queryByText('Transfer queue')).not.toBeInTheDocument()
  })

  it('creates and removes AppRunner services in local mode', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('tab', { name: /AppRunner/i }))

    expect(screen.getByTestId('apprunner-tab')).toBeInTheDocument()
    expect(screen.getByText('preview-api')).toBeInTheDocument()
    expect(screen.getByText('~/services/preview-api')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create service' }))

    const dialog = screen.getByRole('dialog', { name: 'Create service' })
    await user.type(within(dialog).getByLabelText(/Service name/i), 'local-api')
    await user.clear(within(dialog).getByLabelText(/Port/i))
    await user.type(within(dialog).getByLabelText(/Port/i), '3099')
    await user.click(within(dialog).getByRole('button', { name: 'Create service' }))

    expect(screen.getByText('local-api')).toBeInTheDocument()
    expect(screen.getByText('~/services/local-api')).toBeInTheDocument()
    expect(screen.getByText('3099')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove local-api' }))
    await user.click(screen.getByRole('button', { name: 'Remove service' }))

    expect(screen.queryByText('local-api')).not.toBeInTheDocument()
  })

  it('confirms a lifecycle action and records activity', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: /Reboot selected VM/i }))
    expect(screen.getByRole('dialog', { name: /Confirm Reboot/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm action' }))
    await user.click(screen.getByRole('tab', { name: /Activity/i }))

    expect(screen.getByText('Reboot requested')).toBeInTheDocument()
  })

  it('adds an upload transfer job for the selected local file', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('tab', { name: /Files/i }))
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(screen.getByText('12.4 MB/s')).toBeInTheDocument()
    expect(screen.getAllByText('grove-upload-demo.txt').length).toBeGreaterThan(1)
  })

  it('adds and modifies VM connection profiles', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'Add VM' }))

    const addDialog = screen.getByRole('dialog', { name: 'Add VM' })
    await user.type(within(addDialog).getByLabelText(/IP address/i), '192.168.56.10')
    await user.clear(within(addDialog).getByLabelText(/Port/i))
    await user.type(within(addDialog).getByLabelText(/Port/i), '2222')
    await user.type(within(addDialog).getByLabelText(/PEM file path/i), 'keys/edge.pem')
    await user.type(within(addDialog).getByLabelText(/Display name/i), 'edge-lab')
    await user.click(within(addDialog).getByRole('button', { name: 'Save VM' }))

    expect(screen.getByRole('heading', { name: 'edge-lab' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Settings/i }))
    expect(screen.getAllByText('192.168.56.10').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(screen.getByText('passed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Modify VM' }))

    const editDialog = screen.getByRole('dialog', { name: 'Modify VM' })
    await user.clear(within(editDialog).getByLabelText(/Port/i))
    await user.type(within(editDialog).getByLabelText(/Port/i), '2200')
    await user.clear(within(editDialog).getByLabelText(/PEM file path/i))
    await user.type(within(editDialog).getByLabelText(/PEM file path/i), 'keys/edge-updated.pem')
    await user.click(within(editDialog).getByRole('button', { name: 'Save VM' }))

    expect(screen.getByText('2200')).toBeInTheDocument()
    expect(screen.getByText('keys/edge-updated.pem')).toBeInTheDocument()
  })

  it('creates and confirms a contextual copilot proposal', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'Inspect logs' }))

    const proposalTitle = screen.getByText('Inspect logs on orchid-build-01')
    const proposal = proposalTitle.closest('article')
    expect(proposal).not.toBeNull()

    await user.click(within(proposal as HTMLElement).getByRole('button', { name: 'Confirm action' }))

    expect(screen.getByText(/Executed: Mock command completed/i)).toBeInTheDocument()
  })

  it('shows only the current copilot execution steps', () => {
    render(
      <CopilotPanel
        vm={fixtureVms[0]}
        activeTab="overview"
        messages={[
          {
            id: 'msg-user-2000000000000',
            role: 'user',
            content: 'Check runtime',
            timestamp: '00:00',
            contextVmId: fixtureVms[0].id,
            contextTab: 'overview',
          },
        ]}
        progress={[
          {
            id: 'copilot-progress-2000000000200',
            vmId: fixtureVms[0].id,
            title: 'Reading live runtime',
            detail: 'systemctl and ps',
            status: 'running',
            timestamp: '00:01',
          },
          {
            id: 'copilot-progress-2000000000100',
            vmId: fixtureVms[0].id,
            title: 'Queued copilot request',
            detail: 'current request',
            status: 'running',
            timestamp: '00:01',
          },
          {
            id: 'copilot-progress-1999999999200',
            vmId: fixtureVms[0].id,
            title: 'Old request finished',
            detail: 'previous request',
            status: 'completed',
            timestamp: '23:59',
          },
          {
            id: 'copilot-progress-1999999999100',
            vmId: fixtureVms[0].id,
            title: 'Queued copilot request',
            detail: 'old request',
            status: 'running',
            timestamp: '23:59',
          },
        ]}
        proposals={[]}
        isBusy
        onSendMessage={() => undefined}
        onCreateProposal={() => undefined}
        onConfirmProposal={() => undefined}
      />,
    )

    expect(screen.getByText('Current execution / 00:01')).toBeInTheDocument()
    expect(screen.getByText('Reading live runtime')).toBeInTheDocument()
    expect(screen.queryByText('Old request finished')).not.toBeInTheDocument()
    expect(screen.queryByText('previous request')).not.toBeInTheDocument()
  })
})
