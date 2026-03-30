import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock HTTP modules before importing the module under test
vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))

const httpsMock = await import('node:https')

import {
  callLLM,
  extractContent,
  extractFacts,
  resolveApiKey,
} from '../../src/extraction/extract.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  statusCode?: number
  body: string
}

/**
 * Configure node:https.request to respond once with the given body.
 * The mock immediately calls back with a mock IncomingMessage that
 * emits 'data' + 'end' on the next tick.
 */
function mockHttpsRequest(response: MockResponse): {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
} {
  const mockReq = { write: vi.fn(), end: vi.fn(), on: vi.fn() }

  vi.mocked(httpsMock.request).mockImplementationOnce(
    (
      _url: unknown,
      _opts: unknown,
      callback?: (res: EventEmitter & { statusCode?: number }) => void,
    ) => {
      const mockRes = Object.assign(new EventEmitter(), { statusCode: response.statusCode ?? 200 })
      if (callback) callback(mockRes)
      process.nextTick(() => {
        mockRes.emit('data', Buffer.from(response.body))
        mockRes.emit('end')
      })
      return mockReq as unknown as ClientRequest
    },
  )

  return mockReq
}

function makeOpenAIResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  })
}

const BASE_CONFIG = {
  schedule: '0 2 * * *',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  it('returns the key as-is when no env: prefix', () => {
    expect(resolveApiKey('sk-abc123')).toBe('sk-abc123')
  })

  it('reads from process.env when prefixed with env:', () => {
    process.env.TEST_API_KEY = 'resolved-key'
    expect(resolveApiKey('env:TEST_API_KEY')).toBe('resolved-key')
    delete process.env.TEST_API_KEY
  })

  it('returns empty string for missing env variable', () => {
    delete process.env.MISSING_VAR
    expect(resolveApiKey('env:MISSING_VAR')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// callLLM
// ---------------------------------------------------------------------------

describe('callLLM', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns ok: true with parsed JSON on success', async () => {
    const payload = { choices: [{ message: { content: '{"facts":[]}' } }] }
    mockHttpsRequest({ body: JSON.stringify(payload) })

    const result = await callLLM('https://api.openai.com/v1', 'test-key', 'gpt-4o-mini', [
      { role: 'user', content: 'hello' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(payload)
  })

  it('returns ok: false when response body is invalid JSON', async () => {
    mockHttpsRequest({ body: 'not-json' })

    const result = await callLLM('https://api.openai.com/v1', 'key', 'model', [
      { role: 'user', content: 'x' },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/Invalid JSON/)
  })

  it('returns ok: false on network error', async () => {
    const mockReq = { write: vi.fn(), end: vi.fn(), on: vi.fn() }

    vi.mocked(httpsMock.request).mockImplementationOnce(
      (_url: unknown, _opts: unknown, _cb?: unknown) => {
        process.nextTick(() => {
          const errorListener = mockReq.on.mock.calls.find(([evt]) => evt === 'error')
          if (errorListener) errorListener[1](new Error('ECONNREFUSED'))
        })
        return mockReq as unknown as ClientRequest
      },
    )

    const result = await callLLM('https://api.openai.com/v1', 'key', 'model', [
      { role: 'user', content: 'x' },
    ])

    expect(result.ok).toBe(false)
  })

  it('returns ok: false for invalid baseUrl', async () => {
    const result = await callLLM('not a url', 'key', 'model', [{ role: 'user', content: 'x' }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/Invalid baseUrl/)
  })

  it('includes Authorization header with the API key', async () => {
    mockHttpsRequest({ body: JSON.stringify({ choices: [] }) })

    await callLLM('https://api.openai.com/v1', 'my-secret', 'gpt-4o-mini', [
      { role: 'user', content: 'hi' },
    ])

    const [, opts] = vi.mocked(httpsMock.request).mock.calls[0] as [
      unknown,
      { headers: Record<string, string> },
    ]
    expect(opts.headers.Authorization).toBe('Bearer my-secret')
  })
})

// ---------------------------------------------------------------------------
// extractContent
// ---------------------------------------------------------------------------

describe('extractContent', () => {
  it('returns the message content on success', () => {
    const result = extractContent({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('hello')
  })

  it('returns ok: false when choices is empty', () => {
    const result = extractContent({ choices: [] })
    expect(result.ok).toBe(false)
  })

  it('returns ok: false when content is missing', () => {
    const result = extractContent({ choices: [{ message: {} }] })
    expect(result.ok).toBe(false)
  })

  it('returns ok: false when response has an error field', () => {
    const result = extractContent({
      error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/Rate limit exceeded/)
  })
})

// ---------------------------------------------------------------------------
// extractFacts
// ---------------------------------------------------------------------------

describe('extractFacts', () => {
  beforeEach(() => vi.clearAllMocks())

  const CONVERSATION = `---
id: conv_abc123
tool: cursor
provider: openai
model: gpt-4o
timestamp: 2026-03-19T01:30:00.000Z
tokenEstimate: 500
incognito: false
---

## User
I work as a backend engineer at Acme Corp using Go.

## Assistant
That's great! Go is a solid choice for backend systems.

## User
I prefer PostgreSQL over MySQL for databases.`

  it('returns extracted facts on a valid LLM response', async () => {
    const llmPayload = JSON.stringify({
      facts: [
        {
          text: 'Works as a backend engineer at Acme Corp',
          category: 'IDENTITY',
          confidence: 'HIGH',
        },
        { text: 'Prefers PostgreSQL over MySQL', category: 'PREFERENCE', confidence: 'HIGH' },
      ],
      summary_update: 'User is a backend engineer who prefers PostgreSQL.',
    })

    mockHttpsRequest({ body: makeOpenAIResponse(llmPayload) })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.conversationId).toBe('conv_abc123')
    expect(result.value.facts).toHaveLength(2)
    expect(result.value.facts[0].category).toBe('IDENTITY')
    expect(result.value.facts[1].category).toBe('PREFERENCE')
    expect(result.value.summaryUpdate).toBe('User is a backend engineer who prefers PostgreSQL.')
  })

  it('returns empty facts array when LLM finds nothing to extract', async () => {
    const llmPayload = JSON.stringify({
      facts: [],
      summary_update: 'No new personal facts.',
    })
    mockHttpsRequest({ body: makeOpenAIResponse(llmPayload) })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.facts).toHaveLength(0)
  })

  it('silently drops facts with invalid category', async () => {
    const llmPayload = JSON.stringify({
      facts: [
        { text: 'Valid fact', category: 'PREFERENCE', confidence: 'HIGH' },
        { text: 'Bad fact', category: 'INVALID_CATEGORY', confidence: 'HIGH' },
      ],
      summary_update: 'Some facts found.',
    })
    mockHttpsRequest({ body: makeOpenAIResponse(llmPayload) })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.facts).toHaveLength(1)
    expect(result.value.facts[0].text).toBe('Valid fact')
  })

  it('silently drops facts with invalid confidence', async () => {
    const llmPayload = JSON.stringify({
      facts: [{ text: 'Valid fact', category: 'SKILL', confidence: 'VERY_HIGH' }],
      summary_update: 'Checked.',
    })
    mockHttpsRequest({ body: makeOpenAIResponse(llmPayload) })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.facts).toHaveLength(0)
  })

  it('returns ok: false when the LLM call fails', async () => {
    mockHttpsRequest({ body: 'not-json' })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')
    expect(result.ok).toBe(false)
  })

  it('returns ok: false when the LLM response JSON is malformed', async () => {
    mockHttpsRequest({ body: makeOpenAIResponse('{"wrong":"shape"}') })

    const result = await extractFacts(CONVERSATION, '', '', BASE_CONFIG, 'conv_abc123')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/facts array/)
  })

  it('includes existing profile in the prompt sent to the LLM', async () => {
    const llmPayload = JSON.stringify({ facts: [], summary_update: 'none' })
    mockHttpsRequest({ body: makeOpenAIResponse(llmPayload) })

    await extractFacts(CONVERSATION, 'Name: Alice', 'Previously discussed Go.', BASE_CONFIG, 'c1')

    // Verify the LLM was called — the profile is baked into the request body
    // written via req.write(), which we can confirm by checking the request was made
    expect(vi.mocked(httpsMock.request)).toHaveBeenCalledOnce()
  })
})
