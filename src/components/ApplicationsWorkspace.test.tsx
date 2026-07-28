import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationVersion, GroveApplication } from '../types'
import { vms } from '../data/fixtures'
import { ApplicationsWorkspace } from './ApplicationsWorkspace'

function version(id: string, sequence: number): ApplicationVersion {
  return {
    id,
    label: `v${sequence}`,
    sequence,
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00Z',
    buildLogRelativePath: `builds/${id}.log`,
  }
}

function application(overrides: Partial<GroveApplication> = {}): GroveApplication {
  return {
    id: 'app-demo',
    slug: 'demo',
    name: 'demo-app',
    source: { type: 'local', path: 'D:\\src\\demo' },
    managedSourcePath: 'D:\\grove\\apps\\demo\\source',
    configuration: {
      artifactPath: 'dist',
      startCommand: 'node server.js',
      port: 3000,
      healthCheckPath: '/',
      healthCheckTimeoutSeconds: 30,
      environment: {},
    },
    health: 'unknown',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    versions: [version('v0001-a', 1)],
    deployments: [],
    instances: [],
    environments: [],
    ...overrides,
  }
}

function renderWorkspace(app: GroveApplication) {
  const props = {
    application: app,
    vms,
    credentialProfiles: [],
    terraform: { available: false, detail: 'unavailable' },
    onInstallTerraform: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onSync: vi.fn().mockResolvedValue(undefined),
    onBuild: vi.fn().mockResolvedValue(undefined),
    onDeploy: vi.fn().mockResolvedValue(undefined),
    onLoadLogs: vi.fn().mockResolvedValue([]),
    onOpenVm: vi.fn(),
    onSaveDomain: vi.fn().mockResolvedValue(undefined),
    onRemoveDomain: vi.fn().mockResolvedValue(undefined),
    onCreateEnvironment: vi.fn().mockResolvedValue(undefined),
    onPlanEnvironment: vi.fn().mockResolvedValue(undefined),
    onApplyEnvironment: vi.fn().mockResolvedValue(undefined),
  }
  return { props, ...render(<ApplicationsWorkspace {...props} />) }
}

describe('ApplicationsWorkspace date rendering', () => {
  it('degrades a malformed deployment timestamp instead of crashing the render', () => {
    const app = application({
      deployments: [
        {
          id: 'dep-1',
          applicationId: 'app-demo',
          versionId: 'v0001-a',
          environment: 'production',
          strategy: 'rolling',
          status: 'succeeded',
          createdAt: 'not-a-date',
          targetVmIds: [],
          targets: [],
        },
      ],
    })

    renderWorkspace(app)

    expect(screen.getByText('Latest deployment')).toBeInTheDocument()
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
  })
})

describe('ApplicationsWorkspace deploy dialog', () => {
  it('keeps the user selections when a new build version arrives mid-dialog', async () => {
    const user = userEvent.setup()
    const app = application({
      instances: [
        {
          vmId: 'vm-orchid',
          status: 'healthy',
          remotePath: '/srv/demo',
          unitName: 'demo.service',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
    const { props, rerender } = renderWorkspace(app)

    await user.click(screen.getByRole('button', { name: 'Deploy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deploy demo-app' })

    // Only the instance VM is preselected; add a second target by hand.
    const cedar = within(dialog).getByRole('checkbox', { name: /cedar-db-02/ })
    expect(cedar).not.toBeChecked()
    await user.click(cedar)
    expect(cedar).toBeChecked()

    // A build completes while the dialog is open: the version list gains a new head.
    const rebuilt = application({
      instances: app.instances,
      versions: [version('v0002-b', 2), ...app.versions],
    })
    rerender(<ApplicationsWorkspace {...props} application={rebuilt} />)

    // Re-query: a remounted dialog would reset the manual selection to instance VMs only.
    const dialogAfter = await screen.findByRole('dialog', { name: 'Deploy demo-app' })
    await waitFor(() => expect(within(dialogAfter).getByRole('checkbox', { name: /cedar-db-02/ })).toBeChecked())
    // The new version shows up reactively in the version dropdown.
    const versionSelect = within(dialogAfter).getByRole('combobox')
    expect(within(versionSelect).getByRole('option', { name: 'v2 · v2' })).toBeInTheDocument()
  })
})

describe('ApplicationsWorkspace domain settings', () => {
  it('configures a Name.com hostname for a deployed VM', async () => {
    const user = userEvent.setup()
    const vm = vms[0]!
    const app = application({
      instances: [
        {
          vmId: vm.id,
          status: 'healthy',
          remotePath: '/srv/demo',
          unitName: 'demo.service',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
    const rendered = renderWorkspace(app)
    rendered.rerender(
      <ApplicationsWorkspace
        {...rendered.props}
        application={app}
        credentialProfiles={[
          {
            id: 'namecom-1',
            kind: 'name.com',
            name: 'Name.com primary',
            isDefault: true,
            secretConfigured: true,
            configuration: { username: 'operator' },
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Domain' }))
    await user.type(screen.getByLabelText('Fully-qualified hostname'), 'app.example.com')
    await user.click(screen.getByRole('button', { name: 'Configure domain' }))

    expect(rendered.props.onSaveDomain).toHaveBeenCalledWith({
      hostname: 'app.example.com',
      nameComCredentialProfileId: 'namecom-1',
      vmId: vm.id,
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Name.com DNS is configured.')
  })
})
