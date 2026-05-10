import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import type { QMDStore } from '@tobilu/qmd'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WalletConfig } from '../../src/config/schema.ts'

vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))

const httpsMock = await import('node:https')

import { callExtractionLLM } from '../../src/extraction/extract.ts'
import { callLocalLLM } from '../../src/extraction/local-llm.ts'

const BASE_CONFIG: WalletConfig['extraction'] = {
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

function makeStore(generate?: ReturnType<typeof vi.fn>, includeInternal = true): QMDStore {
  return {
    internal: includeInternal
      ? {
          llm: {
            generate: generate ?? vi.fn(),
          },
        }
      : undefined,
    dbPath: '/tmp/test.sqlite',
  } as unknown as QMDStore
}

function mockHttpsRequest(body: string): void {
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
}

function openAIResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

describe('local extraction LLM routing', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.T03_TEST_KEY
  })

  it('callLocalLLM returns ok with model output', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'hello world', model: 'test', done: true })
    const result = await callLocalLLM(makeStore(generate), [{ role: 'user', content: 'hello' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.choices?.[0]?.message?.content).toBe('hello world')
  })

  it('callLocalLLM returns err when QMD llm handle is undefined', async () => {
    const result = await callLocalLLM(makeStore(undefined, false), [
      { role: 'user', content: 'hello' },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('callLocalLLM: QMD internal LLM unavailable')
  })

  it('callLocalLLM returns err when llm.generate returns null', async () => {
    const generate = vi.fn().mockResolvedValue(null)
    const result = await callLocalLLM(makeStore(generate), [{ role: 'user', content: 'hello' }])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('callLocalLLM: local LLM returned null')
  })

  it('callLocalLLM passes maxTokens and temperature options', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'ok', model: 'test', done: true })
    await callLocalLLM(makeStore(generate), [{ role: 'user', content: 'hello' }])

    expect(generate).toHaveBeenCalledWith(expect.any(String), { maxTokens: 1024, temperature: 0 })
  })

  it('callLocalLLM concatenates messages with role markers', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'ok', model: 'test', done: true })
    await callLocalLLM(makeStore(generate), [
      { role: 'system', content: 'You extract facts.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ])

    const [prompt] = generate.mock.calls[0] as [string]
    const systemIndex = prompt.indexOf('System:')
    const firstUserIndex = prompt.indexOf('User:')
    const assistantIndex = prompt.indexOf('Assistant:')
    const secondUserIndex = prompt.indexOf('User:', firstUserIndex + 1)

    expect(systemIndex).toBeGreaterThanOrEqual(0)
    expect(firstUserIndex).toBeGreaterThan(systemIndex)
    expect(assistantIndex).toBeGreaterThan(firstUserIndex)
    expect(secondUserIndex).toBeGreaterThan(assistantIndex)
  })

  it('callExtractionLLM routes to external when apiKey is non-empty', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'local', model: 'test', done: true })
    mockHttpsRequest(openAIResponse('external'))

    const result = await callExtractionLLM(makeStore(generate), BASE_CONFIG, [
      { role: 'user', content: 'hello' },
    ])

    expect(result.ok).toBe(true)
    expect(generate).not.toHaveBeenCalled()
    expect(vi.mocked(httpsMock.request)).toHaveBeenCalledOnce()
  })

  it('callExtractionLLM routes to local when apiKey is empty', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'local', model: 'test', done: true })

    const result = await callExtractionLLM(makeStore(generate), { ...BASE_CONFIG, apiKey: '' }, [
      { role: 'user', content: 'hello' },
    ])

    expect(result.ok).toBe(true)
    expect(generate).toHaveBeenCalledOnce()
    expect(vi.mocked(httpsMock.request)).not.toHaveBeenCalled()
  })

  it('callExtractionLLM resolves env: prefix and routes accordingly', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'local', model: 'test', done: true })
    const config = { ...BASE_CONFIG, apiKey: 'env:T03_TEST_KEY' }

    await callExtractionLLM(makeStore(generate), config, [{ role: 'user', content: 'hello' }])
    expect(generate).toHaveBeenCalledOnce()
    expect(vi.mocked(httpsMock.request)).not.toHaveBeenCalled()

    process.env.T03_TEST_KEY = 'real'
    mockHttpsRequest(openAIResponse('external'))
    await callExtractionLLM(makeStore(generate), config, [{ role: 'user', content: 'hello' }])

    expect(generate).toHaveBeenCalledOnce()
    expect(vi.mocked(httpsMock.request)).toHaveBeenCalledOnce()
  })
})
