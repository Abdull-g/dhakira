import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletConfig } from '../../src/config/schema.ts'

const recordTurnMock = vi.fn()
const searchTurnsMock = vi.fn()
const runExtractionMock = vi.fn()

vi.mock('../../src/capture/record.js', () => ({
  recordTurn: recordTurnMock,
}))

vi.mock('../../src/retrieval/search.js', () => ({
  searchTurns: searchTurnsMock,
}))

vi.mock('../../src/extraction/runner.js', () => ({
  runExtraction: runExtractionMock,
}))

const { createApiHandler } = await import('../../src/dashboard/api.ts')
const { recordRecall, resetRetrievalMetrics } = await import('../../src/retrieval/metrics.ts')

let walletDir: string
let server: Server
let baseUrl: string
const store = {} as QMDStore

function makeConfig(): WalletConfig {
  return {
    walletDir,
    proxy: { port: 4100, host: '127.0.0.1' },
    dashboard: { port: 4101, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion: 'v2', debug: false },
    extraction: {
      model: 'gpt-4o-mini',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
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

async function startApi(): Promise<void> {
  const handler = createApiHandler({ config: makeConfig(), store })
  server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not listen')
  baseUrl = `http://127.0.0.1:${address.port}`
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

describe('dashboard API', () => {
  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'memory-wallet-dashboard-api-'))
    recordTurnMock.mockResolvedValue({
      ok: true,
      value: {
        id: 'turn_abc123',
        userContent: 'I prefer TypeScript',
        assistantContent: '',
        timestamp: '2026-05-10T00:00:00.000Z',
        tool: 'user-recorded',
        sessionId: 'user-records',
        turnIndex: 0,
        contextFingerprint: 'default',
        projectId: 'global',
        userRecorded: true,
      },
    })
    searchTurnsMock.mockResolvedValue({ ok: true, value: [] })
    runExtractionMock.mockResolvedValue({
      ok: true,
      value: {
        conversationsProcessed: 1,
        factsExtracted: 2,
        memoriesCreated: 1,
        memoriesUpdated: 0,
        memoriesInvalidated: 0,
        memoriesNoop: 0,
      },
    })
    await startApi()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(walletDir, { recursive: true, force: true })
  })

  it('POST /api/record returns 200 and turnPair on success', async () => {
    const response = await request('POST', '/api/record', { content: 'I prefer TypeScript' })

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.turnPair.id).toBe('turn_abc123')
    expect(recordTurnMock).toHaveBeenCalledWith(walletDir, 'I prefer TypeScript', { store })
  })

  it('POST /api/record returns 400 on empty content', async () => {
    const response = await request('POST', '/api/record', { content: '' })

    expect(response.status).toBe(400)
    expect(response.body.ok).toBe(false)
  })

  it('POST /api/record returns 400 on missing content field', async () => {
    const response = await request('POST', '/api/record', {})

    expect(response.status).toBe(400)
    expect(response.body.ok).toBe(false)
  })

  it('POST /api/record returns 400 on engine error', async () => {
    recordTurnMock.mockResolvedValueOnce({ ok: false, error: new Error('record failed') })

    const response = await request('POST', '/api/record', { content: 'fact' })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('record failed')
  })

  it('GET /api/search returns 400 when q is missing', async () => {
    const response = await request('GET', '/api/search')

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('q parameter is required')
  })

  it('GET /api/search returns results from searchTurns', async () => {
    searchTurnsMock.mockResolvedValueOnce({
      ok: true,
      value: [{ turnPair: { id: 'turn_1' }, score: 0.8, source: 'file.md' }],
    })

    const response = await request('GET', '/api/search?q=typescript')

    expect(response.status).toBe(200)
    expect(response.body.results).toHaveLength(1)
    expect(response.body.results[0].turnPair.id).toBe('turn_1')
  })

  it('GET /api/search clamps limit', async () => {
    await request('GET', '/api/search?q=typescript&limit=999')

    expect(searchTurnsMock).toHaveBeenCalledWith(store, { query: 'typescript', limit: 50 })
  })

  it('POST /api/extract returns 200 and stats on success', async () => {
    const response = await request('POST', '/api/extract')

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.stats.memoriesCreated).toBe(1)
  })

  it('POST /api/extract returns 500 on engine error', async () => {
    runExtractionMock.mockResolvedValueOnce({ ok: false, error: new Error('extract failed') })

    const response = await request('POST', '/api/extract')

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('extract failed')
  })

  it('PUT /api/profile returns 404', async () => {
    const response = await request('PUT', '/api/profile', { content: 'nope' })

    expect(response.status).toBe(404)
  })

  it('GET /api/status surfaces recall latency + timeout counters (D2 visibility)', async () => {
    resetRetrievalMetrics()
    recordRecall(120, false)
    recordRecall(950, true)

    const response = await request('GET', '/api/status')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      recallCount: 2,
      recallTimeouts: 1,
      lastRecallMs: 950,
      maxRecallMs: 950,
      modelsResident: true,
    })
    expect(typeof response.body.lastRecallTimeoutAt).toBe('string')
  })

  it('GET /api/status includes userRecordsCount and lastExtractionAt', async () => {
    await mkdir(join(walletDir, 'turns', '2026-05-10'), { recursive: true })
    await writeFile(join(walletDir, 'turns', '2026-05-10', 'user-records-0.md'), '', 'utf8')
    await writeFile(join(walletDir, 'turns', '2026-05-10', 'user-records-1.md'), '', 'utf8')
    await writeFile(join(walletDir, 'turns', '2026-05-10', 'session-0.md'), '', 'utf8')
    await writeFile(
      join(walletDir, '.extraction-state.json'),
      JSON.stringify({ lastRunAt: '2026-05-10T00:00:00.000Z' }),
      'utf8',
    )

    const response = await request('GET', '/api/status')

    expect(response.status).toBe(200)
    expect(response.body.userRecordsCount).toBe(2)
    expect(response.body.lastExtractionAt).toBe('2026-05-10T00:00:00.000Z')
  })
})
