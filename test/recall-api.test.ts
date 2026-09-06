// CP3 tests for the recall verb's HTTP edge (POST /api/recall).
//
// recallOnce's retrieval/composition is unit-tested in recall.test.ts. Here we prove
// the HTTP handler: it wraps recallOnce, returns { text, turnCount, projectId }, fails
// safe on malformed bodies (400, never throws), and — critically — resolves projectId
// through the SAME ladder as /api/ingest, so an adapter sending one { cwd } signal to
// both verbs gets matching capture/recall scope.
//
// Like recall.test.ts (CP1), the store is MOCKED: store.search is left undefined so
// searchTurns falls back to searchLex, which we stub. No real createWalletStore, so no
// 1.28GB embedding-model warmup — these stay deterministic and fast in CI / fresh clones.

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SearchResult as QMDSearchResult, QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WalletConfig } from '../src/config/schema.ts'
import { createApiHandler } from '../src/dashboard/api.ts'
import { resolveIngestProjectId } from '../src/ingest.ts'

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
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    },
    retrieval: { modelsResident: true },
    injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
    incognito: false,
  }
}

/** Mock store: search() undefined → searchTurns falls back to searchLex (no model). */
function makeMockStore(results: QMDSearchResult[]): QMDStore {
  return {
    searchLex: async () => results,
  } as unknown as QMDStore
}

describe('POST /api/recall — handler', () => {
  let walletDir: string
  let store: QMDStore
  let server: Server
  let baseUrl: string

  async function startApi(config: WalletConfig): Promise<void> {
    const handler = createApiHandler({ config, store })
    server = createServer((req, res) => {
      handler(req, res).catch(() => {
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('no listen')
    baseUrl = `http://127.0.0.1:${address.port}`
  }

  async function postRecall(rawBody: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    })
    return { status: response.status, body: await response.json() }
  }

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-recall-http-'))
    store = makeMockStore([])
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(walletDir, { recursive: true, force: true })
  })

  it('valid query → 200 with { text, turnCount, projectId } shape (no matches → null text)', async () => {
    await startApi(makeConfig(walletDir))
    const { status, body } = await postRecall(
      JSON.stringify({ query: 'what is the retry policy?', tool: 'claude-code' }),
    )
    expect(status).toBe(200)
    const b = body as { text: string | null; turnCount: number; projectId: string }
    expect(b.text).toBeNull()
    expect(b.turnCount).toBe(0)
    expect(b.projectId).toBe('global')
  })

  it('explicit projectId is used as-is and echoed back', async () => {
    await startApi(makeConfig(walletDir))
    const { body } = await postRecall(
      JSON.stringify({ query: 'q', projectId: 'git:github.com/acme/widgets', tool: 'claude-code' }),
    )
    expect((body as { projectId: string }).projectId).toBe('git:github.com/acme/widgets')
  })

  it('resolves projectId from cwd via the SAME ladder /api/ingest uses (scopes match)', async () => {
    await startApi(makeConfig(walletDir))

    const { body } = await postRecall(
      JSON.stringify({ query: 'q', cwd: walletDir, tool: 'claude-code' }),
    )
    const recallProjectId = (body as { projectId: string }).projectId

    // resolveIngestProjectId is the exact resolver the ingest verb uses; equality proves
    // recall and ingest scope a given cwd to the same project (no full ingest round-trip,
    // no store/model needed — this is about the projectId ladder, not stored data).
    const expected = await resolveIngestProjectId({ cwd: walletDir })
    expect(recallProjectId.startsWith('folder:')).toBe(true)
    expect(recallProjectId).toBe(expected)
  })

  it('missing / non-string query → 400', async () => {
    await startApi(makeConfig(walletDir))
    const missing = await postRecall(JSON.stringify({ tool: 'claude-code' }))
    expect(missing.status).toBe(400)
    const nonString = await postRecall(JSON.stringify({ query: 123, tool: 'claude-code' }))
    expect(nonString.status).toBe(400)
    const empty = await postRecall(JSON.stringify({ query: '   ', tool: 'claude-code' }))
    expect(empty.status).toBe(400)
  })

  it('malformed JSON → 400, fail-safe (no throw)', async () => {
    await startApi(makeConfig(walletDir))
    const { status, body } = await postRecall('{ not json')
    expect(status).toBe(400)
    expect(body).toMatchObject({ text: null, reason: 'invalid_json' })
  })
})
