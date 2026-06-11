import { describe, expect, it } from 'vitest'
import { KeyedMutex } from './mutationLock'

describe('KeyedMutex', () => {
  it('serializes work on the same key', async () => {
    const lock = new KeyedMutex()
    const order: string[] = []
    const slow = lock.run('vm-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first')
    })
    const fast = lock.run('vm-a', async () => {
      order.push('second')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['first', 'second'])
  })

  it('runs different keys concurrently', async () => {
    const lock = new KeyedMutex()
    const order: string[] = []
    const a = lock.run('vm-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('a')
    })
    const b = lock.run('vm-b', async () => {
      order.push('b')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['b', 'a'])
  })

  it('fires onQueued only when the key is already held', async () => {
    const lock = new KeyedMutex()
    let queued = 0
    const first = lock.run('vm-a', () => new Promise<void>((resolve) => setTimeout(resolve, 10)))
    const second = lock.run('vm-a', async () => undefined, () => {
      queued += 1
    })
    await Promise.all([first, second])
    expect(queued).toBe(1)
  })
})
