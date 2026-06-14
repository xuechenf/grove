import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { CopilotPanel } from './components/CopilotPanel'

function setup() {
  return {
    user: userEvent.setup(),
    ...render(<App />),
  }
}

/** The app boots on the fleet dashboard; single-VM tests select a VM first. */
async function openOrchid(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Select orchid-build-01/i }))
}

describe('Grove VM console', () => {
  it('renders the VM inventory and switches selected VM context', async () => {
    const { user } = setup()

    // Boot lands on the fleet dashboard ("All VMs" scope).
    expect(screen.getByRole('heading', { name: 'All VMs' })).toBeInTheDocument()

    await openOrchid(user)
    expect(screen.getByRole('heading', { name: 'orchid-build-01' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /cedar-db-02/i }))

    expect(screen.getByRole('heading', { name: 'cedar-db-02' })).toBeInTheDocument()
    expect(screen.getByText('postgresql')).toBeInTheDocument()
  })

  it('switches to the dual-pane file explorer', async () => {
    const { user } = setup()
    await openOrchid(user)

    await user.click(screen.getByRole('tab', { name: /Files/i }))

    expect(screen.getByTestId('files-tab')).toBeInTheDocument()
    expect(screen.getByText('Local machine')).toBeInTheDocument()
    expect(screen.getAllByText('compose-prod.yml').length).toBeGreaterThan(1)
  })

  it('keeps the transfer queue scoped to the files tab', async () => {
    const { user } = setup()
    await openOrchid(user)

    expect(screen.queryByText('Transfer queue')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Files/i }))
    expect(screen.getByText('Transfer queue')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Terminal/i }))
    expect(screen.queryByText('Transfer queue')).not.toBeInTheDocument()
  })

  it('creates and removes AppRunner services in local mode', async () => {
    const { user } = setup()
    await openOrchid(user)

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
    await openOrchid(user)

    await user.click(screen.getByRole('button', { name: /Reboot selected VM/i }))
    expect(screen.getByRole('dialog', { name: /Confirm Reboot/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm action' }))
    await user.click(screen.getByRole('tab', { name: /Activity/i }))

    expect(screen.getByText('Reboot requested')).toBeInTheDocument()
  })

  it('adds an upload transfer job for the selected local file', async () => {
    const { user } = setup()
    await openOrchid(user)

    await user.click(screen.getByRole('tab', { name: /Files/i }))
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(screen.getByText('12.4 MB/s')).toBeInTheDocument()
    expect(screen.getAllByText('grove-upload-demo.txt').length).toBeGreaterThan(1)
  })

  it('clicking All VMs swaps the info panel to the fleet dashboard', async () => {
    const { user } = setup()

    // Start on a single VM, then return to fleet scope.
    await user.click(screen.getByRole('button', { name: /Select cedar-db-02/i }))
    expect(screen.getByRole('heading', { name: 'cedar-db-02' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Overview/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All VMs' }))

    expect(screen.getByRole('heading', { name: 'All VMs' })).toBeInTheDocument()
    expect(screen.getByTestId('fleet-overview-tab')).toBeInTheDocument()
    // The single-VM tab bar is gone in fleet scope.
    expect(screen.queryByRole('tab', { name: /Overview/i })).not.toBeInTheDocument()
    // Per-VM rows with drill-down buttons.
    expect(screen.getByRole('button', { name: 'Open orchid-build-01' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open maple-lab-03' })).toBeInTheDocument()
    // Real alerts listed; the 'No active alerts' placeholder is filtered out.
    expect(screen.getByText(/Disk usage is approaching the 90% warning threshold/)).toBeInTheDocument()
    expect(screen.queryByText('No active alerts')).not.toBeInTheDocument()

    // Drill down from the dashboard back to a single VM.
    await user.click(screen.getByRole('button', { name: 'Open maple-lab-03' }))
    expect(screen.getByRole('heading', { name: 'maple-lab-03' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Overview/i })).toBeInTheDocument()
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

  it('focuses copilot on a VM and resolves a pending action', async () => {
    const { user } = setup()

    // The seeded proposal is scoped to cedar; focus that VM to see it.
    await user.click(screen.getByRole('button', { name: /Select cedar-db-02/i }))

    const proposalTitle = screen.getByText('Explain disk pressure')
    const proposal = proposalTitle.closest('article') as HTMLElement
    expect(proposal).not.toBeNull()

    await user.click(within(proposal).getByRole('button', { name: 'Allow once' }))

    expect(screen.getByText(/Executed: Mock command completed/i)).toBeInTheDocument()
  })

  it('renders the TUI transcript: streaming text, execution steps, thinking, plan, permissions', () => {
    render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          { id: 'm1', role: 'user', content: 'Check disk', timestamp: '00:00', scope: 'vm:vm-orchid', createdAt: 1 },
          { id: 'm2', role: 'assistant', content: 'Checking', timestamp: '00:01', scope: 'vm:vm-orchid', createdAt: 7, streaming: true },
        ]}
        toolCalls={[
          {
            id: 'think1',
            scope: 'vm:vm-orchid',
            title: 'Thinking',
            kind: 'think',
            origin: 'agent',
            status: 'completed',
            output: 'The disk alert points at /var.',
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: 't1',
            scope: 'vm:vm-orchid',
            title: 'run_command',
            kind: 'read',
            status: 'completed',
            detail: 'df -h',
            output: 'line1\nline2\nline3\nline4\nline5\nline6\nline7',
            createdAt: 3,
            updatedAt: 4,
          },
        ]}
        plans={[
          {
            id: 'plan1',
            scope: 'vm:vm-orchid',
            entries: [
              { title: 'Inspect disk usage', status: 'completed' },
              { title: 'Summarize findings', status: 'in_progress' },
            ],
            createdAt: 5,
            updatedAt: 6,
          },
        ]}
        progress={[{ id: 'p1', vmId: 'vm:vm-orchid', scope: 'vm:vm-orchid', title: 'Working', status: 'running', timestamp: '00:01' }]}
        proposals={[
          {
            id: 'pr1',
            vmId: 'vm-orchid',
            scope: 'vm:vm-orchid',
            title: 'Run on orchid-build-01',
            description: 'Restart nginx',
            command: 'sudo systemctl restart nginx',
            actionType: 'custom_command',
            risk: 'medium',
            status: 'awaiting_confirmation',
            createdAt: 8,
          },
        ]}
        isBusy
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.getByText(/Checking/)).toBeInTheDocument()
    expect(screen.getByText('run_command')).toBeInTheDocument()
    expect(screen.getByText(/df -h/)).toBeInTheDocument()
    // A completed step collapses to a 2-line peek; the remaining lines hide behind an expander.
    expect(screen.getByText(/\+5 lines/)).toBeInTheDocument()
    expect(screen.getByText('Thought')).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('Inspect disk usage')).toBeInTheDocument()
    expect(screen.getByText('Summarize findings')).toBeInTheDocument()
    expect(screen.getByText('Run on orchid-build-01')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('expands truncated step output and collapsed thinking on click', async () => {
    const user = userEvent.setup()
    render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[]}
        toolCalls={[
          {
            id: 'think1',
            scope: 'vm:vm-orchid',
            title: 'Thinking',
            kind: 'think',
            origin: 'agent',
            status: 'completed',
            output: 'Hidden reasoning text.',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 't1',
            scope: 'vm:vm-orchid',
            title: 'get_vm',
            kind: 'read',
            origin: 'agent',
            status: 'completed',
            output: 'a\nb\nc\nd\ne\nf\ng\nh',
            createdAt: 2,
            updatedAt: 2,
          },
        ]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.queryByText('Hidden reasoning text.')).not.toBeInTheDocument()
    await user.click(screen.getByText('Thought'))
    expect(screen.getByText('Hidden reasoning text.')).toBeInTheDocument()

    // The completed step shows a short peek; the full output reveals on click.
    expect(screen.queryByText(/a b c d e f g h/)).not.toBeInTheDocument()
    await user.click(screen.getByText(/\+6 lines/))
    expect(screen.getByText(/a b c d e f g h/)).toBeInTheDocument()
    expect(screen.getByText('collapse')).toBeInTheDocument()
  })

  it('groups the transcript into turns and keeps cross-turn steps from colliding', () => {
    const { container } = render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          { id: 'u1', role: 'user', content: 'First question', timestamp: '00:00', scope: 'vm:vm-orchid', createdAt: 1 },
          { id: 'a1', role: 'assistant', content: 'First answer', timestamp: '00:01', scope: 'vm:vm-orchid', createdAt: 4 },
          { id: 'u2', role: 'user', content: 'Second question', timestamp: '00:02', scope: 'vm:vm-orchid', createdAt: 5 },
          { id: 'a2', role: 'assistant', content: 'Second answer', timestamp: '00:03', scope: 'vm:vm-orchid', createdAt: 8 },
        ]}
        toolCalls={[
          // Same agent step id shape across turns must stay two distinct cards (server now
          // scopes ids per turn); here they already differ and must land in the right turn.
          { id: 'agent-a1-1', scope: 'vm:vm-orchid', title: 'list_files', kind: 'read', origin: 'agent', status: 'completed', detail: '/etc', output: 'hosts', createdAt: 2, updatedAt: 2 },
          { id: 'agent-a2-1', scope: 'vm:vm-orchid', title: 'list_files', kind: 'read', origin: 'agent', status: 'completed', detail: '/var', output: 'log', createdAt: 6, updatedAt: 6 },
        ]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    // Both prompts and both answers render exactly once.
    expect(screen.getByText('First question')).toBeInTheDocument()
    expect(screen.getByText('Second question')).toBeInTheDocument()
    expect(screen.getByText('First answer')).toBeInTheDocument()
    expect(screen.getByText('Second answer')).toBeInTheDocument()
    expect(screen.getAllByText('list_files')).toHaveLength(2)

    // Document order is: First question, its step (/etc), First answer, Second question,
    // its step (/var), Second answer — steps stay anchored under the turn that produced them.
    const text = container.textContent ?? ''
    const order = ['First question', '/etc', 'First answer', 'Second question', '/var', 'Second answer'].map((needle) =>
      text.indexOf(needle),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((index) => index >= 0)).toBe(true)
  })

  it('only makes the oldest awaiting proposal actionable when several are pending', () => {
    const base = {
      vmId: 'vm-orchid',
      scope: 'vm:vm-orchid' as const,
      actionType: 'custom_command' as const,
      risk: 'medium' as const,
      status: 'awaiting_confirmation' as const,
    }
    render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[
          { ...base, id: 'pr1', title: 'Restart nginx', description: 'first', command: 'sudo systemctl restart nginx', createdAt: 1 },
          { ...base, id: 'pr2', title: 'Clear cache', description: 'second', command: 'sudo rm -rf /tmp/cache', createdAt: 2 },
        ]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    // Exactly one set of decision buttons: the older card's.
    expect(screen.getAllByRole('button', { name: 'Allow once' })).toHaveLength(1)
    expect(screen.getByText('Queued — decide the command above first.')).toBeInTheDocument()
    expect(screen.getByText('sudo systemctl restart nginx').closest('article')).toContainElement(
      screen.getByRole('button', { name: 'Allow once' }),
    )
  })

  it('acknowledges a decided proposal with an executing state instead of buttons', () => {
    render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[
          {
            id: 'pr1',
            vmId: 'vm-orchid',
            scope: 'vm:vm-orchid',
            title: 'Run on orchid-build-01',
            description: 'Restart nginx',
            command: 'sudo systemctl restart nginx',
            actionType: 'custom_command',
            risk: 'medium',
            status: 'awaiting_confirmation',
            decision: 'allow_once',
            createdAt: 1,
          },
        ]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.getByText('Allowed — executing…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('renders completed assistant messages as formatted markdown', () => {
    render(
      <CopilotPanel
        scope="fleet"
        scopeLabel="All VMs"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content:
              '## Disk report\n\nThe partition `/dev/sda1` is **almost full**.\n\n- clean `/var/log`\n- see [docs](https://example.com/docs)\n\n```bash\ndf -h /var\n```',
            timestamp: '00:01',
            scope: 'fleet',
            createdAt: 1,
          },
        ]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Disk report' })).toBeInTheDocument()
    expect(screen.getByText('/dev/sda1')).toBeInTheDocument()
    expect(screen.getByText('almost full')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('df -h /var')).toBeInTheDocument()
  })

  it('renders OpenUI operator briefs inside assistant messages', async () => {
    render(
      <CopilotPanel
        scope="fleet"
        scopeLabel="All VMs"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: 'Fleet needs one follow-up.',
            openUi: {
              type: 'openui',
              content:
                'root = OperatorBrief("Fleet attention", "fleet", "warning", "One VM needs attention", [{ label: "Alerts", value: "1", detail: "orchid-build-01" }], [{ id: "vm-orchid", name: "orchid-build-01", health: "warning", lifecycle: "running", detail: "disk pressure" }])',
            },
            timestamp: '00:01',
            scope: 'fleet',
            createdAt: 1,
          },
        ]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.getByText('Fleet needs one follow-up.')).toBeInTheDocument()
    expect(await screen.findByTestId('openui-operator-brief')).toBeInTheDocument()
    expect(screen.getByText('Fleet attention')).toBeInTheDocument()
    expect(screen.getByText('One VM needs attention')).toBeInTheDocument()
    expect(screen.getAllByText('orchid-build-01').length).toBeGreaterThan(0)
    expect(screen.getByText('disk pressure')).toBeInTheDocument()
  })

  it('keeps markdown fallback visible when OpenUI output is invalid', () => {
    render(
      <CopilotPanel
        scope="fleet"
        scopeLabel="All VMs"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: 'Fallback summary still renders.',
            openUi: { type: 'openui', content: 'root = NotARealBrief("bad")' },
            timestamp: '00:01',
            scope: 'fleet',
            createdAt: 1,
          },
        ]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    expect(screen.getByText('Fallback summary still renders.')).toBeInTheDocument()
    expect(screen.getByTestId('openui-artifact')).toBeInTheDocument()
  })

  it('dispatches safe OpenUI actions to navigation and follow-up handlers', async () => {
    const user = userEvent.setup()
    const onOpenWorkspaceTarget = vi.fn()
    const onSendMessage = vi.fn()
    render(
      <CopilotPanel
        scope="fleet"
        scopeLabel="All VMs"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            openUi: {
              type: 'openui',
              content:
                'root = OperatorBrief("Actions", null, null, null, null, null, null, null, null, null, [{ kind: "focus_vm", label: "Open orchid", vmId: "vm-orchid" }, { kind: "open_tab", label: "Open AppRunner", vmId: "vm-orchid", tab: "apprunner" }, { kind: "ask_followup", label: "Inspect logs", message: "Inspect nginx logs" }, { kind: "request_fix", label: "Fix disk", vmId: "vm-orchid", message: "Disk usage is high" }])',
            },
            timestamp: '00:01',
            scope: 'fleet',
            createdAt: 1,
          },
        ]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={onSendMessage}
        onOpenWorkspaceTarget={onOpenWorkspaceTarget}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Open orchid' }))
    await user.click(screen.getByRole('button', { name: 'Open AppRunner' }))
    await user.click(screen.getByRole('button', { name: 'Inspect logs' }))
    await user.click(screen.getByRole('button', { name: 'Fix disk' }))

    await waitFor(() => {
      expect(onOpenWorkspaceTarget).toHaveBeenNthCalledWith(1, { vmId: 'vm-orchid' })
      expect(onOpenWorkspaceTarget).toHaveBeenNthCalledWith(2, { vmId: 'vm-orchid', tab: 'apprunner' })
      expect(onSendMessage).toHaveBeenNthCalledWith(1, 'Inspect nginx logs')
      expect(onSendMessage).toHaveBeenNthCalledWith(
        2,
        'Propose a safe Grove-confirmed fix on vm-orchid: Disk usage is high',
      )
    })
  })

  it('passes the reference-history flag from the input checkbox', async () => {
    const user = userEvent.setup()
    const onSendMessage = vi.fn()
    const props = {
      scope: 'fleet' as const,
      scopeLabel: 'All VMs',
      runtime: { driver: 'mock' as const, state: 'ready' as const },
      messages: [],
      toolCalls: [],
      plans: [],
      progress: [],
      proposals: [],
      isBusy: false,
      onDecideProposal: () => undefined,
      onCancel: () => undefined,
    }
    render(<CopilotPanel {...props} onSendMessage={onSendMessage} />)

    const checkbox = screen.getByRole('checkbox', { name: /reference history/i })
    expect(checkbox).not.toBeChecked()

    await user.type(screen.getByLabelText('Copilot message'), 'unchecked ask')
    await user.click(screen.getByRole('button', { name: 'Send copilot message' }))
    expect(onSendMessage).toHaveBeenLastCalledWith('unchecked ask', { referenceHistory: false })

    await user.click(checkbox)
    await user.type(screen.getByLabelText('Copilot message'), 'checked ask')
    await user.click(screen.getByRole('button', { name: 'Send copilot message' }))
    expect(onSendMessage).toHaveBeenLastCalledWith('checked ask', { referenceHistory: true })
  })

  it('reveals the full SSH console dump behind a step\'s console-log toggle', async () => {
    const user = userEvent.setup()
    render(
      <CopilotPanel
        scope="vm:vm-orchid"
        scopeLabel="orchid-build-01"
        runtime={{ driver: 'mock', state: 'ready' }}
        messages={[]}
        toolCalls={[
          {
            id: 'tc1',
            scope: 'vm:vm-orchid',
            title: 'run_command',
            kind: 'execute',
            status: 'completed',
            vmId: 'vm-orchid',
            detail: 'df -h /var',
            output: '/dev/vda1 100G 42G 58G 42% /var',
            consoleLog: '$ df -h /var\n/dev/vda1  100G  42G  58G  42% /var\n[exit 0]',
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
      />,
    )

    // The dump is hidden until requested.
    expect(screen.queryByTestId('tool-console-log')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /console log/i }))
    const log = screen.getByTestId('tool-console-log')
    expect(log).toHaveTextContent('$ df -h /var')
    expect(log).toHaveTextContent('[exit 0]')

    await user.click(screen.getByRole('button', { name: /hide console log/i }))
    expect(screen.queryByTestId('tool-console-log')).not.toBeInTheDocument()
  })

  function renderPanel(overrides: Partial<Parameters<typeof CopilotPanel>[0]> = {}) {
    return render(
      <CopilotPanel
        scope="fleet"
        scopeLabel="All VMs"
        runtime={{ driver: 'print', state: 'ready', kimiInstalled: false }}
        messages={[]}
        toolCalls={[]}
        plans={[]}
        progress={[]}
        proposals={[]}
        isBusy={false}
        onSendMessage={() => undefined}
        onDecideProposal={() => undefined}
        onCancel={() => undefined}
        {...overrides}
      />,
    )
  }

  it('offers a kimi-code install prompt when the CLI is not detected', async () => {
    const user = userEvent.setup()
    const onInstall = vi.fn()
    renderPanel({ onInstall })

    const banner = screen.getByTestId('kimi-install-banner')
    expect(banner).toHaveTextContent('kimi-code CLI not detected')

    await user.click(screen.getByRole('button', { name: /download & install kimi-code/i }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('streams the install log and disables the button while installing', () => {
    renderPanel({ install: { status: 'running', log: 'Installing uv…\nFetching kimi-cli…' } })

    expect(screen.getByTestId('kimi-install-log')).toHaveTextContent('Fetching kimi-cli')
    expect(screen.getByRole('button', { name: /installing/i })).toBeDisabled()
  })

  it('hides the install prompt once kimi is detected', () => {
    renderPanel({ runtime: { driver: 'print', state: 'ready', kimiInstalled: true } })
    expect(screen.queryByTestId('kimi-install-banner')).not.toBeInTheDocument()
  })
})
