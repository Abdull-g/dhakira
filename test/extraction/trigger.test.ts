import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletConfig } from '../../src/config/schema.ts'

const runExtractionMock = vi.fn()
const warnMock = vi.fn()
let walletDir: string

function makeConfig(overrides: Partial<WalletConfig['extraction']> = {}): WalletConfig {
  return {
    walletDir,
    proxy: { port: 4100, host: '127.0.0.1' },
    dashboard: { port: 4101, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion: 'v2', debug: false },
    extraction: {
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      ...overrides,
    },
    retrieval: { modelsResident: true },
    injection: {
      maxTokens: 1800,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
    },
    incognito: false,
  }
}

function makeStore(): QMDStore {
  return {
    searchLex: vi.fn(),
    search: vi.fn(),
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
    update: vi.fn(),
    embed: vi.fn(),
    getStatus: vi.fn(),
    getIndexHealth: vi.fn(),
    close: vi.fn(),
    internal: {} as never,
    dbPath: join(walletDir, 'wallet.sqlite'),
  } as unknown as QMDStore
}

async function loadTrigger(): Promise<typeof import('../../src/extraction/trigger.ts')> {
  vi.resetModules()
  vi.doMock('../../src/extraction/runner.js', () => ({
    runExtraction: runExtractionMock,
  }))
  vi.doMock('../../src/utils/logger.js', () => ({
    createLogger: () => ({
      warn: warnMock,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }))
  return import('../../src/extraction/trigger.ts')
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('maybeTriggerExtraction', () => {
  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'memory-wallet-trigger-'))
    runExtractionMock.mockReset()
    warnMock.mockReset()
    runExtractionMock.mockResolvedValue({
      ok: true,
      value: {
        conversationsProcessed: 0,
        factsExtracted: 0,
        memoriesCreated: 0,
        memoriesUpdated: 0,
        memoriesInvalidated: 0,
        memoriesNoop: 0,
      },
    })
    delete process.env.FAKE_KEY
  })

  afterEach(async () => {
    vi.doUnmock('../../src/extraction/runner.js')
    vi.doUnmock('../../src/utils/logger.js')
    await rm(walletDir, { recursive: true, force: true })
  })

  it('fires after 10 turns when no prior extraction has run', async () => {
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 9; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    expect(runExtractionMock).not.toHaveBeenCalled()

    await maybeTriggerExtraction(walletDir, store, config)
    expect(runExtractionMock).toHaveBeenCalledTimes(1)
  })

  // v0.3.1 (audit D14): the counter survives a daemon restart.
  it('persists the capture counter to .extraction-state.json and resumes it after a restart', async () => {
    const first = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 7; i++) await first.maybeTriggerExtraction(walletDir, store, config)
    await first.flushTriggerState()
    const onDisk = JSON.parse(
      await readFile(join(walletDir, '.extraction-state.json'), 'utf8'),
    ) as { capturedSinceLastTrigger?: number; lastRunAt?: unknown }
    expect(onDisk.capturedSinceLastTrigger).toBe(7)
    expect(onDisk.lastRunAt).toBeNull()

    // "Restart": a fresh module instance (counter would have been 0 before v0.3.1).
    const restarted = await loadTrigger()
    for (let i = 0; i < 2; i++) await restarted.maybeTriggerExtraction(walletDir, store, config)
    expect(runExtractionMock).not.toHaveBeenCalled() // 7 + 2 = 9 < 10

    await restarted.maybeTriggerExtraction(walletDir, store, config) // 10th overall
    expect(runExtractionMock).toHaveBeenCalledTimes(1)

    // After firing, the persisted counter is back to 0.
    await restarted.flushTriggerState()
    const after = JSON.parse(await readFile(join(walletDir, '.extraction-state.json'), 'utf8')) as {
      capturedSinceLastTrigger?: number
    }
    expect(after.capturedSinceLastTrigger).toBe(0)
  })

  it('fires after 50 turns once a prior extraction exists', async () => {
    await writeFile(
      join(walletDir, '.extraction-state.json'),
      JSON.stringify({
        processedConversationIds: [],
        rollingSummary: '',
        lastRunAt: '2026-05-09T00:00:00.000Z',
      }),
      'utf8',
    )
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 49; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    expect(runExtractionMock).not.toHaveBeenCalled()

    await maybeTriggerExtraction(walletDir, store, config)
    expect(runExtractionMock).toHaveBeenCalledTimes(1)
  })

  it('lock prevents concurrent extractions', async () => {
    runExtractionMock.mockReturnValue(new Promise(() => {}))
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 9; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    maybeTriggerExtraction(walletDir, store, config).catch(() => {})
    await tick()
    expect(runExtractionMock).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 100; i++) {
      maybeTriggerExtraction(walletDir, store, config).catch(() => {})
    }
    await tick()
    expect(runExtractionMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces follow-ups: at most one pending after running extraction', async () => {
    let resolveRun: (() => void) | undefined
    runExtractionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = () =>
            resolve({
              ok: true,
              value: {
                conversationsProcessed: 0,
                factsExtracted: 0,
                memoriesCreated: 0,
                memoriesUpdated: 0,
                memoriesInvalidated: 0,
                memoriesNoop: 0,
              },
            })
        }),
    )
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 9; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    maybeTriggerExtraction(walletDir, store, config).catch(() => {})
    await tick()
    expect(runExtractionMock).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i++) {
      maybeTriggerExtraction(walletDir, store, config).catch(() => {})
    }
    await tick()
    expect(runExtractionMock).toHaveBeenCalledTimes(1)

    resolveRun?.()
    await tick()
    expect(runExtractionMock).toHaveBeenCalledTimes(2)
  })

  it('fires extraction even when extraction.apiKey is empty', async () => {
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig({ apiKey: '' })
    const store = makeStore()

    for (let i = 0; i < 10; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    expect(runExtractionMock).toHaveBeenCalledTimes(1)
    expect(warnMock).not.toHaveBeenCalled()
  })

  it('env: prefix resolution is handled by callExtractionLLM, not the trigger', async () => {
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig({ apiKey: 'env:FAKE_KEY' })
    const store = makeStore()

    for (let i = 0; i < 10; i++) {
      await maybeTriggerExtraction(walletDir, store, config)
    }
    expect(runExtractionMock).toHaveBeenCalledTimes(1)
  })

  it('extraction error does not break capture path', async () => {
    runExtractionMock.mockRejectedValue(new Error('extraction failed'))
    const { maybeTriggerExtraction } = await loadTrigger()
    const config = makeConfig()
    const store = makeStore()

    for (let i = 0; i < 50; i++) {
      await expect(maybeTriggerExtraction(walletDir, store, config)).resolves.toBeUndefined()
    }
    expect(runExtractionMock).toHaveBeenCalled()
  })
})
