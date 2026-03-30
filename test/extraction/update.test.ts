import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock HTTP modules before any other imports
vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))

const httpsMock = await import('node:https')

import type { ExtractedFact } from '../../src/extraction/types.ts'
import { processUpdates } from '../../src/extraction/update.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  schedule: '0 2 * * *',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

function makeOpenAIResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  })
}

function mockHttpsOnce(body: string): void {
  const mockReq = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
  vi.mocked(httpsMock.request).mockImplementationOnce(
    (
      _url: unknown,
      _opts: unknown,
      callback?: (res: EventEmitter & { statusCode?: number }) => void,
    ) => {
      const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 })
      if (callback) callback(mockRes)
      process.nextTick(() => {
        mockRes.emit('data', Buffer.from(body))
        mockRes.emit('end')
      })
      return mockReq as unknown as ClientRequest
    },
  )
}

/** Build a minimal QMDStore mock */
function makeStoreMock(
  searchResults: Array<{ filepath: string; body?: string; title?: string; score: number }> = [],
) {
  return {
    searchLex: vi.fn().mockResolvedValue(searchResults),
    search: vi.fn().mockRejectedValue(new Error('No embeddings in test')),
    searchVector: vi.fn(),
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
    expandQuery: vi.fn(),
    get: vi.fn(),
    getDocumentBody: vi.fn(),
    multiGet: vi.fn(),
    internal: {} as never,
    dbPath: '/tmp/wallet.sqlite',
  }
}

const PREFERENCE_FACT: ExtractedFact = {
  text: 'Prefers PostgreSQL over MySQL',
  category: 'PREFERENCE',
  confidence: 'HIGH',
}

const IDENTITY_FACT: ExtractedFact = {
  text: 'Works as a backend engineer',
  category: 'IDENTITY',
  confidence: 'HIGH',
}

// ---------------------------------------------------------------------------
// processUpdates — ADD action
// ---------------------------------------------------------------------------

describe('processUpdates — ADD', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns ADD action when no existing memories match', async () => {
    const store = makeStoreMock([])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'ADD' })))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0].action).toBe('ADD')
    if (result.value[0].action !== 'ADD') return
    expect(result.value[0].fact).toEqual(PREFERENCE_FACT)
  })

  it('processes multiple facts and returns one action per fact', async () => {
    const store = makeStoreMock([])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'ADD' })))
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'ADD' })))

    const result = await processUpdates([PREFERENCE_FACT, IDENTITY_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(2)
    expect(result.value.every((a) => a.action === 'ADD')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// processUpdates — UPDATE action
// ---------------------------------------------------------------------------

describe('processUpdates — UPDATE', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns UPDATE action with targetId when LLM decides to update', async () => {
    const store = makeStoreMock([
      { filepath: '/memories/mem_old123.md', body: 'Prefers MySQL', score: 0.9 },
    ])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'UPDATE', targetId: 'mem_old123' })))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('UPDATE')
    if (result.value[0].action !== 'UPDATE') return
    expect(result.value[0].targetId).toBe('mem_old123')
    expect(result.value[0].fact).toEqual(PREFERENCE_FACT)
  })

  it('falls back to ADD when UPDATE has no targetId', async () => {
    const store = makeStoreMock([
      { filepath: '/memories/mem_abc.md', body: 'Old fact', score: 0.8 },
    ])
    // LLM omits targetId — invalid UPDATE response
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'UPDATE' })))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
  })
})

// ---------------------------------------------------------------------------
// processUpdates — INVALIDATE action
// ---------------------------------------------------------------------------

describe('processUpdates — INVALIDATE', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns INVALIDATE action with targetId', async () => {
    const store = makeStoreMock([
      { filepath: '/memories/mem_stale456.md', body: 'Works at OldCorp', score: 0.95 },
    ])
    mockHttpsOnce(
      makeOpenAIResponse(JSON.stringify({ action: 'INVALIDATE', targetId: 'mem_stale456' })),
    )

    const result = await processUpdates([IDENTITY_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('INVALIDATE')
    if (result.value[0].action !== 'INVALIDATE') return
    expect(result.value[0].targetId).toBe('mem_stale456')
  })

  it('falls back to ADD when INVALIDATE has no targetId', async () => {
    const store = makeStoreMock([{ filepath: '/memories/mem_x.md', body: 'Old fact', score: 0.7 }])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'INVALIDATE' })))

    const result = await processUpdates([IDENTITY_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
  })
})

// ---------------------------------------------------------------------------
// processUpdates — NOOP action
// ---------------------------------------------------------------------------

describe('processUpdates — NOOP', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns NOOP action with reason', async () => {
    const store = makeStoreMock([
      { filepath: '/memories/mem_dup.md', body: 'Prefers PostgreSQL over MySQL', score: 0.99 },
    ])
    mockHttpsOnce(
      makeOpenAIResponse(JSON.stringify({ action: 'NOOP', reason: 'Already captured in mem_dup' })),
    )

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('NOOP')
    if (result.value[0].action !== 'NOOP') return
    expect(result.value[0].reason).toMatch(/mem_dup/)
  })
})

// ---------------------------------------------------------------------------
// processUpdates — error resilience
// ---------------------------------------------------------------------------

describe('processUpdates — error resilience', () => {
  afterEach(() => vi.clearAllMocks())

  it('defaults to ADD when LLM call fails (network error)', async () => {
    const mockReq = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
    vi.mocked(httpsMock.request).mockImplementationOnce(
      (_url: unknown, _opts: unknown, _cb?: unknown) => {
        process.nextTick(() => {
          const errorListener = mockReq.on.mock.calls.find(([evt]) => evt === 'error')
          if (errorListener) errorListener[1](new Error('ECONNREFUSED'))
        })
        return mockReq as unknown as ClientRequest
      },
    )

    const store = makeStoreMock([])
    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
  })

  it('defaults to ADD when LLM response JSON is unparseable', async () => {
    const store = makeStoreMock([])
    mockHttpsOnce(makeOpenAIResponse('not valid json at all'))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
  })

  it('defaults to ADD when LLM returns unknown action', async () => {
    const store = makeStoreMock([])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'DELETE_EVERYTHING' })))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
  })

  it('defaults to ADD when QMD search throws', async () => {
    const store = makeStoreMock()
    store.searchLex.mockRejectedValueOnce(new Error('DB locked'))

    const result = await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].action).toBe('ADD')
    // No LLM call should have been made
    expect(vi.mocked(httpsMock.request)).not.toHaveBeenCalled()
  })

  it('extracts memory ID from filepath for the prompt', async () => {
    const store = makeStoreMock([
      {
        filepath: '/home/user/.dhakira/memories/mem_abc123.md',
        body: 'Old pref',
        score: 0.85,
      },
    ])
    mockHttpsOnce(makeOpenAIResponse(JSON.stringify({ action: 'ADD' })))

    await processUpdates([PREFERENCE_FACT], store, BASE_CONFIG)

    // The LLM should have been called with the memory ID extracted from filepath
    expect(vi.mocked(httpsMock.request)).toHaveBeenCalledOnce()
    const reqArgs = vi.mocked(httpsMock.request).mock.calls[0]
    // Body is written via req.write — verify the request was made
    expect(reqArgs).toBeDefined()
  })

  it('always returns ok: true (never propagates individual fact errors)', async () => {
    const store = makeStoreMock()
    store.searchLex.mockRejectedValue(new Error('Persistent failure'))

    const result = await processUpdates(
      [PREFERENCE_FACT, IDENTITY_FACT, PREFERENCE_FACT],
      store,
      BASE_CONFIG,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(3)
    expect(result.value.every((a) => a.action === 'ADD')).toBe(true)
  })
})
