import type { HybridQueryResult, SearchResult as QMDSearchResult, QMDStore } from '@tobilu/qmd'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRetrievalMetrics, resetRetrievalMetrics } from '../../src/retrieval/metrics.ts'
import { HYBRID_DEADLINE_MS, searchTurns } from '../../src/retrieval/search.ts'

function makeQMDResult(overrides: Partial<QMDSearchResult> = {}): QMDSearchResult {
  return {
    filepath: '/wallet/memories/mem_abc123.md',
    displayPath: 'qmd://memories/mem_abc123.md',
    title: 'Prefers TypeScript',
    body: 'Uses TypeScript over JavaScript for all projects.',
    context: 'Personal memories',
    hash: 'abc123def456',
    docid: 'abc123',
    collectionName: 'memories',
    modifiedAt: '2026-03-20T01:00:00Z',
    bodyLength: 48,
    score: 0.85,
    source: 'fts',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// searchTurns
// ---------------------------------------------------------------------------

/** Build a markdown body matching the turn pair file format. */
function makeTurnBody(
  overrides: {
    id?: string
    sessionId?: string
    tool?: string
    timestamp?: string
    turnIndex?: number
    userContent?: string
    assistantContent?: string
  } = {},
): string {
  const id = overrides.id ?? 'turn_abc123'
  const sessionId = overrides.sessionId ?? 'sess_xyz789'
  const tool = overrides.tool ?? 'claude-code'
  const timestamp = overrides.timestamp ?? new Date().toISOString()
  const turnIndex = overrides.turnIndex ?? 0
  const userContent = overrides.userContent ?? 'How do I implement connection pooling?'
  const assistantContent = overrides.assistantContent ?? 'Use pgBouncer for connection pooling.'

  return [
    '---',
    `id: ${id}`,
    `sessionId: ${sessionId}`,
    `tool: ${tool}`,
    `timestamp: ${timestamp}`,
    `turnIndex: ${turnIndex}`,
    '---',
    '',
    '## User',
    userContent,
    '',
    '## Assistant',
    assistantContent,
    '',
  ].join('\n')
}

/** Build a minimal HybridQueryResult for turn search tests. */
function makeHybridResult(
  overrides: {
    score?: number
    body?: string
    file?: string
    sessionId?: string
    timestamp?: string
    userContent?: string
    assistantContent?: string
  } = {},
): HybridQueryResult {
  const body =
    overrides.body ??
    makeTurnBody({
      sessionId: overrides.sessionId,
      timestamp: overrides.timestamp,
      userContent: overrides.userContent,
      assistantContent: overrides.assistantContent,
    })
  return {
    file: overrides.file ?? '/wallet/turns/2026-03-26/sess_xyz789-0.md',
    displayPath: 'qmd://turns/2026-03-26/sess_xyz789-0.md',
    title: 'Turn 0',
    body,
    bestChunk: body,
    bestChunkPos: 0,
    score: overrides.score ?? 0.7,
    context: 'Individual conversation turn pairs',
    docid: 'abc123',
  }
}

/**
 * Build a store where store.search() returns the given hybrid results.
 * store.searchLex() falls back to returning an empty array by default.
 */
function makeTurnStore(
  searchImpl: () => Promise<HybridQueryResult[]>,
  searchLexImpl?: () => Promise<QMDSearchResult[]>,
): QMDStore {
  return {
    searchLex: searchLexImpl ?? vi.fn().mockResolvedValue([]),
    search: vi.fn().mockImplementation(searchImpl),
    searchVector: vi.fn(),
    expandQuery: vi.fn(),
    get: vi.fn(),
    getDocumentBody: vi.fn().mockResolvedValue(null),
    multiGet: vi.fn(),
    addCollection: vi.fn(),
    removeCollection: vi.fn(),
    renameCollection: vi.fn(),
    listCollections: vi.fn(),
    getDefaultCollectionNames: vi.fn(),
    addContext: vi.fn(),
    removeContext: vi.fn(),
    setGlobalContext: vi.fn(),
    getGlobalContext: vi.fn(),
    listContexts: vi.fn(),
    update: vi.fn(),
    embed: vi.fn(),
    getStatus: vi.fn(),
    getIndexHealth: vi.fn(),
    close: vi.fn(),
    internal: {} as never,
    dbPath: '/tmp/test.sqlite',
  } as unknown as QMDStore
}

describe('searchTurns', () => {
  describe('basic search', () => {
    it('should return ok: true with parsed turn pairs', async () => {
      const store = makeTurnStore(async () => [makeHybridResult()])
      const result = await searchTurns(store, { query: 'connection pooling' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.turnPair.id).toBe('turn_abc123')
      expect(result.value[0]?.turnPair.sessionId).toBe('sess_xyz789')
    })

    it('should populate source with the file path', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({ file: '/wallet/turns/2026-03-26/sess_a-0.md' }),
      ])
      const result = await searchTurns(store, { query: 'test' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value[0]?.source).toBe('/wallet/turns/2026-03-26/sess_a-0.md')
    })

    it('should skip results whose body cannot be parsed', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({ body: 'not valid frontmatter at all' }),
        makeHybridResult({ score: 0.5 }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Only the parseable result should survive
      expect(result.value).toHaveLength(1)
    })
  })

  describe('recency boost', () => {
    it('should score a recent turn higher than an old turn with the same relevance', async () => {
      const todayISO = new Date().toISOString()
      // 60 days ago
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

      const recentResult = makeHybridResult({
        score: 0.6,
        timestamp: todayISO,
        file: '/wallet/turns/recent.md',
        sessionId: 'sess_recent',
      })
      const oldResult = makeHybridResult({
        score: 0.6,
        timestamp: oldDate,
        file: '/wallet/turns/old.md',
        sessionId: 'sess_old',
      })

      const store = makeTurnStore(async () => [recentResult, oldResult])
      const result = await searchTurns(store, { query: 'test', minScore: 0, recencyBoost: 0.3 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const scores = result.value.map((r) => r.score)
      expect(scores[0]).toBeGreaterThan(scores[1] as number)
      expect(result.value[0]?.turnPair.sessionId).toBe('sess_recent')
    })

    it('should apply zero recency boost when recencyBoost=0', async () => {
      const todayISO = new Date().toISOString()
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

      const recentResult = makeHybridResult({
        score: 0.6,
        timestamp: todayISO,
        sessionId: 'sess_recent',
      })
      const oldResult = makeHybridResult({
        score: 0.6,
        timestamp: oldDate,
        sessionId: 'sess_old',
      })

      const store = makeTurnStore(async () => [recentResult, oldResult])
      const result = await searchTurns(store, { query: 'test', minScore: 0, recencyBoost: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // With no recency boost, both scores should equal the raw score
      expect(result.value[0]?.score).toBeCloseTo(0.6)
      expect(result.value[1]?.score).toBeCloseTo(0.6)
    })

    it('should not boost turns older than 90 days', async () => {
      const veryOldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
      const store = makeTurnStore(async () => [
        makeHybridResult({ score: 0.5, timestamp: veryOldDate }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0, recencyBoost: 0.3 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // recencyFactor = 0 for >90 days, so finalScore = 0.5 * (1 + 0.3 * 0) = 0.5
      expect(result.value[0]?.score).toBeCloseTo(0.5)
    })
  })

  describe('deduplication', () => {
    it('should keep only the higher-scored result when same session has >90% word overlap', async () => {
      const sharedText = 'How do I implement connection pooling with PostgreSQL using pgBouncer'
      const highScore = makeHybridResult({
        score: 0.9,
        sessionId: 'sess_same',
        turnIndex: 0,
        userContent: sharedText,
        assistantContent: 'pgBouncer solution details here',
        file: '/wallet/turns/high.md',
      })
      const lowScore = makeHybridResult({
        score: 0.7,
        sessionId: 'sess_same',
        turnIndex: 1,
        userContent: sharedText,
        assistantContent: 'pgBouncer solution details here',
        file: '/wallet/turns/low.md',
      })

      const store = makeTurnStore(async () => [highScore, lowScore])
      const result = await searchTurns(store, { query: 'pooling', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.source).toBe('/wallet/turns/high.md')
    })

    it('should keep both results when same session has <90% word overlap', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({
          sessionId: 'sess_same',
          userContent: 'How do I implement connection pooling?',
          assistantContent: 'Use pgBouncer.',
          file: '/wallet/turns/a.md',
          score: 0.9,
        }),
        makeHybridResult({
          sessionId: 'sess_same',
          userContent: 'What is the best caching strategy for Redis?',
          assistantContent: 'Use write-through caching.',
          file: '/wallet/turns/b.md',
          score: 0.7,
        }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(2)
    })

    it('should keep both results when same text but different sessions', async () => {
      const sharedText = 'How do I implement connection pooling with pgBouncer?'
      const store = makeTurnStore(async () => [
        makeHybridResult({
          sessionId: 'sess_a',
          userContent: sharedText,
          assistantContent: 'pgBouncer solution',
          file: '/wallet/turns/a.md',
          score: 0.9,
        }),
        makeHybridResult({
          sessionId: 'sess_b',
          userContent: sharedText,
          assistantContent: 'pgBouncer solution',
          file: '/wallet/turns/b.md',
          score: 0.7,
        }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(2)
    })
  })

  describe('minScore threshold', () => {
    it('should filter out results whose final score is below minScore', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({ score: 0.8, sessionId: 'sess_a' }),
        makeHybridResult({ score: 0.2, sessionId: 'sess_b' }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0.5, recencyBoost: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.score).toBeGreaterThanOrEqual(0.5)
    })

    it('should return empty array when all results are below minScore', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({ score: 0.1, sessionId: 'sess_a' }),
        makeHybridResult({ score: 0.15, sessionId: 'sess_b' }),
      ])
      const result = await searchTurns(store, { query: 'test', minScore: 0.3, recencyBoost: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(0)
    })

    it('should use default minScore of 0.3', async () => {
      const store = makeTurnStore(async () => [
        makeHybridResult({ score: 0.1, sessionId: 'sess_low' }),
      ])
      const result = await searchTurns(store, { query: 'test', recencyBoost: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(0)
    })

    it('should allow results through when minScore=0', async () => {
      const store = makeTurnStore(async () => [makeHybridResult({ score: 0.05 })])
      const result = await searchTurns(store, { query: 'test', minScore: 0, recencyBoost: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
    })
  })

  describe('limit', () => {
    it('should respect the limit option', async () => {
      const results = Array.from({ length: 20 }, (_, i) =>
        makeHybridResult({ score: 0.9, sessionId: `sess_${i}`, file: `/wallet/turns/${i}.md` }),
      )
      const store = makeTurnStore(async () => results)
      const result = await searchTurns(store, { query: 'test', limit: 5, minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.length).toBeLessThanOrEqual(5)
    })

    it('should use default limit of 8', async () => {
      const results = Array.from({ length: 20 }, (_, i) =>
        makeHybridResult({ score: 0.9, sessionId: `sess_${i}`, file: `/wallet/turns/${i}.md` }),
      )
      const store = makeTurnStore(async () => results)
      const result = await searchTurns(store, { query: 'test', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.length).toBeLessThanOrEqual(8)
    })
  })

  describe('BM25 fallback', () => {
    it('should fall back to searchLex when store.search() throws', async () => {
      const lexResult = makeQMDResult({
        filepath: '/wallet/turns/2026-03-26/sess_xyz789-0.md',
        body: makeTurnBody(),
        score: 0.6,
      })
      const store = makeTurnStore(
        async () => {
          throw new Error('No embeddings yet')
        },
        async () => [lexResult],
      )
      const result = await searchTurns(store, { query: 'pooling', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.turnPair.id).toBe('turn_abc123')
    })

    it('should return ok: false when both search and searchLex throw', async () => {
      const store = makeTurnStore(
        async () => {
          throw new Error('Hybrid failed')
        },
        async () => {
          throw new Error('BM25 failed')
        },
      )
      const result = await searchTurns(store, { query: 'test' })
      expect(result.ok).toBe(false)
    })

    it('should never throw — always returns a Result', async () => {
      const store = makeTurnStore(async () => {
        throw new Error('Unexpected failure')
      })
      ;(store.searchLex as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Lexical also failed'),
      )
      await expect(searchTurns(store, { query: 'test' })).resolves.not.toThrow()
    })

    // v0.3.1 — audit defect #13: the fallback used to trigger ONLY on throw. An
    // empty-but-successful hybrid result was returned as the final answer.
    it('falls back to searchLex when hybrid returns EMPTY but successful (defect #13)', async () => {
      const lexResult = makeQMDResult({
        filepath: '/wallet/turns/2026-03-26/sess_xyz789-0.md',
        body: makeTurnBody(),
        score: 0.6,
      })
      const store = makeTurnStore(async () => [], vi.fn().mockResolvedValue([lexResult]))
      const result = await searchTurns(store, { query: 'pooling', minScore: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.turnPair.id).toBe('turn_abc123')
      expect(store.searchLex).toHaveBeenCalledTimes(1)
    })

    it('does NOT consult searchLex when hybrid returns hits', async () => {
      const store = makeTurnStore(async () => [makeHybridResult({ score: 0.9 })])
      const result = await searchTurns(store, { query: 'pooling', minScore: 0 })
      expect(result.ok && result.value).toHaveLength(1)
      expect(store.searchLex).not.toHaveBeenCalled()
    })

    it('legitimately-empty wallet: hybrid empty AND BM25 empty → ok with zero results', async () => {
      const store = makeTurnStore(async () => [])
      const result = await searchTurns(store, { query: 'anything' })
      expect(result.ok && result.value).toEqual([])
    })
  })

  // v0.3.1 — audit D2: cold models make hybrid slow, the hook aborts at 1.5 s and
  // fails open (silent "no memory"). The daemon now serves BM25 after a deadline
  // that stays well under the hook budget.
  describe('daemon-side hybrid deadline (D2)', () => {
    beforeEach(() => resetRetrievalMetrics())

    it('HYBRID_DEADLINE_MS stays comfortably below the 1.5 s hook budget', () => {
      expect(HYBRID_DEADLINE_MS).toBeLessThanOrEqual(1000)
      expect(HYBRID_DEADLINE_MS).toBeGreaterThan(0)
    })

    it('serves BM25 when hybrid misses the deadline and lets hybrid finish in the background', async () => {
      let resolveHybrid: (r: HybridQueryResult[]) => void = () => {}
      const hybridPromise = new Promise<HybridQueryResult[]>((resolve) => {
        resolveHybrid = resolve
      })
      const lexResult = makeQMDResult({
        filepath: '/wallet/turns/2026-03-26/sess_xyz789-0.md',
        body: makeTurnBody({ userContent: 'served by bm25' }),
        score: 0.6,
      })
      const store = makeTurnStore(() => hybridPromise, vi.fn().mockResolvedValue([lexResult]))

      const started = Date.now()
      const result = await searchTurns(store, {
        query: 'pooling',
        minScore: 0,
        hybridDeadlineMs: 30,
      })
      const elapsed = Date.now() - started

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value[0]?.turnPair.userContent).toBe('served by bm25')
      // Generous bound: the hybrid promise never resolves on its own, so anything
      // short of the test timeout proves the deadline (30 ms) did the work.
      expect(elapsed).toBeLessThan(4000)
      expect(store.searchLex).toHaveBeenCalledTimes(1)

      // Telemetry: the deadline hit is counted (this is what /api/status + doctor read).
      const metrics = getRetrievalMetrics()
      expect(metrics.recallCount).toBe(1)
      expect(metrics.recallTimeouts).toBe(1)
      expect(metrics.lastRecallTimeoutAt).not.toBeNull()

      // The late hybrid result is discarded without throwing (background warm-up).
      resolveHybrid([makeHybridResult()])
      await hybridPromise
    })

    it('uses the hybrid result when it beats the deadline (no BM25 call, no timeout counted)', async () => {
      const store = makeTurnStore(async () => [makeHybridResult({ score: 0.9 })])
      const result = await searchTurns(store, {
        query: 'pooling',
        minScore: 0,
        hybridDeadlineMs: 500,
      })
      expect(result.ok && result.value).toHaveLength(1)
      expect(store.searchLex).not.toHaveBeenCalled()
      expect(getRetrievalMetrics().recallTimeouts).toBe(0)
      expect(getRetrievalMetrics().recallCount).toBe(1)
    })

    it('a hybrid rejection AFTER the deadline fired is swallowed (fail-open, background)', async () => {
      let rejectHybrid: (e: Error) => void = () => {}
      const hybridPromise = new Promise<HybridQueryResult[]>((_resolve, reject) => {
        rejectHybrid = reject
      })
      const store = makeTurnStore(
        () => hybridPromise,
        async () => [],
      )
      const result = await searchTurns(store, { query: 'x', hybridDeadlineMs: 20 })
      expect(result.ok && result.value).toEqual([])
      rejectHybrid(new Error('model load failed late'))
      await hybridPromise.catch(() => {})
    })
  })
})
