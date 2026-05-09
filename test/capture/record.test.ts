import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recordTurn } from '../../src/capture/record.ts'
import { buildTurnFilePath } from '../../src/capture/turns.ts'
import { parseTurnPairFromBody } from '../../src/retrieval/search.ts'

let walletDir: string

function makeStore(throwsOnInsert = false): QMDStore {
  return {
    internal: {
      findActiveDocument: vi.fn().mockReturnValue(null),
      insertContent: throwsOnInsert
        ? vi.fn(() => {
            throw new Error('index add failed')
          })
        : vi.fn(),
      insertDocument: vi.fn(),
    },
    update: vi.fn(),
    embed: vi.fn(),
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
    dbPath: join(walletDir, 'wallet.sqlite'),
  } as unknown as QMDStore
}

describe('recordTurn', () => {
  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'memory-wallet-record-'))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('recordTurn writes a turn pair to disk', async () => {
    const result = await recordTurn(walletDir, 'I prefer TypeScript', { store: makeStore() })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const filePath = buildTurnFilePath(walletDir, result.value)
    await expect(access(filePath)).resolves.toBeUndefined()

    const body = await readFile(filePath, 'utf8')
    expect(body).toContain('userRecorded: true')
    expect(body).toContain('tool: user-recorded')
    expect(body).toContain('sessionId: user-records')
    expect(body).toContain('turnIndex: 0')
  })

  it('recordTurn increments turnIndex on subsequent calls', async () => {
    const store = makeStore()
    const results = [
      await recordTurn(walletDir, 'Fact one', { store }),
      await recordTurn(walletDir, 'Fact two', { store }),
      await recordTurn(walletDir, 'Fact three', { store }),
    ]

    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => (result.ok ? result.value.turnIndex : null))).toEqual([0, 1, 2])
  })

  it('recordTurn rejects empty input', async () => {
    const empty = await recordTurn(walletDir, '', { store: makeStore() })
    const whitespace = await recordTurn(walletDir, '   ', { store: makeStore() })

    expect(empty.ok).toBe(false)
    expect(whitespace.ok).toBe(false)
    if (empty.ok || whitespace.ok) return
    expect(empty.error.message).toBe('recordTurn: empty input')
    expect(whitespace.error.message).toBe('recordTurn: empty input')
  })

  it('recordTurn rejects oversized input', async () => {
    const result = await recordTurn(walletDir, 'x'.repeat(10_001), { store: makeStore() })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('recordTurn: input exceeds 10000 chars')
  })

  it('recordTurn returns ok even if indexing fails', async () => {
    const result = await recordTurn(walletDir, 'I use vitest', { store: makeStore(true) })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const filePath = buildTurnFilePath(walletDir, result.value)
    await expect(access(filePath)).resolves.toBeUndefined()
  })

  it('recordTurn round-trips userRecorded flag through search parser', async () => {
    const result = await recordTurn(walletDir, 'I prefer local-first tools', { store: makeStore() })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const body = await readFile(buildTurnFilePath(walletDir, result.value), 'utf8')
    const parsed = parseTurnPairFromBody(body)

    expect(parsed?.userRecorded).toBe(true)
  })
})
