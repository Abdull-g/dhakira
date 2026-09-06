import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture-wiring tests: keep the Layer-2 auto-trigger inert. The real trigger would
// start runExtraction (local model!) after 10 captures and its background writes
// raced the tmpdir polling below under a loaded suite (v0.3.1 test hygiene).
vi.mock('../../src/extraction/trigger.js', () => ({
  maybeTriggerExtraction: vi.fn().mockResolvedValue(undefined),
}))

import type { WalletConfig } from '../../src/config/schema.ts'
import { createCaptureConversation } from '../../src/index.ts'
import { parseAnthropicRequest } from '../../src/proxy/anthropic.ts'
import type { NormalizedRequest } from '../../src/proxy/types.ts'

interface CorpusRecord {
  id: string
  startedAt: string
  url: string
  reqHeaders: Record<string, string>
  reqBody: unknown
  respBodyText: string
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v2.jsonl')

function makeConfig(walletDir: string, pipelineVersion: 'v1' | 'v2'): WalletConfig {
  return {
    walletDir,
    proxy: { port: 0, host: '127.0.0.1' },
    dashboard: { port: 0, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion, debug: false },
    extraction: {
      schedule: '0 2 * * *',
      model: 'gpt-4o-mini',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
    },
    retrieval: { modelsResident: true },
    injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
    incognito: false,
  }
}

function makeStore(): QMDStore {
  return {
    internal: {
      findActiveDocument: () => null,
      insertContent: () => {},
      insertDocument: () => {},
    },
  } as unknown as QMDStore
}

async function loadMessageRecords(): Promise<CorpusRecord[]> {
  const raw = await readFile(CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
    .filter((record) => record.url.includes('/v1/messages'))
}

function normalizeRecord(record: CorpusRecord): NormalizedRequest {
  const parsed = parseAnthropicRequest(record.reqBody, record.reqHeaders, 'claude-code')
  if (!parsed.ok) throw parsed.error
  return { ...parsed.value, timestamp: new Date(record.startedAt) }
}

async function listTurnFiles(walletDir: string): Promise<string[]> {
  try {
    const entries = (await readdir(join(walletDir, 'turns'), { recursive: true })) as string[]
    return entries.filter((entry) => entry.endsWith('.md')).sort()
  } catch {
    return []
  }
}

async function readTurnFiles(walletDir: string): Promise<string[]> {
  const files = await listTurnFiles(walletDir)
  return Promise.all(files.map((file) => readFile(join(walletDir, 'turns', file), 'utf8')))
}

function section(content: string, heading: 'User' | 'Assistant'): string {
  const nextHeading = heading === 'User' ? '\n\n## Assistant\n' : ''
  const start = content.indexOf(`## ${heading}\n`)
  if (start === -1) return ''
  const bodyStart = start + `## ${heading}\n`.length
  if (nextHeading.length === 0) return content.slice(bodyStart)
  const end = content.indexOf(nextHeading, bodyStart)
  return end === -1 ? content.slice(bodyStart) : content.slice(bodyStart, end)
}

async function waitForAtLeastTurnFiles(walletDir: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2000
  let files: string[] = []
  while (Date.now() < deadline) {
    files = await listTurnFiles(walletDir)
    if (files.length >= count) return files
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return files
}

describe('v2 capture pipeline live wiring', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-v2-wired-'))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('writes seven clean v2 turn pairs from the Claude Code corpus', async () => {
    const records = await loadMessageRecords()
    expect(records).toHaveLength(18)

    const captureConversation = createCaptureConversation(makeConfig(walletDir, 'v2'), makeStore())
    for (const record of records) {
      captureConversation(normalizeRecord(record), Buffer.from(record.respBodyText, 'utf8'))
    }

    const files = await waitForAtLeastTurnFiles(walletDir, 7)
    expect(files).toHaveLength(7)

    const contents = await readTurnFiles(walletDir)
    expect(contents.every((content) => !content.includes('<system-reminder>'))).toBe(true)
    expect(contents.every((content) => !section(content, 'Assistant').includes('{"title":'))).toBe(
      true,
    )
    expect(contents.every((content) => section(content, 'User').trim().length > 0)).toBe(true)
    expect(contents.every((content) => section(content, 'Assistant').trim().length > 0)).toBe(true)
  })

  it('keeps v1 capture broader than the gated v2 corpus path', async () => {
    const records = await loadMessageRecords()
    const captureConversation = createCaptureConversation(makeConfig(walletDir, 'v1'), makeStore())
    for (const record of records) {
      captureConversation(normalizeRecord(record), Buffer.from(record.respBodyText, 'utf8'))
    }

    const files = await waitForAtLeastTurnFiles(walletDir, 8)
    expect(files.length).toBeGreaterThan(7)
  })

  it('falls back to v1 capture when v2 Anthropic ingest fails', async () => {
    const normalized: NormalizedRequest = {
      id: 'req_malformed',
      tool: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Please remember this malformed ingest fallback.' }],
      systemPrompt: null,
      stream: false,
      rawHeaders: {},
      rawBody: { model: 'claude-sonnet-4-6', max_tokens: 256 },
      timestamp: new Date('2026-05-02T00:00:00.000Z'),
    }
    const responseBody = Buffer.from(
      JSON.stringify({ content: [{ type: 'text', text: 'Fallback capture response.' }] }),
      'utf8',
    )

    const captureConversation = createCaptureConversation(makeConfig(walletDir, 'v2'), makeStore())
    captureConversation(normalized, responseBody)

    const files = await waitForAtLeastTurnFiles(walletDir, 1)
    expect(files).toHaveLength(1)
    const [content] = await readTurnFiles(walletDir)
    expect(content).toContain('Please remember this malformed ingest fallback.')
    expect(content).toContain('Fallback capture response.')
  })
})
