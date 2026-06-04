import { beforeEach, describe, expect, it } from 'vitest'

import { ModelHarness } from '../../src/harness/harness.ts'
import type { ModelHandle } from '../../src/harness/model-handle.ts'
import {
  getSynthesisFallbackCount,
  type ProjectDoc,
  renderProjectDoc,
  resetSynthesisFallbackCount,
  synthesizeGlobalProfile,
  synthesizeProjectDoc,
  validateProjectDoc,
} from '../../src/synthesis/synthesize.ts'

// ───────────────────────────────────────────────────────────────────────────
// Fake ModelHandle — the ONLY model in these tests. No node-llama-cpp, no model
// load on any path, so the suite passes identically in and out of the sandbox.
// One scripted step per generate() call; the last step repeats once exhausted.
// ───────────────────────────────────────────────────────────────────────────
type Step = { text: string } | { error: Error }

class FakeHandle implements ModelHandle {
  public generateCalls = 0

  constructor(
    private readonly script: Step[],
    private readonly constrained: boolean = true,
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

function harnessOf(script: Step[], constrained = true): { harness: ModelHarness; handle: FakeHandle } {
  const handle = new FakeHandle(script, constrained)
  return { harness: new ModelHarness(handle), handle }
}

const json = (obj: unknown): Step => ({ text: JSON.stringify(obj) })

beforeEach(() => resetSynthesisFallbackCount())

// ───────────────────────────────────────────────────────────────────────────
// 1. structured — well-formed output renders the correct sectioned doc
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeProjectDoc — structured success', () => {
  it('well-formed full output renders every section in priority order', async () => {
    const { harness } = harnessOf([
      json({
        whatThis: 'portable AI memory wallet',
        decisions: ['two-tier store because freshness', 'open/closed at trust boundary'],
        conventions: ['never default exports'],
        gotchas: ['tried JWT refresh, broke on mobile, reverted'],
        openThreads: ['calibrate synthesis floor remotely'],
      }),
    ])

    const doc = await synthesizeProjectDoc(['mem a', 'mem b'], harness)

    expect(doc).toBe(
      [
        'What this is: portable AI memory wallet',
        'Key decisions:\n- two-tier store because freshness\n- open/closed at trust boundary',
        'Conventions:\n- never default exports',
        'Gotchas:\n- tried JWT refresh, broke on mobile, reverted',
        'Open threads:\n- calibrate synthesis floor remotely',
      ].join('\n'),
    )
    expect(getSynthesisFallbackCount()).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. partial — only the sections the model returned appear; NONE are fabricated
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeProjectDoc — partial output is faithful, never padded', () => {
  it('renders only the present sections; omits the rest (no "none" filler)', async () => {
    const { harness } = harnessOf([
      json({ whatThis: 'a CLI tool', decisions: ['picked esbuild for speed'] }),
    ])

    const doc = await synthesizeProjectDoc(['mem'], harness)

    expect(doc).toBe('What this is: a CLI tool\nKey decisions:\n- picked esbuild for speed')
    // The three missing sections are absent — not invented, not stubbed.
    expect(doc).not.toMatch(/Conventions/)
    expect(doc).not.toMatch(/Gotchas/)
    expect(doc).not.toMatch(/Open threads/)
    expect(getSynthesisFallbackCount()).toBe(0)
  })

  it('drops empty arrays and whitespace-only entries (validation, not rendering)', async () => {
    const { harness } = harnessOf([
      json({
        whatThis: '  ',
        decisions: [],
        conventions: ['', '   '],
        gotchas: ['real gotcha', '  '],
      }),
    ])

    const doc = await synthesizeProjectDoc(['mem'], harness)

    // Only the single real gotcha survives; everything empty/whitespace dropped.
    expect(doc).toBe('Gotchas:\n- real gotcha')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. flat — malformed / empty output degrades to the deterministic memory concat
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeProjectDoc — flat floor on a whiff (constrained)', () => {
  it('malformed JSON (retries exhausted) → flat concat of REAL memories, counter++', async () => {
    const { harness, handle } = harnessOf([{ text: 'not json {' }, { text: 'still not json' }])

    const doc = await synthesizeProjectDoc(['lives in Riyadh', 'builds Dhakira'], harness)

    expect(doc).toBe('- lives in Riyadh\n- builds Dhakira')
    expect(handle.generateCalls).toBe(2) // it retried, then fell to flat
    expect(getSynthesisFallbackCount()).toBe(1)
  })

  it('all-empty structured output (validate → null) → flat concat, counter++', async () => {
    const { harness } = harnessOf([json({ decisions: [], gotchas: ['  '] })])

    const doc = await synthesizeProjectDoc(['mem one', 'mem two'], harness)

    expect(doc).toBe('- mem one\n- mem two')
    expect(getSynthesisFallbackCount()).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. unconstrained hard-fail → flat (mirrors the salience external-model path)
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeProjectDoc — unconstrained handle hard-fail → flat', () => {
  it('an external (unconstrained) model returning the wrong shape degrades to flat', async () => {
    const { harness } = harnessOf([{ text: 'prose, not json' }], false)

    const doc = await synthesizeProjectDoc(['real memory'], harness)

    expect(doc).toBe('- real memory')
    expect(getSynthesisFallbackCount()).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. omit — no eligible memories → null, no model call
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeProjectDoc — omit', () => {
  it('empty memory bucket → null and NO model call (caller omits the layer)', async () => {
    const { harness, handle } = harnessOf([json({ whatThis: 'should never run' })])

    const doc = await synthesizeProjectDoc([], harness)

    expect(doc).toBeNull()
    expect(handle.generateCalls).toBe(0)
    expect(getSynthesisFallbackCount()).toBe(0)
  })

  it('flat-also-empty (whiff + whitespace-only memories) → null', async () => {
    const { harness } = harnessOf([{ text: 'garbage' }])

    const doc = await synthesizeProjectDoc(['   ', '\n'], harness)

    expect(doc).toBeNull()
    // No real text could be produced, so this is omission — not a fallback emit.
    expect(getSynthesisFallbackCount()).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. global identity — same ladder, ## Stable / ## Active shape
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeGlobalProfile', () => {
  it('well-formed output renders ## Stable / ## Active', async () => {
    const { harness } = harnessOf([
      json({ stable: ['Based in Riyadh', 'Builder'], active: ['Shipping Dhakira v0.3'] }),
    ])

    const doc = await synthesizeGlobalProfile(['m1', 'm2'], harness)

    expect(doc).toBe('## Stable\n- Based in Riyadh\n- Builder\n\n## Active\n- Shipping Dhakira v0.3')
    expect(getSynthesisFallbackCount()).toBe(0)
  })

  it('whiff → flat concat of real memories, counter++', async () => {
    const { harness } = harnessOf([{ text: 'definitely not json' }])

    const doc = await synthesizeGlobalProfile(['identity fact'], harness)

    expect(doc).toBe('- identity fact')
    expect(getSynthesisFallbackCount()).toBe(1)
  })

  it('empty bucket → null', async () => {
    const { harness } = harnessOf([json({ stable: ['x'] })])
    expect(await synthesizeGlobalProfile([], harness)).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 7. THE LOAD-BEARING SAFETY PROPERTY — a whiffing synthesis NEVER emits
//    fabricated text. Every output line traces to either a model-validated
//    section or a verbatim input memory. Worst case is omission.
// ───────────────────────────────────────────────────────────────────────────
describe('blast-radius: whiffing synthesis never fabricates', () => {
  const realMemories = [
    'Uses Postgres (migrated off Mongo 2026-05)',
    'Prefers dense bullet docs',
    'Standing Order #7: engine must not import proxy/dashboard',
  ]

  it('on EVERY whiff variant, output is EXACTLY the real memories (zero invented text)', async () => {
    const whiffs: Step[][] = [
      [{ text: 'not json at all' }],
      [{ text: '' }],
      [json({})], // valid JSON, but no sections
      [json({ decisions: [], conventions: ['  '] })], // all-empty after validation
      [{ error: new Error('model exploded') }], // infra failure
    ]

    const expectedFlat = realMemories.map((m) => `- ${m}`).join('\n')

    for (const script of whiffs) {
      resetSynthesisFallbackCount()
      const { harness } = harnessOf(script)
      const doc = await synthesizeProjectDoc(realMemories, harness)
      // The ONLY text emitted is the user's own verbatim memories — nothing else.
      expect(doc).toBe(expectedFlat)
      for (const mem of realMemories) expect(doc).toContain(mem)
    }
  })

  it('a partial structured doc never gains a section the model did not return', async () => {
    const { harness } = harnessOf([json({ gotchas: ['only this'] })])
    const doc = await synthesizeProjectDoc(realMemories, harness)
    expect(doc).toBe('Gotchas:\n- only this')
    // No fabricated whatThis/decisions/conventions/openThreads.
    expect(doc).not.toMatch(/What this is|Key decisions|Conventions|Open threads/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 8. validate/render units (the section-omission contract, in isolation)
// ───────────────────────────────────────────────────────────────────────────
describe('validateProjectDoc — section-omission contract', () => {
  it('returns null when nothing survives (triggers the ladder, not a faked doc)', () => {
    expect(validateProjectDoc({})).toBeNull()
    expect(validateProjectDoc({ decisions: [], gotchas: ['   '] })).toBeNull()
    expect(validateProjectDoc('not an object')).toBeNull()
    expect(validateProjectDoc(null)).toBeNull()
  })

  it('keeps only present, non-empty sections', () => {
    const doc = validateProjectDoc({
      whatThis: ' trimmed ',
      decisions: ['a', '  ', 'b'],
      conventions: 'not-an-array',
    }) as ProjectDoc
    expect(doc).toEqual({ whatThis: 'trimmed', decisions: ['a', 'b'] })
  })

  it('renderProjectDoc drops empty sections and keeps Open threads last', () => {
    const rendered = renderProjectDoc({
      openThreads: ['z'],
      whatThis: 'x',
      decisions: ['y'],
    })
    expect(rendered).toBe('What this is: x\nKey decisions:\n- y\nOpen threads:\n- z')
  })
})
