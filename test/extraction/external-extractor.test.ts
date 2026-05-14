import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))

const httpsMock = await import('node:https')

import { ExternalLLMExtractor } from '../../src/extraction/external-extractor.ts'

function mockHttpsRequest(body: string): {
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
      const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 })
      if (callback) callback(mockRes)
      process.nextTick(() => {
        mockRes.emit('data', Buffer.from(body))
        mockRes.emit('end')
      })
      return mockReq as unknown as ClientRequest
    },
  )

  return mockReq
}

function openAIResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

describe('ExternalLLMExtractor', () => {
  afterEach(() => vi.clearAllMocks())

  it('makes the expected OpenAI-compatible request', async () => {
    const mockReq = mockHttpsRequest(openAIResponse('{"facts":[]}'))
    const extractor = new ExternalLLMExtractor({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    })

    const result = await extractor.extract([{ role: 'user', content: 'hello' }])

    expect(result.ok).toBe(true)
    expect(vi.mocked(httpsMock.request)).toHaveBeenCalledOnce()
    const [url, opts] = vi.mocked(httpsMock.request).mock.calls[0] as [
      URL,
      { method: string; headers: Record<string, string> },
    ]
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer test-key')

    const [body] = mockReq.write.mock.calls[0] as [string]
    expect(JSON.parse(body)).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0,
    })
  })

  it('parses the response into OpenAI response shape', async () => {
    mockHttpsRequest(openAIResponse('profile text'))
    const extractor = new ExternalLLMExtractor({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    })

    const result = await extractor.extract([{ role: 'user', content: 'hello' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.choices?.[0]?.message?.content).toBe('profile text')
  })
})
