import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createVm, isApiUnavailableError } from './api'
import type { VmConnectionInput } from '../types'

const vmInput: VmConnectionInput = {
  name: 'edge-lab',
  ipAddress: '192.168.56.10',
  user: 'ubuntu',
  port: 2222,
  pemPath: 'keys/edge.pem',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API errors', () => {
  it('classifies gateway responses as unavailable backend errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })),
    )

    let error: unknown
    try {
      await createVm(vmInput)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Bad Gateway', status: 502 })
    expect(isApiUnavailableError(error)).toBe(true)
  })

  it('keeps validation responses out of the unavailable-backend fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ error: 'Enter a valid IP address.' }, { status: 400, statusText: 'Bad Request' }),
      ),
    )

    let error: unknown
    try {
      await createVm(vmInput)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Enter a valid IP address.', status: 400 })
    expect(isApiUnavailableError(error)).toBe(false)
  })
})
