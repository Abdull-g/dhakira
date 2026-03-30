import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { QMDStore } from '@tobilu/qmd'

import {
  indexTurnPair,
  reconcile,
  startReconciliation,
  stopReconciliation,
  hashContent,
  extractTitle,
  handelize,
} from '../../src/retrieval/indexer.ts'

const WALLET_DIR = '/tmp/test-wallet'

function createMockStore(overrides: Partial<Record<string, unknown>> = {}): QMDStore {
  return {
    internal: {
      findActiveDocument: vi.fn().mockReturnValue(null),
      insertContent: vi.fn(),
      insertDocument: vi.fn(),
      ...overrides,
    },
    update: vi.fn().mockResolvedValue({
      collections: 1,
      indexed: 0,
      updated: 0,
      unchanged: 5,
      removed: 0,
      needsEmbedding: 0,
    }),
    embed: vi.fn().mockResolvedValue({
      docsProcessed: 0,
      chunksEmbedded: 0,
      errors: 0,
      durationMs: 100,
    }),
    search: vi.fn(),
    searchLex: vi.fn(),
    searchVector: vi.fn(),
    expandQuery: vi.fn(),
    get: vi.fn(),
    getDocumentBody: vi.fn(),
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
    getStatus: vi.fn(),
    getIndexHealth: vi.fn(),
    close: vi.fn(),
    dbPath: '/tmp/test.sqlite',
  } as unknown as QMDStore
}

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe('hashContent', () => {
  it('should return a SHA-256 hex string', async () => {
    const hash = await hashContent('hello')
    // Known SHA-256 of "hello"
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('should return different hashes for different content', async () => {
    const h1 = await hashContent('hello')
    const h2 = await hashContent('world')
    expect(h1).not.toBe(h2)
  })

  it('should return same hash for same content (deterministic)', async () => {
    const h1 = await hashContent('test content')
    const h2 = await hashContent('test content')
    expect(h1).toBe(h2)
  })
})

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe('extractTitle', () => {
  it('should extract first ## heading from markdown', () => {
    const content = '---\nid: test\n---\n\n## User\nHello\n\n## Assistant\nHi'
    expect(extractTitle(content, 'test.md')).toBe('User')
  })

  it('should extract # heading', () => {
    const content = '# My Document\nSome text'
    expect(extractTitle(content, 'test.md')).toBe('My Document')
  })

  it('should fall back to filename when no heading', () => {
    const content = 'Just some text with no headings'
    expect(extractTitle(content, '2026-03-27/conv_abc-0.md')).toBe('conv_abc-0')
  })

  it('should return Notes heading (matches QMD behavior)', () => {
    const content = '## Notes\n\n## Real Title\nContent'
    expect(extractTitle(content, 'test.md')).toBe('Notes')
  })
})

// ---------------------------------------------------------------------------
// handelize
// ---------------------------------------------------------------------------

describe('handelize', () => {
  it('should lowercase and dash-separate special chars in filename', () => {
    expect(handelize('2026-03-27/conv_abc123-0.md')).toBe('2026-03-27/conv-abc123-0.md')
  })

  it('should preserve directory structure', () => {
    const result = handelize('2026-03-27/conv_abc-0.md')
    expect(result).toContain('2026-03-27/')
  })

  it('should preserve .md extension', () => {
    const result = handelize('2026-03-27/conv_abc-0.md')
    expect(result.endsWith('.md')).toBe(true)
  })

  it('should throw on empty path', () => {
    expect(() => handelize('')).toThrow('path cannot be empty')
  })

  it('should handle multiple underscores', () => {
    const result = handelize('2026-03-27/conv_abc_def_ghi-0.md')
    expect(result).toBe('2026-03-27/conv-abc-def-ghi-0.md')
  })

  it('should handle triple underscore as directory separator', () => {
    const result = handelize('folder___file.md')
    expect(result).toContain('/')
  })
})

// ---------------------------------------------------------------------------
// indexTurnPair
// ---------------------------------------------------------------------------

describe('indexTurnPair', () => {
  let store: QMDStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = createMockStore()
  })

  it('should call insertContent and insertDocument', async () => {
    const content = '---\nid: turn_1\n---\n\n## User\nHello\n\n## Assistant\nHi'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc-0.md`

    await indexTurnPair(store, filePath, content, WALLET_DIR)

    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    expect(internal.insertContent).toHaveBeenCalledTimes(1)
    expect(internal.insertDocument).toHaveBeenCalledTimes(1)
  })

  it('should pass "turns" as the collection name', async () => {
    const content = 'test content'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc-0.md`

    await indexTurnPair(store, filePath, content, WALLET_DIR)

    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    expect(internal.insertDocument).toHaveBeenCalledWith(
      'turns',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
  })

  it('should compute the correct handelize path', async () => {
    const content = 'test'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc123-0.md`

    await indexTurnPair(store, filePath, content, WALLET_DIR)

    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    // handelize('2026-03-27/conv_abc123-0.md') → '2026-03-27/conv-abc123-0.md'
    expect(internal.insertDocument).toHaveBeenCalledWith(
      'turns',
      '2026-03-27/conv-abc123-0.md',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
  })

  it('should skip when document already exists with same hash', async () => {
    const content = 'test content'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc-0.md`
    const hash = await hashContent(content)

    store = createMockStore({
      findActiveDocument: vi.fn().mockReturnValue({ id: 1, hash, title: 'existing' }),
    })

    await indexTurnPair(store, filePath, content, WALLET_DIR)

    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    expect(internal.insertContent).not.toHaveBeenCalled()
    expect(internal.insertDocument).not.toHaveBeenCalled()
  })

  it('should re-index when document exists with different hash', async () => {
    const content = 'updated content'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc-0.md`

    store = createMockStore({
      findActiveDocument: vi.fn().mockReturnValue({ id: 1, hash: 'old_hash', title: 'existing' }),
    })

    await indexTurnPair(store, filePath, content, WALLET_DIR)

    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    expect(internal.insertContent).toHaveBeenCalled()
    expect(internal.insertDocument).toHaveBeenCalled()
  })

  it('should be idempotent — second call with same content skips', async () => {
    const content = 'test content'
    const filePath = `${WALLET_DIR}/turns/2026-03-27/conv_abc-0.md`

    // First call — document doesn't exist
    await indexTurnPair(store, filePath, content, WALLET_DIR)

    // Now simulate that document exists with same hash
    const hash = await hashContent(content)
    const internal = store.internal as Record<string, ReturnType<typeof vi.fn>>
    internal.findActiveDocument.mockReturnValue({ id: 1, hash, title: 'test' })

    // Second call — should skip
    await indexTurnPair(store, filePath, content, WALLET_DIR)

    expect(internal.insertContent).toHaveBeenCalledTimes(1)
    expect(internal.insertDocument).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  let store: QMDStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = createMockStore()
  })

  it('should call store.update with turns collection', async () => {
    await reconcile(store)
    expect(store.update).toHaveBeenCalledWith({ collections: ['turns'] })
  })

  it('should call store.embed when documents need embedding', async () => {
    vi.mocked(store.update).mockResolvedValue({
      collections: 1,
      indexed: 2,
      updated: 0,
      unchanged: 3,
      removed: 0,
      needsEmbedding: 2,
    })

    await reconcile(store)
    expect(store.embed).toHaveBeenCalled()
  })

  it('should NOT call store.embed when no documents need embedding', async () => {
    await reconcile(store)
    expect(store.embed).not.toHaveBeenCalled()
  })

  it('should not throw when update fails', async () => {
    vi.mocked(store.update).mockRejectedValue(new Error('DB locked'))
    await expect(reconcile(store)).resolves.not.toThrow()
  })

  it('should not throw when embed fails', async () => {
    vi.mocked(store.update).mockResolvedValue({
      collections: 1, indexed: 1, updated: 0, unchanged: 0, removed: 0, needsEmbedding: 1,
    })
    vi.mocked(store.embed).mockRejectedValue(new Error('Model load failed'))
    await expect(reconcile(store)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// startReconciliation / stopReconciliation
// ---------------------------------------------------------------------------

describe('startReconciliation / stopReconciliation', () => {
  let store: QMDStore

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    store = createMockStore()
  })

  afterEach(() => {
    stopReconciliation()
    vi.useRealTimers()
  })

  it('should run reconciliation immediately on start', () => {
    startReconciliation(store, 60_000)
    expect(store.update).toHaveBeenCalledTimes(1)
  })

  it('should run reconciliation on interval', () => {
    startReconciliation(store, 60_000)
    expect(store.update).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    expect(store.update).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_000)
    expect(store.update).toHaveBeenCalledTimes(3)
  })

  it('should stop running after stopReconciliation', () => {
    startReconciliation(store, 60_000)
    expect(store.update).toHaveBeenCalledTimes(1)

    stopReconciliation()
    vi.advanceTimersByTime(120_000)
    expect(store.update).toHaveBeenCalledTimes(1)
  })
})
