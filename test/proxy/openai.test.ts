import { describe, expect, it } from 'vitest'
import { buildOpenAIBody, parseOpenAIRequest } from '../../src/proxy/openai.ts'

const HEADERS = { authorization: 'Bearer sk-test', 'content-type': 'application/json' }

describe('parseOpenAIRequest', () => {
  it('should parse a basic chat request', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello!' },
      ],
      stream: true,
    }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.provider).toBe('openai')
    expect(result.value.tool).toBe('cursor')
    expect(result.value.model).toBe('gpt-4o')
    expect(result.value.stream).toBe(true)
    expect(result.value.systemPrompt).toBe('You are helpful.')
    expect(result.value.messages).toHaveLength(1)
    expect(result.value.messages[0]).toEqual({ role: 'user', content: 'Hello!' })
  })

  it('should concatenate multiple system messages', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Part one.' },
        { role: 'user', content: 'Hi' },
        { role: 'system', content: 'Part two.' },
      ],
    }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.systemPrompt).toBe('Part one.\nPart two.')
  })

  it('should handle requests with no system message', () => {
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.systemPrompt).toBeNull()
  })

  it('should extract text from array content parts', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.messages[0]?.content).toBe('Hello world')
  })

  it('should default stream to false when not provided', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.stream).toBe(false)
  })

  it('should skip tool and function messages', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Call a function' },
        { role: 'tool', content: 'result', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'Done' },
      ],
    }
    const result = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.messages).toHaveLength(2)
    expect(result.value.messages.every((m) => m.role !== 'tool')).toBe(true)
  })

  it('should return error for invalid body', () => {
    expect(parseOpenAIRequest(null, HEADERS, 'cursor').ok).toBe(false)
    expect(parseOpenAIRequest({ model: 'gpt-4o' }, HEADERS, 'cursor').ok).toBe(false)
    expect(parseOpenAIRequest({ messages: [] }, HEADERS, 'cursor').ok).toBe(false)
  })

  it('should generate a unique id for each request', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }
    const r1 = parseOpenAIRequest(body, HEADERS, 'cursor')
    const r2 = parseOpenAIRequest(body, HEADERS, 'cursor')
    expect(r1.ok && r2.ok && r1.value.id !== r2.value.id).toBe(true)
  })
})

describe('buildOpenAIBody', () => {
  it('should inject a new system prompt at the front of messages', () => {
    const rawBody = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Original system.' },
        { role: 'user', content: 'Hi' },
      ],
    }
    const rebuilt = buildOpenAIBody(rawBody, 'Injected system.')
    const msgs = rebuilt.messages as Array<{ role: string; content: string }>
    expect(msgs[0]).toEqual({ role: 'system', content: 'Injected system.' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'Hi' })
    expect(msgs).toHaveLength(2)
  })

  it('should remove system messages when systemPrompt is null', () => {
    const rawBody = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Old system.' },
        { role: 'user', content: 'Hi' },
      ],
    }
    const rebuilt = buildOpenAIBody(rawBody, null)
    const msgs = rebuilt.messages as Array<{ role: string }>
    expect(msgs.every((m) => m.role !== 'system')).toBe(true)
    expect(msgs).toHaveLength(1)
  })

  it('should preserve all original body fields', () => {
    const rawBody = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true,
    }
    const rebuilt = buildOpenAIBody(rawBody, null)
    expect(rebuilt.temperature).toBe(0.7)
    expect(rebuilt.max_tokens).toBe(1000)
    expect(rebuilt.stream).toBe(true)
  })
})
