import type { QMDStore } from '@tobilu/qmd'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WalletConfig } from '../../src/config/schema.ts'
import { createCaptureConversation } from '../../src/index.ts'
import { parseOpenAIRequest } from '../../src/proxy/openai.ts'
import type { NormalizedRequest } from '../../src/proxy/types.ts'

interface IndexedContent {
  hash: string
  content: string
}

interface IndexedDocument {
  collection: string
  path: string
  title: string
  hash: string
}

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
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
    },
    injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
    incognito: false,
  }
}

function makeStore(indexedContents: IndexedContent[], indexedDocuments: IndexedDocument[]): QMDStore {
  return {
    internal: {
      findActiveDocument: () => null,
      insertContent: (hash: string, content: string) => {
        indexedContents.push({ hash, content })
      },
      insertDocument: (collection: string, path: string, title: string, hash: string) => {
        indexedDocuments.push({ collection, path, title, hash })
      },
    },
  } as unknown as QMDStore
}

function normalizeOpenAI(body: unknown): NormalizedRequest {
  const parsed = parseOpenAIRequest(body, {}, 'aider')
  if (!parsed.ok) throw parsed.error
  return { ...parsed.value, timestamp: new Date('2026-05-07T00:00:00.000Z') }
}

function sse(events: unknown[]): Buffer {
  return Buffer.from(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n')}\ndata: [DONE]\n`,
    'utf8',
  )
}

async function listTurnFiles(walletDir: string): Promise<string[]> {
  try {
    const entries = (await readdir(join(walletDir, 'turns'), { recursive: true })) as string[]
    return entries.filter((entry) => entry.endsWith('.md')).sort()
  } catch {
    return []
  }
}

async function waitForTurnFiles(walletDir: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2000
  let files: string[] = []
  while (Date.now() < deadline) {
    files = await listTurnFiles(walletDir)
    if (files.length >= count) return files
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return files
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

describe('OpenAI v2 capture pipeline live wiring', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-openai-v2-wired-'))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('runs the full v2 pipeline and indexes a synthesized OpenAI SSE turn', async () => {
    const requestBody = {
      model: 'gpt-4.1',
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            'I am working with you on code in a git repository.\nHere are summaries of some files present in my git repo.',
        },
        {
          role: 'user',
          content:
            'Please explain the capture flow.\n<source>\nsrc/capture/ingest.ts\n</source>',
        },
      ],
    }
    const responseBody = sse([
      {
        choices: [
          {
            delta: {
              content:
                'The capture flow adapts provider traffic into trace messages before writing turn pairs.',
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const indexedContents: IndexedContent[] = []
    const indexedDocuments: IndexedDocument[] = []

    const captureConversation = createCaptureConversation(
      makeConfig(walletDir),
      makeStore(indexedContents, indexedDocuments),
    )
    captureConversation(normalizeOpenAI(requestBody), responseBody)

    const files = await waitForTurnFiles(walletDir, 1)
    expect(files).toHaveLength(1)

    const content = await readFile(join(walletDir, 'turns', files[0] ?? ''), 'utf8')
    expect(section(content, 'User')).toContain('Please explain the capture flow.')
    expect(section(content, 'Assistant')).toContain(
      'The capture flow adapts provider traffic into trace messages',
    )
    expect(indexedContents).toHaveLength(1)
    expect(indexedContents[0]?.content).toBe(content)
    expect(indexedDocuments).toHaveLength(1)
    expect(indexedDocuments[0]?.collection).toBe('turns')
  })
})
