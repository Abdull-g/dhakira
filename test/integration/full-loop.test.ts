// End-to-end integration test: request → injection → upstream → response → capture
//
// Wires up the same ProxyDeps logic as src/index.ts, but with:
//   - A local mock upstream HTTP server (fake OpenAI)
//   - A minimal mock QMD store returning a known fake memory
//   - A temp directory for conversation file capture

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QMDStore, SearchResult as QMDSearchResult } from '@tobilu/qmd'

import type { WalletConfig } from '../../src/config/schema.ts'
import { createProxyServer } from '../../src/proxy/server.ts'
import type { ProxyDeps } from '../../src/proxy/server.ts'
import { buildInjectionBlock } from '../../src/injection/builder.ts'
import { injectIntoSystemPrompt } from '../../src/injection/injector.ts'
import { searchTurns } from '../../src/retrieval/search.ts'
import { writeConversation } from '../../src/capture/writer.ts'
import { estimateMessagesTokens } from '../../src/utils/tokens.ts'
import { generateId } from '../../src/utils/ids.ts'
import type { CapturedConversation } from '../../src/capture/types.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WalletConfig that routes all traffic to a local mock server */
function makeConfig(upstreamPort: number, walletDir: string): WalletConfig {
  return {
    walletDir,
    proxy: { port: 0, host: '127.0.0.1' },
    dashboard: { port: 0, host: '127.0.0.1' },
    tools: [
      {
        name: 'cursor',
        provider: 'openai',
        apiKey: 'sk-test-key',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
      },
    ],
    extraction: {
      schedule: '0 2 * * *',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
    },
    injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
    incognito: false,
  }
}

/**
 * Minimal QMD store mock for searchTurns.
 * store.search() is left undefined so it throws and searchTurns falls back to searchLex.
 */
function makeMockStore(results: QMDSearchResult[]): QMDStore {
  return {
    searchLex: async () => results,
  } as unknown as QMDStore
}

/**
 * Build a QMDSearchResult whose body is a valid turn pair markdown document.
 * searchTurns parses this body to reconstruct TurnPair objects.
 */
function makeTurnPairResult(
  userContent: string,
  assistantContent: string,
  score = 0.9,
): QMDSearchResult {
  const body = [
    '---',
    'id: turn_test_001',
    'sessionId: sess_test_001',
    'tool: cursor',
    'timestamp: 2026-03-20T10:00:00Z',
    'turnIndex: 0',
    '---',
    '',
    '## User',
    userContent,
    '',
    '## Assistant',
    assistantContent,
  ].join('\n')
  return {
    filepath: '/wallet/turns/2026-03-20/sess_test_001-0.md',
    displayPath: 'qmd://turns/2026-03-20/sess_test_001-0.md',
    title: 'Turn',
    body,
    context: '',
    hash: 'abc123',
    docid: 'abc123',
    collectionName: 'turns',
    modifiedAt: '2026-03-20T00:00:00Z',
    bodyLength: body.length,
    score,
    source: 'fts',
  }
}

/** Wrap server.listen in a Promise */
function listenAsync(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Wrap server.close in a Promise, ignoring errors if already closed */
function closeAsync(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('full-loop integration', () => {
  let upstream: Server
  let proxy: Server
  let walletDir: string
  let proxyPort: number

  // Resolved when the mock upstream receives and processes the forwarded request
  let upstreamBodyPromise: Promise<Record<string, unknown>>
  // Resolved when writeConversation finishes writing to disk
  let captureCompletePromise: Promise<void>

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-test-'))

    // --- Mock upstream: fake OpenAI that captures request body ---
    let resolveUpstreamBody!: (body: Record<string, unknown>) => void
    upstreamBodyPromise = new Promise<Record<string, unknown>>((res) => {
      resolveUpstreamBody = res
    })

    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        resolveUpstreamBody(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Hello from mock!' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }),
        )
      })
    })
    const upstreamPort = await listenAsync(upstream)

    // --- ProxyDeps: same hook logic as src/index.ts ---
    const config = makeConfig(upstreamPort, walletDir)
    const store = makeMockStore([
      makeTurnPairResult(
        'What is your preferred language?',
        'I prefer TypeScript over JavaScript for its static typing and tooling.',
      ),
    ])

    let resolveCaptureComplete!: () => void
    captureCompletePromise = new Promise<void>((res) => {
      resolveCaptureComplete = res
    })

    const deps: ProxyDeps = {
      injectMemories: async (normalized) => {
        const lastUserMessage =
          [...normalized.messages]
            .reverse()
            .find((m) => m.role === 'user')
            ?.content ?? ''

        if (!lastUserMessage) return null

        const searchResult = await searchTurns(store, {
          query: lastUserMessage,
          limit: config.injection.maxTurns,
          minScore: config.injection.minRelevanceScore,
          recencyBoost: config.injection.recencyBoost,
        })
        const turns = searchResult.ok ? searchResult.value : []

        const injectionBlock = buildInjectionBlock('', turns, config.injection)
        if (!injectionBlock.text) return null

        return injectIntoSystemPrompt(normalized.systemPrompt, injectionBlock)
      },

      captureConversation: (normalized) => {
        const messages =
          normalized.systemPrompt !== null
            ? [
                { role: 'system' as const, content: normalized.systemPrompt },
                ...normalized.messages,
              ]
            : normalized.messages

        const conversation: CapturedConversation = {
          id: generateId('conv'),
          tool: normalized.tool,
          provider: normalized.provider,
          model: normalized.model,
          messages,
          timestamp: normalized.timestamp,
          tokenEstimate: estimateMessagesTokens(messages),
          incognito: config.incognito,
        }

        writeConversation(conversation, config.walletDir)
          .then(() => resolveCaptureComplete())
          .catch(() => resolveCaptureComplete())
      },
    }

    proxy = createProxyServer(config, deps)
    proxyPort = await listenAsync(proxy)
  })

  afterEach(async () => {
    await closeAsync(proxy)
    await closeAsync(upstream)
    await rm(walletDir, { recursive: true, force: true })
  })

  it('should inject memories into system prompt when forwarding to upstream', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What are my coding preferences?' },
        ],
      }),
    })

    expect(response.status).toBe(200)

    // The forwarded body must have the injection prepended to the system message
    const upstreamBody = await upstreamBodyPromise
    const messages = upstreamBody['messages'] as Array<{ role: string; content: string }>

    expect(messages[0]?.role).toBe('system')
    // Injection block wraps content in <dhakira_context>
    expect(messages[0]?.content).toContain('<dhakira_context>')
    // Original system prompt is preserved after the injection block
    expect(messages[0]?.content).toContain('You are a helpful assistant.')
    // The fake turn pair content appears in the injection
    expect(messages[0]?.content).toContain('TypeScript')
  })

  it('should capture the conversation to disk after response completes', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    })

    // Wait for the async file write to complete
    await captureCompletePromise

    // A dated subdirectory should exist inside conversations/
    const conversationsDir = join(walletDir, 'conversations')
    const dateDirs = await readdir(conversationsDir)
    expect(dateDirs.length).toBe(1)

    // The date dir should contain exactly one conversation file
    const dateDir = dateDirs[0]
    if (dateDir === undefined) throw new Error('Expected a date directory')
    const files = await readdir(join(conversationsDir, dateDir))
    expect(files.length).toBe(1)

    // File should match the expected naming pattern: cursor-HHhMMm-<shortid>.md
    expect(files[0]).toMatch(/^cursor-\d+h\d+m-\w+\.md$/)
  })

  it('should not inject or capture when incognito is true', async () => {
    await closeAsync(proxy)

    // Rebuild proxy with incognito config
    let resolveUpstreamBodyIncognito!: (body: Record<string, unknown>) => void
    const upstreamBodyIncognito = new Promise<Record<string, unknown>>((res) => {
      resolveUpstreamBodyIncognito = res
    })

    // Replace upstream handler to resolve the incognito promise
    const incognitoUpstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        resolveUpstreamBodyIncognito(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      })
    })
    const incognitoUpstreamPort = await listenAsync(incognitoUpstream)

    const injectSpy = { called: false }
    const incognitoConfig: WalletConfig = {
      ...makeConfig(incognitoUpstreamPort, walletDir),
      incognito: true,
    }
    const incognitoDeps: ProxyDeps = {
      injectMemories: async () => {
        injectSpy.called = true
        return null
      },
      captureConversation: () => {
        injectSpy.called = true
      },
    }

    const incognitoProxy = createProxyServer(incognitoConfig, incognitoDeps)
    const incognitoProxyPort = await listenAsync(incognitoProxy)

    await fetch(`http://127.0.0.1:${incognitoProxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    const incognitoBody = await upstreamBodyIncognito
    const incognitoMessages = incognitoBody['messages'] as Array<{ role: string; content: string }>

    // No injection: messages should not contain <dhakira_context>
    expect(JSON.stringify(incognitoMessages)).not.toContain('<dhakira_context>')
    // Neither hook was called
    expect(injectSpy.called).toBe(false)

    await closeAsync(incognitoProxy)
    await closeAsync(incognitoUpstream)
  })
})
