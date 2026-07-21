import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createEventsSocket, createVm, getBootstrap, isApiUnavailableError, setApiToken } from './api'
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

describe('WebSocket token transport', () => {
  it('appends the per-boot UI token to the events socket URL as a query parameter', () => {
    const urls: string[] = []
    class FakeWebSocket {
      constructor(url: string) {
        urls.push(url)
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)

    setApiToken('boot-secret')
    const handle = createEventsSocket(() => {})
    handle.close()
    setApiToken(undefined)

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/events')
    expect(urls[0]).toContain('token=boot-secret')
  })
})

describe('getBootstrap token resolution', () => {
  it('prefers the desktop bridge token and skips the dev endpoint', async () => {
    const originalDesktop = window.groveDesktop
    window.groveDesktop = { chooseLocalDirectory: async () => null, getUiToken: async () => 'desktop-token' }
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ runtime: { driver: 'mock', state: 'disabled' } }))
    vi.stubGlobal('fetch', fetchMock)

    const bootstrap = await getBootstrap()

    expect(bootstrap.token).toBe('desktop-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/bootstrap')
    window.groveDesktop = originalDesktop
  })

  it('falls back to the Vite dev token endpoint in the browser', async () => {
    const originalDesktop = window.groveDesktop
    delete window.groveDesktop
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      return Promise.resolve(
        url.includes('/__grove-dev-token')
          ? Response.json({ token: 'dev-token' })
          : Response.json({ runtime: { driver: 'mock', state: 'disabled' } }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const bootstrap = await getBootstrap()

    expect(bootstrap.token).toBe('dev-token')
    expect(bootstrap.runtime).toEqual({ driver: 'mock', state: 'disabled' })
    window.groveDesktop = originalDesktop
  })
})
