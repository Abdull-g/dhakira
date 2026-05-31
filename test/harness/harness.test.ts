import { beforeEach, describe, expect, it } from 'vitest'

import {
  getHarnessFloorCount,
  ModelHarness,
  resetHarnessFloorCount,
} from '../../src/harness/harness.ts'
import type { ModelHandle } from '../../src/harness/model-handle.ts'
import type { HarnessSchema, HarnessTask } from '../../src/harness/types.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Payload {
  n: number
}

/** Validates `{ n: number }`; anything else is invalid (null → retry/floor/fail). */
const schema: HarnessSchema<Payload> = {
  jsonSchema: { type: 'object', properties: { n: { type: 'number' } } },
  validate(parsed: unknown): Payload | null {
    const obj = parsed as Record<string, unknown>
    return typeof obj?.n === 'number' ? { n: obj.n } : null
  },
}

/** One scripted generation step: emit `text`, or throw `error`. */
type Step = { text: string } | { error: Error }

/**
 * A fake ModelHandle driven by a script of steps (one per generate() call).
 * Once the script is exhausted it repeats the last step. Tracks call count so
 * tests can assert retry / no-retry behavior.
 */
class FakeHandle implements ModelHandle {
  public generateCalls = 0

  constructor(
    private readonly script: Step[],
    private readonly constrained: boolean,
  ) {}

  generate(): Promise<{ text: string; constrained: boolean }> {
    const step = this.script[Math.min(this.generateCalls, this.script.length - 1)]
    this.generateCalls += 1
    if ('error' in step) return Promise.reject(step.error)
    return Promise.resolve({ text: step.text, constrained: this.constrained })
  }

  supportsConstraint(): boolean {
    return this.constrained
  }
}

const taskWithFloor: HarnessTask<Payload> = {
  name: 'test-task',
  schema,
  floor: () => ({ n: -1 }),
  failureMessage: 'custom failure message',
}

// ---------------------------------------------------------------------------
// Tests — NEW harness behavior (did not exist before T02)
// ---------------------------------------------------------------------------

describe('ModelHarness.run', () => {
  beforeEach(() => resetHarnessFloorCount())

  it('constrained: parse-fail on attempt 1, valid retry succeeds on attempt 2', async () => {
    const handle = new FakeHandle([{ text: 'not json {' }, { text: '{"n":42}' }], true)
    const harness = new ModelHarness(handle)

    const result = await harness.run(taskWithFloor, 'prompt')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.value).toEqual({ n: 42 })
    expect(result.value.meta.attempts).toBe(2)
    expect(result.value.meta.usedFloor).toBe(false)
    expect(result.value.meta.constrained).toBe(true)
    expect(handle.generateCalls).toBe(2)
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('constrained: exhausted attempts → floor fires (usedFloor, floor value, counter increments)', async () => {
    const handle = new FakeHandle([{ text: 'nope' }, { text: 'still nope' }], true)
    const harness = new ModelHarness(handle)

    const result = await harness.run(taskWithFloor, 'prompt', { maxAttempts: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.value).toEqual({ n: -1 })
    expect(result.value.meta.usedFloor).toBe(true)
    expect(result.value.meta.attempts).toBe(2)
    expect(result.value.meta.constrained).toBe(true)
    expect(handle.generateCalls).toBe(2)
    expect(getHarnessFloorCount()).toBe(1)
  })

  it('unconstrained: invalid output → hard-fail with failureMessage, NO floor', async () => {
    const handle = new FakeHandle([{ text: 'wrong shape' }], false)
    const harness = new ModelHarness(handle)

    const result = await harness.run(taskWithFloor, 'prompt', { maxAttempts: 1 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('custom failure message')
    // The task HAS a floor, but it must NOT fire for an unconstrained handle.
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('generate() throw → immediate ok:false, no retry, no floor', async () => {
    const handle = new FakeHandle(
      [{ error: new Error('model exploded') }, { text: '{"n":1}' }],
      true,
    )
    const harness = new ModelHarness(handle)

    const result = await harness.run(taskWithFloor, 'prompt', { maxAttempts: 2 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('model exploded')
    // Terminal on the throwing attempt — no retry into attempt 2, no floor.
    expect(handle.generateCalls).toBe(1)
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('clean first-try success → attempts:1, usedFloor:false', async () => {
    const handle = new FakeHandle([{ text: '{"n":7}' }], true)
    const harness = new ModelHarness(handle)

    const result = await harness.run(taskWithFloor, 'prompt')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.value).toEqual({ n: 7 })
    expect(result.value.meta.attempts).toBe(1)
    expect(result.value.meta.usedFloor).toBe(false)
    expect(result.value.meta.constrained).toBe(true)
    expect(handle.generateCalls).toBe(1)
  })
})
