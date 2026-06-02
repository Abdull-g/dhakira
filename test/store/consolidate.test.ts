import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock buildExtractionHarness so runConsolidation gets our FAKE harness instead
// of a real model handle — this file must NEVER load the qmd/llama models. The
// store is mocked too (search/update). Mirrors the salience tests' injection.
vi.mock('../../src/extraction/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extraction/extract.js')>()
  return { ...actual, buildExtractionHarness: vi.fn() }
})

import { buildExtractionHarness } from '../../src/extraction/extract.js'
import { writeMemoryFile } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'
import type { ModelHarness } from '../../src/harness/harness.ts'
import type { HarnessRunOptions, HarnessRunResult, HarnessTask } from '../../src/harness/types.ts'
import type { Result } from '../../src/proxy/types.ts'
import type { SalienceScore } from '../../src/salience/types.ts'
import {
  type ActiveMemory,
  canonicalizeId,
  clusterMemories,
  consolidateCluster,
  type MergeDecision,
  runConsolidation,
  validateMerge,
} from '../../src/store/consolidate.ts'

// ---------------------------------------------------------------------------
// Fakes — a fake ModelHarness (answers BOTH the consolidate task and the
// salience re-score) + a mock QMDStore. No real model, no real search.
// ---------------------------------------------------------------------------

/**
 * Fake harness: `merge` = the MergeDecision to return for the consolidate task,
 * or null to simulate the unconstrained hard-fail ({ ok: false }). The salience
 * task always resolves ok so buildConsolidatedMemory's re-score is mocked too.
 */
class FakeHarness {
  public consolidateCalls = 0

  constructor(
    private readonly merge: MergeDecision | null,
    private readonly salience: SalienceScore = { score: 0.6, tier: 'standard', reason: 'mock' },
  ) {}

  run<T>(
    task: HarnessTask<T>,
    _prompt: string,
    _options?: HarnessRunOptions,
  ): Promise<Result<HarnessRunResult<T>>> {
    const meta = {
      task: task.name,
      constrained: false,
      attempts: 1,
      usedFloor: false,
      latencyMs: 0,
    }
    if (task.name === 'salience') {
      return Promise.resolve({ ok: true, value: { value: this.salience as unknown as T, meta } })
    }
    // consolidate task
    this.consolidateCalls += 1
    if (this.merge === null) {
      return Promise.resolve({ ok: false, error: new Error('mock unconstrained hard-fail') })
    }
    return Promise.resolve({ ok: true, value: { value: this.merge as unknown as T, meta } })
  }
}

const asHarness = (h: FakeHarness): ModelHarness => h as unknown as ModelHarness

interface MockHit {
  file: string
  score: number
}

/** Minimal QMDStore stub: only .search/.searchLex/.update are exercised here. */
function makeMockStore(searchImpl: (query: string) => MockHit[]): QMDStore {
  return {
    search: ({ query }: { query: string }) =>
      Promise.resolve(searchImpl(query).map((h) => ({ ...h, body: '' }))),
    searchLex: () => Promise.resolve([]),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore
}

function activeMem(id: string, body: string, overrides: Partial<ActiveMemory> = {}): ActiveMemory {
  return {
    id,
    body,
    category: 'IDENTITY',
    confidence: 'HIGH',
    salienceTier: 'standard',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    consolidated: false,
    filePath: `/tmp/${id}.md`,
    ...overrides,
  }
}

const hit = (id: string, score: number): MockHit => ({ file: `qmd://memories/${id}.md`, score })

/**
 * Emit a hit whose file stem is the HANDELIZED form QMD actually stores/returns:
 * handelize() rewrites the indexed path stem (`mem_a1b2c3`→`mem-a1b2c3`,
 * lowercased). This reproduces the real `_`→`-` mangling that the plain `hit`
 * helper never did — the exact shape the id-matching bug hid behind.
 */
const hitMangled = (id: string, score: number): MockHit => ({
  file: `qmd://memories/${id.replace(/_/g, '-')}.md`,
  score,
})

const EXTRACTION_CONFIG = { model: 'x', apiKey: '', baseUrl: 'x' }

// ===========================================================================
// 1. validateMerge — pure validation/coercion
// ===========================================================================

describe('validateMerge', () => {
  it('accepts a well-formed MERGE (text + valid category)', () => {
    expect(
      validateMerge({ action: 'MERGE', text: 'Lives in Riyadh', category: 'IDENTITY' }),
    ).toEqual({ action: 'MERGE', text: 'Lives in Riyadh', category: 'IDENTITY' })
  })

  it('accepts LEAVE_AS_IS and trims/coerces the reason', () => {
    expect(validateMerge({ action: 'LEAVE_AS_IS', reason: '  distinct facts  ' })).toEqual({
      action: 'LEAVE_AS_IS',
      reason: 'distinct facts',
    })
  })

  it('MERGE missing text → null (triggers retry/floor)', () => {
    expect(validateMerge({ action: 'MERGE', category: 'IDENTITY' })).toBeNull()
    expect(validateMerge({ action: 'MERGE', text: '   ', category: 'IDENTITY' })).toBeNull()
  })

  it('MERGE with a bad category → null', () => {
    expect(validateMerge({ action: 'MERGE', text: 'x', category: 'BOGUS' })).toBeNull()
  })

  it('missing or unknown action → null', () => {
    expect(validateMerge({})).toBeNull()
    expect(validateMerge({ action: 'FROBNICATE' })).toBeNull()
    expect(validateMerge(null)).toBeNull()
    expect(validateMerge('nope')).toBeNull()
  })
})

// ===========================================================================
// 1b. canonicalizeId — pure normalizer that makes underscore frontmatter ids
// and handelized (hyphen) hit stems agree on one canonical key.
// ===========================================================================

describe('canonicalizeId', () => {
  it('maps the underscore id and its handelized hyphen stem to the SAME key', () => {
    expect(canonicalizeId('mem_a1b2c3')).toBe('mem-a1b2c3')
    expect(canonicalizeId('mem-a1b2c3')).toBe('mem-a1b2c3')
    expect(canonicalizeId('mem_a1b2c3')).toBe(canonicalizeId('mem-a1b2c3'))
  })

  it('is idempotent', () => {
    const once = canonicalizeId('mem_a1b2c3')
    expect(canonicalizeId(once)).toBe(once)
  })

  it('lowercases and collapses non-alphanumeric runs to a single dash', () => {
    expect(canonicalizeId('MEM_A1B2C3')).toBe('mem-a1b2c3')
    expect(canonicalizeId('mem__a1b2')).toBe('mem-a1b2')
  })

  it('trims leading/trailing dashes', () => {
    expect(canonicalizeId('_mem_a1_')).toBe('mem-a1')
    expect(canonicalizeId('--mem-a1--')).toBe('mem-a1')
  })
})

// ===========================================================================
// 2. consolidateCluster — model-first, LEAVE_AS_IS floor, never throws
// ===========================================================================

describe('consolidateCluster', () => {
  const cluster = [activeMem('mem_a', 'Lives in Riyadh'), activeMem('mem_b', 'Based in Riyadh')]

  it('returns the harness MERGE when the run succeeds', async () => {
    const merge: MergeDecision = { action: 'MERGE', text: 'Lives in Riyadh', category: 'IDENTITY' }
    const result = await consolidateCluster(cluster, asHarness(new FakeHarness(merge)))
    expect(result).toEqual(merge)
  })

  it('degrades to LEAVE_AS_IS (floored, never throws) on an unconstrained hard-fail', async () => {
    const result = await consolidateCluster(cluster, asHarness(new FakeHarness(null)))
    expect(result).toEqual({ action: 'LEAVE_AS_IS', reason: 'harness floor' })
  })
})

// ===========================================================================
// 3. clusterMemories — mocked store.search (no model)
// ===========================================================================

describe('clusterMemories', () => {
  it('groups 3 mutual near-dups into ONE cluster of 3', async () => {
    const mems = [
      activeMem('mem_a', 'Lives in Riyadh'),
      activeMem('mem_b', 'Based in Riyadh'),
      activeMem('mem_c', 'Riyadh resident'),
    ]
    // Every query returns all three as high-score neighbors.
    const store = makeMockStore(() => [hit('mem_a', 0.9), hit('mem_b', 0.9), hit('mem_c', 0.9)])

    const clusters = await clusterMemories(mems, store)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toHaveLength(3)
  })

  // REGRESSION (T05-FIX): real memory ids are `mem_<hex>` (underscore), but QMD
  // handelizes the indexed path stem to `mem-<hex>` (hyphen) and returns THAT in
  // search hits. Before the canonicalizeId fix, idFromHit's hyphen stem never
  // matched the underscore frontmatter id, every hit was dropped, and clustering
  // silently produced ZERO clusters on every real wallet. This test seeds
  // realistic ids and returns their neighbors as MANGLED (hyphen) stems; it FAILS
  // (0 clusters) on pre-CP2 code and PASSES now.
  it('groups memories even when QMD returns handelized (hyphen) hit stems', async () => {
    const mems = [
      activeMem('mem_a1b2c3', 'Lives in Riyadh'),
      activeMem('mem_d4e5f6', 'Based in Riyadh'),
      activeMem('mem_07a8b9', 'Riyadh resident'),
    ]
    // The store returns each neighbor as its HANDELIZED stem (`_`→`-`), exactly
    // as real QMD does — the shape the plain `hit` helper never reproduced.
    const store = makeMockStore(() => [
      hitMangled('mem_a1b2c3', 0.9),
      hitMangled('mem_d4e5f6', 0.9),
      hitMangled('mem_07a8b9', 0.9),
    ])

    const clusters = await clusterMemories(mems, store)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toHaveLength(3)
    // Scores/clusters carry the REAL underscore ids, not the canonical match key.
    expect(clusters[0].map((m) => m.id).sort()).toEqual(['mem_07a8b9', 'mem_a1b2c3', 'mem_d4e5f6'])
  })

  it('leaves 3 distinct memories as singletons → zero mergeable clusters', async () => {
    const mems = [
      activeMem('mem_a', 'Lives in Riyadh'),
      activeMem('mem_b', 'Prefers PostgreSQL'),
      activeMem('mem_c', 'Has a dog named Rex'),
    ]
    // No neighbors above threshold for anyone.
    const store = makeMockStore(() => [])

    const clusters = await clusterMemories(mems, store)
    expect(clusters).toHaveLength(0)
  })

  it('skips a cluster of ONLY consolidated memories (idempotency guard)', async () => {
    const mems = [
      activeMem('mem_a', 'Lives in Riyadh', { consolidated: true }),
      activeMem('mem_b', 'Based in Riyadh', { consolidated: true }),
      activeMem('mem_c', 'Riyadh resident', { consolidated: true }),
    ]
    const store = makeMockStore(() => [hit('mem_a', 0.9), hit('mem_b', 0.9), hit('mem_c', 0.9)])

    const clusters = await clusterMemories(mems, store)
    expect(clusters).toHaveLength(0)
  })

  it('ignores neighbors below the score threshold', async () => {
    const mems = [activeMem('mem_a', 'Lives in Riyadh'), activeMem('mem_b', 'Based in Riyadh')]
    // Both retrieved but well below threshold → no edge.
    const store = makeMockStore(() => [hit('mem_a', 0.2), hit('mem_b', 0.2)])

    const clusters = await clusterMemories(mems, store)
    expect(clusters).toHaveLength(0)
  })
})

// ===========================================================================
// 4 + 5. runConsolidation — idempotency + supersede-not-delete, on a REAL temp
// wallet with REAL writeMemoryFile/invalidateMemoryFile/loadActiveMemories, but
// a MOCK store (search/update) and a FAKE harness (no models anywhere).
// ===========================================================================

function sourceRecord(id: string, text: string): MemoryRecord {
  return {
    id,
    text,
    category: 'IDENTITY',
    confidence: 'HIGH',
    salienceScore: 0.8,
    salienceTier: 'core',
    source: 'conv_seed',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
  }
}

const MERGE_DECISION: MergeDecision = {
  action: 'MERGE',
  text: 'Lives in Riyadh, Saudi Arabia, and works as a backend engineer',
  category: 'IDENTITY',
}

describe('runConsolidation (mocked backend + fake harness, no models)', () => {
  let walletDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    walletDir = await mkdtemp(join(tmpdir(), 'consolidate-'))
    // Seed three near-duplicate source memories.
    await writeMemoryFile(walletDir, sourceRecord('mem_src1', 'Lives in Riyadh'))
    await writeMemoryFile(walletDir, sourceRecord('mem_src2', 'Based in Riyadh, Saudi Arabia'))
    await writeMemoryFile(walletDir, sourceRecord('mem_src3', 'Riyadh-based backend engineer'))
    vi.mocked(buildExtractionHarness).mockReturnValue(asHarness(new FakeHarness(MERGE_DECISION)))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  // The mock store always reports the three seeds as mutual high-score neighbors.
  const dupStore = () =>
    makeMockStore(() => [hit('mem_src1', 0.9), hit('mem_src2', 0.9), hit('mem_src3', 0.9)])

  it('supersedes sources (never deletes) and writes a consolidated memory', async () => {
    const result = await runConsolidation(walletDir, dupStore(), EXTRACTION_CONFIG)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.merged).toBe(1)
    expect(result.value.sourcesSuperseded).toBe(3)

    const memDir = join(walletDir, 'memories')

    // Sources STILL EXIST on disk and are now invalidated (marked, not deleted).
    for (const id of ['mem_src1', 'mem_src2', 'mem_src3']) {
      const content = await readFile(join(memDir, `${id}.md`), 'utf8')
      expect(content).toMatch(/^invalidatedAt: (?!null$).+$/m)
    }

    // A NEW consolidated memory exists with consolidated: true + its own lifecycle.
    const files = (await readdir(memDir)).filter((f) => f.endsWith('.md'))
    expect(files).toHaveLength(4)

    const consolidated: string[] = []
    for (const f of files) {
      const content = await readFile(join(memDir, f), 'utf8')
      if (/^consolidated: true$/m.test(content)) consolidated.push(content)
    }
    expect(consolidated).toHaveLength(1)
    expect(consolidated[0]).toMatch(/^salienceTier: (core|standard|trivia)$/m)
    expect(consolidated[0]).toMatch(/^expiresAt: /m)
    expect(consolidated[0]).toContain(MERGE_DECISION.text)
  })

  it('is idempotent — a second back-to-back run merges nothing', async () => {
    const store = dupStore()

    const run1 = await runConsolidation(walletDir, store, EXTRACTION_CONFIG)
    expect(run1.ok).toBe(true)
    if (!run1.ok) return
    expect(run1.value.merged).toBe(1)

    const run2 = await runConsolidation(walletDir, store, EXTRACTION_CONFIG)
    expect(run2.ok).toBe(true)
    if (!run2.ok) return
    // Sources are invalidated (excluded from loadActiveMemories) and the lone
    // surviving consolidated memory has no original neighbor → nothing to merge.
    expect(run2.value.merged).toBe(0)
    expect(run2.value.sourcesSuperseded).toBe(0)
  })
})
