// `dhakira doctor` (D2, v0.3.1) — hermetic: injected fetch (no sockets), injected
// model-presence check (never touches ~/.cache), injected store (no QMD).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WalletConfig } from '../src/config/schema.ts'
import {
  defaultModelsPresent,
  HOOK_BUDGET_MS,
  REPRESENTATIVE_QUERY,
  runDoctor,
} from '../src/doctor.ts'
import { resetRetrievalMetrics } from '../src/retrieval/metrics.ts'

function makeConfig(overrides: Partial<WalletConfig['retrieval']> = {}): WalletConfig {
  return {
    walletDir: '/tmp/doctor-wallet',
    proxy: { port: 4100, host: '127.0.0.1' },
    dashboard: { port: 4101, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion: 'v2', debug: false },
    extraction: { model: 'm', apiKey: '', baseUrl: 'https://api.openai.com/v1' },
    retrieval: { modelsResident: true, ...overrides },
    injection: {
      maxTokens: 1800,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
      globalMaxTokens: 250,
      projectMaxTokens: 700,
    },
    incognito: false,
  }
}

/** A fake daemon: /api/status answers with the given metrics; /api/recall after `recallDelayMs`. */
function fakeDaemon(opts: {
  status?: Record<string, unknown> | null
  recallDelayMs?: number
  recallStatus?: number
}): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/api/status')) {
      if (opts.status === null) throw new Error('ECONNREFUSED')
      return { ok: true, status: 200, json: async () => opts.status ?? {} } as Response
    }
    if (url.endsWith('/api/recall')) {
      await new Promise((r) => setTimeout(r, opts.recallDelayMs ?? 5))
      const status = opts.recallStatus ?? 200
      return {
        ok: status < 400,
        status,
        json: async () => ({ text: 'x', turnCount: 3, projectId: 'global' }),
      } as Response
    }
    throw new Error(`unexpected url ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const turnBody = [
  '---',
  'id: turn_1',
  'sessionId: s',
  'tool: claude-code',
  `timestamp: ${new Date().toISOString()}`,
  'turnIndex: 0',
  '---',
  '',
  '## User',
  'what did we decide about the architecture',
  '',
  '## Assistant',
  'Hooks first.',
  '',
].join('\n')

function fakeStore(opts: { hybridDelayMs?: number; hybridThrows?: boolean } = {}): QMDStore {
  return {
    search: vi.fn().mockImplementation(async () => {
      if (opts.hybridThrows) throw new Error('models unavailable')
      await new Promise((r) => setTimeout(r, opts.hybridDelayMs ?? 1))
      return [{ file: '/w/turns/x.md', body: turnBody, score: 0.9 }]
    }),
    searchLex: vi
      .fn()
      .mockResolvedValue([{ filepath: '/w/turns/x.md', body: turnBody, score: 0.5 }]),
    getDocumentBody: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore
}

describe("runDoctor — daemon running (hook's-eye measurement)", () => {
  beforeEach(() => resetRetrievalMetrics())

  it('measures /api/recall through the daemon and passes when inside the budget', async () => {
    const daemon = fakeDaemon({
      status: { recallCount: 12, recallTimeouts: 0, lastRecallTimeoutAt: null, maxRecallMs: 300 },
      recallDelayMs: 5,
    })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: daemon.fetchImpl,
      modelsPresent: () => true,
    })
    expect(report.daemonRunning).toBe(true)
    expect(report.recall.path).toBe('daemon')
    expect(report.recall.turnCount).toBe(3)
    expect(report.recall.measuredMs).toBeLessThan(HOOK_BUDGET_MS)
    expect(report.verdict).toBe('pass')
    expect(report.daemonMetrics).toEqual({
      recallCount: 12,
      recallTimeouts: 0,
      lastRecallTimeoutAt: null,
      maxRecallMs: 300,
    })
    // The measurement uses a hook-shaped query and identifies itself as the CLI (CSRF guard).
    const recallCall = daemon.calls.find((c) => c.url.endsWith('/api/recall'))
    expect(JSON.parse(String(recallCall?.init?.body))).toMatchObject({
      query: REPRESENTATIVE_QUERY,
    })
    expect((recallCall?.init?.headers as Record<string, string>)['X-Dhakira-Client']).toBe('cli')
  })

  it('WARNs and explains when the measured recall exceeds the hook budget', async () => {
    // Deterministic clock: started at 0, finished at 2000 → 2000 ms measured.
    const ticks = [0, 2000]
    const now = (): number => ticks.shift() ?? 2000
    const daemon = fakeDaemon({ status: { recallCount: 1, recallTimeouts: 0 }, recallDelayMs: 1 })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: daemon.fetchImpl,
      modelsPresent: () => true,
      now,
    })
    expect(report.recall.measuredMs).toBe(2000)
    expect(report.verdict).toBe('warn')
    expect(report.notes.join('\n')).toMatch(/exceeds the 1500 ms hook budget/)
  })

  it("surfaces the daemon's BM25-served counter as a note", async () => {
    const daemon = fakeDaemon({
      status: {
        recallCount: 40,
        recallTimeouts: 7,
        lastRecallTimeoutAt: '2026-09-06T06:00:00.000Z',
        maxRecallMs: 2400,
      },
    })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: daemon.fetchImpl,
      modelsPresent: () => true,
    })
    expect(report.notes.join('\n')).toMatch(/BM25 on 7 of 40 recalls/)
    expect(report.notes.join('\n')).toContain('2026-09-06T06:00:00.000Z')
  })

  it('reports a daemon HTTP error as path=error with a warn verdict', async () => {
    const daemon = fakeDaemon({ status: {}, recallStatus: 500 })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: daemon.fetchImpl,
      modelsPresent: () => true,
    })
    expect(report.recall.path).toBe('error')
    expect(report.recall.error).toBe('HTTP 500')
    expect(report.verdict).toBe('warn')
  })
})

describe('runDoctor — daemon stopped (in-process measurement)', () => {
  beforeEach(() => resetRetrievalMetrics())

  it('hybrid answers before the deadline → path=hybrid, pass', async () => {
    const store = fakeStore({ hybridDelayMs: 1 })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: fakeDaemon({ status: null }).fetchImpl,
      modelsPresent: () => true,
      openStore: async () => ({ ok: true, value: store }),
    })
    expect(report.daemonRunning).toBe(false)
    expect(report.recall.path).toBe('hybrid')
    expect(report.recall.turnCount).toBe(1)
    expect(report.verdict).toBe('pass')
    expect(store.close).toHaveBeenCalled()
    expect(report.notes.join('\n')).toMatch(/Daemon not running/)
  })

  it('models NOT downloaded → BM25 only, hybrid never attempted (no download), warn with guidance', async () => {
    const store = fakeStore()
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: fakeDaemon({ status: null }).fetchImpl,
      modelsPresent: () => false,
      openStore: async () => ({ ok: true, value: store }),
    })
    expect(report.modelsPresent).toBe(false)
    expect(report.recall.path).toBe('bm25-only')
    expect(store.search).not.toHaveBeenCalled()
    expect(store.searchLex).toHaveBeenCalledTimes(1)
    expect(report.verdict).toBe('warn')
    expect(report.notes.join('\n')).toMatch(/not downloaded/)
  })

  it('hybrid misses the deadline → BM25 served, path=bm25-deadline, warn explains cold models', async () => {
    // Deadline is fixed at HYBRID_DEADLINE_MS inside searchTurns; use a hybrid slower than that.
    const store = fakeStore({ hybridDelayMs: 1200 })
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: fakeDaemon({ status: null }).fetchImpl,
      modelsPresent: () => true,
      openStore: async () => ({ ok: true, value: store }),
    })
    expect(report.recall.path).toBe('bm25-deadline')
    expect(report.recall.measuredMs).toBeLessThan(HOOK_BUDGET_MS)
    expect(report.verdict).toBe('warn')
    expect(report.notes.join('\n')).toMatch(/missed the 900 ms daemon deadline/)
  }, 10_000)

  it('modelsResident=false is called out as a note', async () => {
    const report = await runDoctor({
      config: makeConfig({ modelsResident: false }),
      fetchImpl: fakeDaemon({ status: null }).fetchImpl,
      modelsPresent: () => true,
      openStore: async () => ({ ok: true, value: fakeStore() }),
    })
    expect(report.modelsResident).toBe(false)
    expect(report.notes.join('\n')).toMatch(/modelsResident is false/)
  })

  it('store failure → path=error, never throws', async () => {
    const report = await runDoctor({
      config: makeConfig(),
      fetchImpl: fakeDaemon({ status: null }).fetchImpl,
      modelsPresent: () => true,
      openStore: async () => ({ ok: false, error: new Error('sqlite locked') }),
    })
    expect(report.recall.path).toBe('error')
    expect(report.recall.error).toBe('sqlite locked')
    expect(report.verdict).toBe('warn')
  })
})

describe('defaultModelsPresent — QMD cache probe (no download ever)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qmd-models-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('false for a missing or empty cache dir', async () => {
    expect(defaultModelsPresent(join(dir, 'nope'))).toBe(false)
    expect(defaultModelsPresent(dir)).toBe(false)
  })

  it('false while any of the three models is still a partial (.ipull) download', async () => {
    await writeFile(join(dir, 'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf'), '')
    await writeFile(join(dir, 'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf'), '')
    await writeFile(join(dir, 'hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf.ipull'), '')
    expect(defaultModelsPresent(dir)).toBe(false)
  })

  it('true once all three .gguf files are complete', async () => {
    await writeFile(join(dir, 'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf'), '')
    await writeFile(join(dir, 'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf'), '')
    await writeFile(join(dir, 'hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf'), '')
    expect(defaultModelsPresent(dir)).toBe(true)
  })
})
