import { describe, expect, it } from 'vitest'
import { TerraformRunner } from './terraformRunner'

interface RunnableRunner {
  run(args: string[], directory: string, environment: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>
}

function runnable(timeoutMs: number) {
  // process.execPath (node) stands in for the terraform binary: `-e` scripts give the test
  // children that either hang forever or exit immediately.
  return new TerraformRunner(process.execPath, { timeoutMs }) as unknown as RunnableRunner
}

describe('TerraformRunner command timeout', () => {
  it('kills a hung terraform child and rejects with a timeout error', async () => {
    const startedAt = Date.now()
    await expect(runnable(250).run(['-e', 'setTimeout(() => {}, 60000)'], process.cwd(), {}))
      .rejects.toThrow(/timed out/)
    // Without the timeout the child (and the environment lock) would be stuck forever.
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('resolves normally when the command finishes before the timeout', async () => {
    const result = await runnable(10_000).run(['-e', 'console.log("plan-ok")'], process.cwd(), {})
    expect(result.stdout).toContain('plan-ok')
  })
})
