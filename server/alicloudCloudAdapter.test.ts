import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudProviderContext, ProviderMachine } from './cloudProvider'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('@alicloud/pop-core', () => ({
  default: class {
    request = requestMock
  },
}))

import { AlicloudCloudAdapter } from './alicloudCloudAdapter'

function context(): CloudProviderContext {
  return {
    profile: {
      id: 'profile-ali',
      kind: 'alicloud',
      name: 'Alibaba account',
      isDefault: true,
      secretConfigured: true,
      configuration: { accessKeyId: 'LTAI-test', region: 'cn-beijing' },
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    secrets: { accessKeySecret: 'secret' },
  }
}

const machine: ProviderMachine = {
  nativeId: 'i-bp1example',
  location: 'cn-beijing',
  name: 'vm',
  state: 'running',
  firewalls: [],
}

describe('AlicloudCloudAdapter metrics pagination', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('follows NextToken until the requested metrics window is complete', async () => {
    requestMock.mockImplementation(async (action: string, parameters: Record<string, unknown>) => {
      expect(action).toBe('DescribeMetricList')
      if (!parameters.NextToken) {
        return {
          Datapoints: JSON.stringify([
            { timestamp: 1_752_000_000_000, Average: 1 },
            { timestamp: 1_752_000_000_060, Average: 2 },
          ]),
          NextToken: 'page-2',
        }
      }
      expect(parameters.NextToken).toBe('page-2')
      return { Datapoints: JSON.stringify([{ timestamp: 1_752_000_000_120, Average: 3 }]) }
    })

    const metrics = await new AlicloudCloudAdapter().getMetrics(context(), machine, 48)

    const cpu = metrics.series.find((series) => series.key === 'cpuPercent')
    // Regression: page 2 used to be dropped, silently truncating windows beyond ~16.7h.
    expect(cpu?.points).toHaveLength(3)
    expect(requestMock).toHaveBeenCalledTimes(6) // 2 pages x 3 metric definitions
  })

  it('stops at the page bound instead of looping forever on a stuck NextToken', async () => {
    requestMock.mockResolvedValue({
      Datapoints: JSON.stringify([{ timestamp: 1_752_000_000_000, Average: 1 }]),
      NextToken: 'same-token-forever',
    })

    const metrics = await new AlicloudCloudAdapter().getMetrics(context(), machine, 1)

    expect(metrics.series.find((series) => series.key === 'cpuPercent')?.points.length).toBeGreaterThan(0)
    expect(requestMock).toHaveBeenCalledTimes(60) // 20-page bound x 3 metric definitions
  })
})
