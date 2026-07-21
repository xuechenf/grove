import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudProviderContext, ProviderMachine } from './cloudProvider'

const { sendMock, destroyMock } = vi.hoisted(() => ({ sendMock: vi.fn(), destroyMock: vi.fn() }))

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    send = sendMock
    destroy = destroyMock
  },
  AuthorizeSecurityGroupIngressCommand: class {},
  DescribeInstancesCommand: class {},
  DescribeRegionsCommand: class {},
  DescribeSecurityGroupRulesCommand: class {},
  RebootInstancesCommand: class {},
  RevokeSecurityGroupIngressCommand: class {},
  StartInstancesCommand: class {},
  StopInstancesCommand: class {},
}))

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = sendMock
    destroy = destroyMock
  },
  GetMetricDataCommand: class {},
}))

import { AwsCloudAdapter } from './awsCloudAdapter'

function context(): CloudProviderContext {
  return {
    profile: {
      id: 'profile-aws',
      kind: 'aws',
      name: 'AWS account',
      isDefault: true,
      secretConfigured: true,
      configuration: { accessKeyId: 'AKIA-test', region: 'us-east-1' },
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    secrets: { secretAccessKey: 'secret' },
  }
}

const machine: ProviderMachine = {
  nativeId: 'i-0123456789',
  location: 'us-east-1',
  name: 'vm',
  state: 'running',
  firewalls: [],
}

describe('AwsCloudAdapter client cleanup', () => {
  beforeEach(() => {
    sendMock.mockReset()
    destroyMock.mockReset()
  })

  it('destroys the EC2 client when the power command fails', async () => {
    sendMock.mockRejectedValue(new Error('Throttling'))
    await expect(new AwsCloudAdapter().power(context(), machine, 'reboot')).rejects.toThrow('Throttling')
    // Regression: the error path used to skip destroy(), leaking keep-alive sockets.
    expect(destroyMock).toHaveBeenCalledOnce()
  })

  it('destroys the EC2 client after a successful power command', async () => {
    sendMock.mockResolvedValue({})
    await new AwsCloudAdapter().power(context(), machine, 'reboot')
    expect(destroyMock).toHaveBeenCalledOnce()
  })

  it('destroys the CloudWatch client when the metrics request fails', async () => {
    sendMock.mockRejectedValue(new Error('Throttling'))
    await expect(new AwsCloudAdapter().getMetrics(context(), machine, 1)).rejects.toThrow('Throttling')
    expect(destroyMock).toHaveBeenCalledOnce()
  })
})
