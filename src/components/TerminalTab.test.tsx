import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vms } from '../data/fixtures'
import { TerminalTab } from './TerminalTab'

const { createTerminalSocketMock } = vi.hoisted(() => ({ createTerminalSocketMock: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    apiDisabled: () => false,
    createTerminalSocket: (...args: unknown[]) => createTerminalSocketMock(...args),
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {
      /* test double */
    }
    open() {
      /* test double */
    }
    dispose() {
      /* test double */
    }
    onData() {
      return {
        dispose() {
          /* test double */
        },
      }
    }
    write(_text: string, callback?: () => void) {
      callback?.()
    }
    scrollToBottom() {
      /* test double */
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      /* test double */
    }
  },
}))

interface CapturedFrame {
  id: number
  callback: FrameRequestCallback
}

describe('TerminalTab socket lifecycle', () => {
  let frames: CapturedFrame[]
  let nextFrameId: number

  function flushFrames() {
    for (const frame of frames.splice(0)) {
      frame.callback(0)
    }
  }

  beforeEach(() => {
    frames = []
    nextFrameId = 1
    vi.stubGlobal('matchMedia', vi.fn())
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId
      nextFrameId += 1
      frames.push({ id, callback })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames = frames.filter((frame) => frame.id !== id)
    })
    createTerminalSocketMock.mockReturnValue({
      addEventListener: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      readyState: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    createTerminalSocketMock.mockReset()
  })

  it('opens the terminal socket when the mount frame fires', () => {
    render(<TerminalTab vm={vms[0]} onCommand={() => undefined} />)

    flushFrames()

    expect(createTerminalSocketMock).toHaveBeenCalledTimes(1)
    expect(createTerminalSocketMock.mock.calls[0][0]).toBe(vms[0].id)
  })

  it('cancels the mount frame on unmount so no socket leaks', () => {
    const { unmount } = render(<TerminalTab vm={vms[0]} onCommand={() => undefined} />)

    unmount()
    flushFrames()

    expect(createTerminalSocketMock).not.toHaveBeenCalled()
  })

  it('ignores the frame callback itself when it still runs after unmount', () => {
    // React StrictMode's dev double-mount runs cleanup before the frame fires; the
    // callback must respect the disposed flag even if cancellation did not remove it.
    const { unmount } = render(<TerminalTab vm={vms[0]} onCommand={() => undefined} />)
    const orphaned = [...frames]

    unmount()
    frames = []
    for (const frame of orphaned) {
      frame.callback(0)
    }

    expect(createTerminalSocketMock).not.toHaveBeenCalled()
  })
})
