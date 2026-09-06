// Focused unit tests for recallOnce — the pure retrieval+composition core.
//
// Goals (CP1 acceptance):
//   - returns structured { text, turnCount, projectId, elapsedMs, turns }
//   - returns null text when there is nothing to inject
//   - explicit input.projectId wins over the injected sniff resolver
//   - no stdout / no personality side effects (it's just data in → data out)
//
// Uses the same mock-store trick as the full-loop integration test: leave
// store.search undefined so searchTurns falls back to searchLex, which we stub.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SearchResult as QMDSearchResult, QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WalletConfig } from '../src/config/schema.ts'
import type { NormalizedRequest } from '../src/proxy/types.ts'
import { recallOnce } from '../src/recall.ts'

function makeConfig(walletDir: string): WalletConfig {
  return {
    walletDir,
    proxy: { port: 0, host: '127.0.0.1' },
    dashboard: { port: 0, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion: 'v2', debug: false },
    extraction: {
      schedule: '0 2 * * *',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
    },
    retrieval: { modelsResident: true },
    injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
    incognito: false,
  }
}

/** Mock store: search() undefined → searchTurns falls back to searchLex. */
function makeMockStore(results: QMDSearchResult[]): QMDStore {
  return {
    searchLex: async () => results,
  } as unknown as QMDStore
}

/** A QMD search hit whose body is a parseable turn-pair markdown doc. */
function makeTurnPairResult(
  userContent: string,
  assistantContent: string,
  score = 0.9,
): QMDSearchResult {
  const body = [
    '---',
    'id: turn_test_001',
    'sessionId: sess_test_001',
    'tool: cursor',
    'timestamp: 2026-03-20T10:00:00Z',
    'turnIndex: 0',
    '---',
    '',
    '## User',
    userContent,
    '',
    '## Assistant',
    assistantContent,
  ].join('\n')
  return {
    filepath: '/wallet/turns/2026-03-20/sess_test_001-0.md',
    displayPath: 'qmd://turns/2026-03-20/sess_test_001-0.md',
    title: 'Turn',
    body,
    context: '',
    hash: 'abc123',
    docid: 'abc123',
    collectionName: 'turns',
    modifiedAt: '2026-03-20T00:00:00Z',
    bodyLength: body.length,
    score,
    source: 'fts',
  }
}

/** Minimal NormalizedRequest — recallOnce only forwards it to resolveProjectId. */
function makeNormalized(): NormalizedRequest {
  return { messages: [{ role: 'user', content: 'hi' }] } as unknown as NormalizedRequest
}

describe('recallOnce', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-recall-'))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('returns composed text, turn count, projectId and the turns when memory matches', async () => {
    const store = makeMockStore([
      makeTurnPairResult(
        'What is your preferred language?',
        'I prefer TypeScript over JavaScript for its static typing and tooling.',
      ),
    ])
    const config = makeConfig(walletDir)

    const result = await recallOnce({ store, config }, { query: 'What are my coding preferences?' })

    expect(result.text).toBeTypeOf('string')
    expect(result.text).toContain('<dhakira_context>')
    expect(result.text).toContain('TypeScript')
    expect(result.turnCount).toBe(1)
    expect(result.turns).toHaveLength(1)
    expect(result.projectId).toBe('global')
    expect(result.elapsedMs).toBeTypeOf('number')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('returns null text and zero turns when there is nothing to inject', async () => {
    const store = makeMockStore([])
    const config = makeConfig(walletDir)

    const result = await recallOnce({ store, config }, { query: 'anything' })

    expect(result.text).toBeNull()
    expect(result.turnCount).toBe(0)
    expect(result.turns).toHaveLength(0)
    expect(result.projectId).toBe('global')
  })

  it('lets an explicit projectId override the sniff resolver (resolver not called)', async () => {
    const store = makeMockStore([])
    const config = makeConfig(walletDir)
    const resolveProjectId = vi.fn(async () => 'proj-sniffed')

    const result = await recallOnce(
      { store, config, resolveProjectId },
      { query: 'q', projectId: 'proj-explicit', normalized: makeNormalized() },
    )

    expect(result.projectId).toBe('proj-explicit')
    expect(resolveProjectId).not.toHaveBeenCalled()
  })

  it('falls back to the sniff resolver when no explicit projectId is given', async () => {
    const store = makeMockStore([])
    const config = makeConfig(walletDir)
    const resolveProjectId = vi.fn(async () => 'proj-sniffed')

    const result = await recallOnce(
      { store, config, resolveProjectId },
      { query: 'q', normalized: makeNormalized() },
    )

    expect(result.projectId).toBe('proj-sniffed')
    expect(resolveProjectId).toHaveBeenCalledTimes(1)
  })

  it("defaults projectId to 'global' when neither explicit id nor normalized is provided", async () => {
    const store = makeMockStore([])
    const config = makeConfig(walletDir)

    const result = await recallOnce({ store, config }, { query: 'q' })

    expect(result.projectId).toBe('global')
  })
})
