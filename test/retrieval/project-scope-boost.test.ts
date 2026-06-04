import type { HybridQueryResult, QMDStore } from '@tobilu/qmd'
import { describe, expect, it, vi } from 'vitest'

import { searchTurns } from '../../src/retrieval/search.ts'

// ---------------------------------------------------------------------------
// CP4 — THE MOAT TEST (JTBD #6): same projectId across DIFFERENT tools/fingerprints
// now shares the 1.5x context boost at query time. This is the cross-tool boost
// that silently failed under the old fingerprint axis. This test passing IS the
// pillar landing — it goes end-to-end through searchTurns → loader → ranker.
// ---------------------------------------------------------------------------

const PROJECT = 'git:github.com/owner/repo'
const OTHER_PROJECT = 'git:github.com/owner/other'

function turnBody(opts: {
  sessionId: string
  tool: string
  contextFingerprint: string
  projectId?: string
  userContent: string
  assistantContent: string
  timestamp?: string
}): string {
  const lines = [
    '---',
    `id: turn_${opts.sessionId}`,
    `sessionId: ${opts.sessionId}`,
    `tool: ${opts.tool}`,
    `timestamp: ${opts.timestamp ?? new Date().toISOString()}`,
    'turnIndex: 0',
    `contextFingerprint: ${opts.contextFingerprint}`,
  ]
  // Mirror the writer: only emit projectId when non-global.
  if (opts.projectId !== undefined && opts.projectId !== 'global') {
    lines.push(`projectId: ${opts.projectId}`)
  }
  lines.push('---', '', '## User', opts.userContent, '', '## Assistant', opts.assistantContent, '')
  return lines.join('\n')
}

function makeHybrid(body: string, file: string, score = 0.6): HybridQueryResult {
  return {
    file,
    displayPath: `qmd://${file}`,
    title: 'Turn 0',
    body,
    bestChunk: body,
    bestChunkPos: 0,
    score,
    context: 'Individual conversation turn pairs',
    docid: file,
  }
}

function makeStore(results: HybridQueryResult[]): QMDStore {
  return {
    searchLex: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue(results),
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

// Two turns in the SAME project, captured by DIFFERENT tools with DIFFERENT
// system-prompt fingerprints — exactly the cross-tool case the old axis missed.
const claudeBody = turnBody({
  sessionId: 'sess_claude',
  tool: 'claude-code',
  contextFingerprint: 'claudefp0001',
  projectId: PROJECT,
  userContent: 'How should I structure the auth middleware?',
  assistantContent: 'Put it in a dedicated middleware module.',
})
const codexBody = turnBody({
  sessionId: 'sess_codex',
  tool: 'codex',
  contextFingerprint: 'codexfp9999', // DIFFERENT fingerprint, SAME project
  projectId: PROJECT,
  userContent: 'What is a good rate limiting approach for the API?',
  assistantContent: 'Use a token bucket per client key.',
})

describe('CP4 cross-tool project boost (the moat)', () => {
  it('boosts BOTH same-project turns 1.5x at query time despite different fingerprints', async () => {
    const store = makeStore([
      makeHybrid(claudeBody, '/wallet/turns/claude.md', 0.6),
      makeHybrid(codexBody, '/wallet/turns/codex.md', 0.6),
    ])

    // Baseline: no project context (global) → no boost.
    const base = await searchTurns(store, {
      query: 'api design',
      minScore: 0,
      recencyBoost: 0,
      projectId: 'global',
    })
    // Boosted: the request resolves to PROJECT (same id both tools captured under).
    const boosted = await searchTurns(store, {
      query: 'api design',
      minScore: 0,
      recencyBoost: 0,
      projectId: PROJECT,
      scopeMode: 'boost',
    })

    expect(base.ok && boosted.ok).toBe(true)
    if (!base.ok || !boosted.ok) return

    const byFile = (rs: typeof boosted.value) => new Map(rs.map((r) => [r.source, r] as const))
    const baseMap = byFile(base.value)
    const boostMap = byFile(boosted.value)

    for (const file of ['/wallet/turns/claude.md', '/wallet/turns/codex.md']) {
      const b = baseMap.get(file)
      const x = boostMap.get(file)
      expect(b, `baseline missing ${file}`).toBeDefined()
      expect(x, `boosted missing ${file}`).toBeDefined()
      if (!b || !x) continue
      expect(b.score).toBeCloseTo(0.6)
      expect(x.score).toBeCloseTo(0.9) // 0.6 × 1.5
      expect(x.score / b.score).toBeCloseTo(1.5)
    }

    // The whole point: these two turns carry DIFFERENT fingerprints, so the old
    // fingerprint axis would NOT have co-boosted them. The projectId axis does.
    const claude = boostMap.get('/wallet/turns/claude.md')
    const codex = boostMap.get('/wallet/turns/codex.md')
    expect(claude?.turnPair.contextFingerprint).not.toBe(codex?.turnPair.contextFingerprint)
    expect(claude?.turnPair.projectId).toBe(codex?.turnPair.projectId)
  })

  it('does NOT boost a turn from a different project', async () => {
    const otherBody = turnBody({
      sessionId: 'sess_other',
      tool: 'claude-code',
      contextFingerprint: 'claudefp0001', // even with a matching fingerprint...
      projectId: OTHER_PROJECT, // ...a different project must not boost
      userContent: 'How do I configure the deploy pipeline?',
      assistantContent: 'Use the CI workflow file.',
    })
    const store = makeStore([makeHybrid(otherBody, '/wallet/turns/other.md', 0.6)])

    const result = await searchTurns(store, {
      query: 'pipeline',
      minScore: 0,
      recencyBoost: 0,
      projectId: PROJECT,
      scopeMode: 'boost',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.score).toBeCloseTo(0.6) // unboosted
  })

  it('a "global" turn never boosts, even when the request has a real projectId', async () => {
    const globalBody = turnBody({
      sessionId: 'sess_global',
      tool: 'claude-code',
      contextFingerprint: 'default',
      // no projectId line → reader resolves to "global"
      userContent: 'General coding question about closures.',
      assistantContent: 'A closure captures its lexical scope.',
    })
    const store = makeStore([makeHybrid(globalBody, '/wallet/turns/global.md', 0.6)])
    const result = await searchTurns(store, {
      query: 'closures',
      minScore: 0,
      recencyBoost: 0,
      projectId: PROJECT,
      scopeMode: 'boost',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.turnPair.projectId).toBe('global')
    expect(result.value[0]?.score).toBeCloseTo(0.6) // never boosted
  })

  it('reserved seam: scopeMode "only" is threaded but ships NO new behavior (acts as boost)', async () => {
    const store = makeStore([makeHybrid(claudeBody, '/wallet/turns/claude.md', 0.6)])
    const result = await searchTurns(store, {
      query: 'auth',
      minScore: 0,
      recencyBoost: 0,
      projectId: PROJECT,
      scopeMode: 'only',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Hard isolation is deferred: 'only' currently behaves exactly like 'boost'.
    expect(result.value[0]?.score).toBeCloseTo(0.9)
  })
})
