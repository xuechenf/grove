/**
 * Per-key async mutex. Mutating work against a single VM serializes so that a fleet prompt,
 * a VM-focused prompt, and the user's own UI actions cannot interleave writes on the same
 * machine. Read-only inspections never take the lock.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly busy = new Set<string>()

  /** True when something already holds the lock for this key (i.e. a waiter would queue). */
  isBusy(key: string) {
    return this.tails.has(key)
  }

  /**
   * Run `task` while holding the lock for `key`. If the lock is already held, `onQueued`
   * fires once before waiting so callers can surface "queued behind…" progress.
   */
  async run<T>(key: string, task: () => Promise<T>, onQueued?: () => void): Promise<T> {
    const previous = this.tails.get(key)
    if (previous) {
      onQueued?.()
    }

    let release!: () => void
    const handle = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = previous ? previous.then(() => handle) : handle
    this.tails.set(key, chained)

    // Uncontended: start the task synchronously so callers observe its side effects
    // (e.g. a published proposal) before yielding to the event loop.
    if (previous) {
      await previous
    }
    this.busy.add(key)
    try {
      return await task()
    } finally {
      this.busy.delete(key)
      release()
      // Drop the tail reference once this is the last queued task for the key.
      if (this.tails.get(key) === chained) {
        this.tails.delete(key)
      }
    }
  }
}
