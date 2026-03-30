import { describe, expect, it } from 'vitest'
import { buildAnthropicBody, parseAnthropicRequest } from '../../src/proxy/anthropic.ts'

const HEADERS = { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' }

describe('parseAnthropicRequest', () => {
  it('should parse a basic messages request', () => {
    const body = {
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello!' }],
    }
    const result = parseAnthropicRequest(body, HEADERS, 'claude-code')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.provider).toBe('anthropic')
    expect(result.value.tool).toBe('claude-code')
    expect(result.value.model).toBe('claude-opus-4-5')
    expect(result.value.systemPrompt).toBe('You are helpful.')
    expect(result.value.messages).toHaveLength(1)
    expect(result.value.messages[0]).toEqual({ role: 'user', content: 'Hello!' })
  })

  it('should set systemPrompt to null when system field is absent', () => {
    const body = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = parseAnthropicRequest(body, HEADERS, 'claude-code')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.systemPrompt).toBeNull()
  })

  it('should extract text from content block arrays', () => {
    const body = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
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
    const result = parseAnthropicRequest(body, HEADERS, 'claude-code')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.messages[0]?.content).toBe('Hello world')
  })

  it('should handle a conversation with multiple turns', () => {
    const body = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First reply' },
        { role: 'user', content: 'Second message' },
      ],
    }
    const result = parseAnthropicRequest(body, HEADERS, 'claude-code')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.messages).toHaveLength(3)
  })

  it('should default stream to false when not provided', () => {
    const body = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = parseAnthropicRequest(body, HEADERS, 'claude-code')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.stream).toBe(false)
  })

  it('should return error for missing max_tokens', () => {
    const body = {
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }
    expect(parseAnthropicRequest(body, HEADERS, 'claude-code').ok).toBe(false)
  })

  it('should return error for missing model', () => {
    const body = {
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    }
    expect(parseAnthropicRequest(body, HEADERS, 'claude-code').ok).toBe(false)
  })

  it('should return error for null body', () => {
    expect(parseAnthropicRequest(null, HEADERS, 'claude-code').ok).toBe(false)
  })
})

describe('buildAnthropicBody', () => {
  it('should inject a new system prompt into the body', () => {
    const rawBody = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: 'Original.',
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const rebuilt = buildAnthropicBody(rawBody, 'Injected.')
    expect(rebuilt.system).toBe('Injected.\n\nOriginal.')
    expect(rebuilt.model).toBe('claude-opus-4-5')
  })

  it('should remove the system field when systemPrompt is null', () => {
    const rawBody = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: 'Original.',
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const rebuilt = buildAnthropicBody(rawBody, null)
    expect('system' in rebuilt).toBe(false)
  })

  it('should add system field when there was none and prompt is provided', () => {
    const rawBody = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const rebuilt = buildAnthropicBody(rawBody, 'New system.')
    expect(rebuilt.system).toBe('New system.')
  })

  it('should preserve all original body fields', () => {
    const rawBody = {
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      temperature: 0.5,
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const rebuilt = buildAnthropicBody(rawBody, null)
    expect(rebuilt.max_tokens).toBe(2048)
    expect(rebuilt.temperature).toBe(0.5)
  })
})
