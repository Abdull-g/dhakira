import { beforeEach, describe, expect, it } from 'vitest'
import type { ExtractedFact } from '../../src/extraction/types.ts'
import {
  getHarnessFloorCount,
  ModelHarness,
  resetHarnessFloorCount,
} from '../../src/harness/harness.ts'
import type { ModelHandle } from '../../src/harness/model-handle.ts'
import { heuristicSalience } from '../../src/salience/heuristic.ts'
import { buildSalienceTask, scoreSalience, validateSalience } from '../../src/salience/salience.ts'

// ---------------------------------------------------------------------------
// Fixtures — a fake ModelHandle wrapped by the REAL ModelHarness, so floor
// accounting (getHarnessFloorCount) is exercised end-to-end. No real model.
// ---------------------------------------------------------------------------

/** A fake handle that emits a fixed text every generate() call. */
class FakeHandle implements ModelHandle {
  public generateCalls = 0

  constructor(
    private readonly text: string,
    private readonly constrained: boolean,
  ) {}

  generate(): Promise<{ text: string; constrained: boolean }> {
    this.generateCalls += 1
    return Promise.resolve({ text: this.text, constrained: this.constrained })
  }

  supportsConstraint(): boolean {
    return this.constrained
  }
}

const IDENTITY_FACT: ExtractedFact = {
  text: 'Lives in Riyadh and works as a backend engineer',
  category: 'IDENTITY',
  confidence: 'HIGH',
}

const EVENT_FACT: ExtractedFact = {
  text: 'Attended a one-off meetup last week',
  category: 'EVENT',
  confidence: 'LOW',
}

// ---------------------------------------------------------------------------
// validateSalience — pure validation/coercion
// ---------------------------------------------------------------------------

describe('validateSalience', () => {
  it('accepts a well-formed score/tier/reason', () => {
    expect(validateSalience({ score: 0.8, tier: 'core', reason: 'core identity' })).toEqual({
      score: 0.8,
      tier: 'core',
      reason: 'core identity',
    })
  })

  it('clamps score > 1 down to 1', () => {
    expect(validateSalience({ score: 1.7, tier: 'core', reason: 'x' })?.score).toBe(1)
  })

  it('clamps score < 0 up to 0', () => {
    expect(validateSalience({ score: -0.5, tier: 'trivia', reason: 'x' })?.score).toBe(0)
  })

  it('coerces a numeric string score', () => {
    expect(validateSalience({ score: '0.42', tier: 'standard', reason: 'x' })?.score).toBeCloseTo(
      0.42,
      5,
    )
  })

  it('rejects a non-numeric score (null → triggers retry/floor)', () => {
    expect(validateSalience({ score: 'abc', tier: 'core', reason: 'x' })).toBeNull()
    expect(validateSalience({ tier: 'core', reason: 'x' })).toBeNull()
  })

  it('enforces the tier enum (unknown tier → null)', () => {
    expect(validateSalience({ score: 0.5, tier: 'bogus', reason: 'x' })).toBeNull()
    expect(validateSalience({ score: 0.5, reason: 'x' })).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(validateSalience(null)).toBeNull()
    expect(validateSalience('nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildSalienceTask — floor closes over the fact being scored
// ---------------------------------------------------------------------------

describe('buildSalienceTask', () => {
  it("names the task 'salience' and floors to the fact's heuristic", () => {
    const task = buildSalienceTask(EVENT_FACT)
    expect(task.name).toBe('salience')
    expect(task.floor?.()).toEqual(heuristicSalience(EVENT_FACT))
  })
})

// ---------------------------------------------------------------------------
// scoreSalience — model-first through the harness, heuristic floor
// ---------------------------------------------------------------------------

describe('scoreSalience', () => {
  beforeEach(() => resetHarnessFloorCount())

  it('constrained: good model output → parsed SalienceScore (no floor)', async () => {
    const handle = new FakeHandle('{"score":0.8,"tier":"core","reason":"core identity"}', true)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(IDENTITY_FACT, harness)

    expect(result).toEqual({ score: 0.8, tier: 'core', reason: 'core identity' })
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('constrained: malformed output → heuristic floor (reason="heuristic floor", floor counted)', async () => {
    const handle = new FakeHandle('not json at all', true)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(EVENT_FACT, harness)

    expect(result).toEqual(heuristicSalience(EVENT_FACT))
    expect(result.reason).toBe('heuristic floor')
    // The harness floor fired (LOUD + counted) for the constrained handle.
    expect(getHarnessFloorCount()).toBe(1)
  })

  it('constrained: out-of-range model score is clamped, NOT floored', async () => {
    const handle = new FakeHandle('{"score":5,"tier":"core","reason":"too eager"}', true)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(IDENTITY_FACT, harness)

    expect(result).toEqual({ score: 1, tier: 'core', reason: 'too eager' })
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('constrained: bad tier every attempt → heuristic floor', async () => {
    const handle = new FakeHandle('{"score":0.9,"tier":"bogus","reason":"x"}', true)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(IDENTITY_FACT, harness)

    expect(result).toEqual(heuristicSalience(IDENTITY_FACT))
    expect(getHarnessFloorCount()).toBe(1)
  })

  it('unconstrained: hard-fail → scoreSalience degrades to heuristic (harness floor NOT used)', async () => {
    const handle = new FakeHandle('garbage', false)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(EVENT_FACT, harness)

    expect(result).toEqual(heuristicSalience(EVENT_FACT))
    expect(result.reason).toBe('heuristic floor')
    // Unconstrained handles never floor inside the harness — the degrade
    // happens inside scoreSalience, so the harness counter stays at 0.
    expect(getHarnessFloorCount()).toBe(0)
  })

  it('unconstrained: good output is still parsed (no needless degrade)', async () => {
    const handle = new FakeHandle('{"score":0.6,"tier":"standard","reason":"useful"}', false)
    const harness = new ModelHarness(handle)

    const result = await scoreSalience(IDENTITY_FACT, harness)

    expect(result).toEqual({ score: 0.6, tier: 'standard', reason: 'useful' })
    expect(getHarnessFloorCount()).toBe(0)
  })
})
