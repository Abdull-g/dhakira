import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HybridQueryResult, QMDStore } from '@tobilu/qmd'
import { describe, expect, it, vi } from 'vitest'
import { createWalletStore } from '../../src/retrieval/store.js'
import { searchTurns } from '../../src/retrieval/search.js'

vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(async (options: StoreOptions) => {
    const docs: IndexedDoc[] = []
    const collectionEntries = Object.entries(options.config.collections)

    const reindex = async (): Promise<void> => {
      docs.length = 0
      for (const [collection, config] of collectionEntries) {
        const dateDirs = await readdir(config.path, { withFileTypes: true }).catch(() => [])
        for (const dateDir of dateDirs) {
          if (!dateDir.isDirectory()) continue
          const dirPath = join(config.path, dateDir.name)
          const files = await readdir(dirPath, { withFileTypes: true })
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.md')) continue
            const filePath = join(dirPath, file.name)
            docs.push({
              collection,
              file: filePath,
              body: await readFile(filePath, 'utf8'),
            })
          }
        }
      }
    }

    const search = async (query: { query: string; collection?: string }): Promise<HybridQueryResult[]> =>
      docs
        .filter((doc) => (query.collection ? doc.collection === query.collection : true))
        .filter((doc) => doc.body.includes(query.query))
        .map((doc) => ({
          file: doc.file,
          displayPath: doc.file,
          title: doc.file,
          body: doc.body,
          bestChunk: doc.body,
          bestChunkPos: 0,
          score: 1,
          context: '',
          docid: doc.file,
        }))

    return {
      reindex,
      search,
      // v0.3.1: an empty-but-ok hybrid result now falls back to BM25 (defect #13),
      // so searchLex must answer like QMD does — with an array (here: no hits).
      searchLex: vi.fn().mockResolvedValue([]),
      listCollections: async () => collectionEntries.map(([name]) => name),
      close: vi.fn(),
    }
  }),
}))

interface StoreOptions {
  config: {
    collections: Record<string, { path: string }>
  }
}

interface IndexedDoc {
  collection: string
  file: string
  body: string
}

describe('conversations collection is not indexed', () => {
  it('searchTurns does not surface content from conversations/*.md', async () => {
    const marker = 'DHAKIRA_PHASE9_MARKER_A1B2C3'
    const walletDir = join(tmpdir(), `dhakira-phase9-${crypto.randomUUID()}`)
    const conversationsDir = join(walletDir, 'conversations', '2026-05-02')
    const turnsDir = join(walletDir, 'turns', '2026-05-02')
    await mkdir(conversationsDir, { recursive: true })
    await mkdir(turnsDir, { recursive: true })

    const conversationFile = join(conversationsDir, 'Claude Code-23h32m-raw.md')
    await writeFile(
      conversationFile,
      `# Raw Conversation\n\nProvider system prompt with ${marker} that must not be indexed.\n`,
      'utf8',
    )

    const turnFile = join(turnsDir, 'conv_phase9-0.md')
    await writeFile(
      turnFile,
      [
        '---',
        'id: turn_phase9_001',
        'sessionId: conv_phase9',
        'tool: claude-code',
        'timestamp: 2026-05-02T20:32:00Z',
        'turnIndex: 0',
        '---',
        '',
        '## User',
        'How should phase nine prove indexed turns still work?',
        '',
        '## Assistant',
        'The PHASE9_TURN_CONTROL text should be found from the turns collection.',
        '',
      ].join('\n'),
      'utf8',
    )

    const storeResult = await createWalletStore(walletDir)
    expect(storeResult.ok).toBe(true)
    if (!storeResult.ok) return

    const store = storeResult.value as QMDStore & {
      reindex: () => Promise<void>
      listCollections: () => Promise<string[]>
    }
    await store.reindex()

    const collections = await store.listCollections()
    expect(collections).not.toContain('conversations')

    const markerResults = await searchTurns(store, { query: marker, minScore: 0 })
    expect(markerResults.ok).toBe(true)
    if (!markerResults.ok) return
    expect(markerResults.value.every((result) => result.source !== conversationFile)).toBe(true)
    expect(markerResults.value).toHaveLength(0)

    const qmdResults = await store.search({ query: marker, limit: 10 })
    expect(qmdResults.every((result) => result.file !== conversationFile)).toBe(true)
    expect(qmdResults).toHaveLength(0)

    const turnResults = await searchTurns(store, { query: 'PHASE9_TURN_CONTROL', minScore: 0 })
    expect(turnResults.ok).toBe(true)
    if (!turnResults.ok) return
    expect(turnResults.value).toHaveLength(1)
    expect(turnResults.value[0]?.source).toBe(turnFile)
  })
})
