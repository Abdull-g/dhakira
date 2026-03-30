import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { detectFormat, isRecord } from '../../src/proxy/detect.ts'

function makeReq(
  url: string,
  headers: Record<string, string> = {},
): Pick<IncomingMessage, 'url' | 'headers'> {
  return { url, headers }
}

describe('isRecord', () => {
  it('should return true for plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('should return false for arrays, null, and primitives', () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('string')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('detectFormat', () => {
  describe('URL-based detection', () => {
    it('should detect anthropic from /v1/messages path', () => {
      const req = makeReq('/v1/messages')
      expect(detectFormat(req as IncomingMessage, {})).toBe('anthropic')
    })

    it('should detect openai from /v1/chat/completions path', () => {
      const req = makeReq('/v1/chat/completions')
      expect(detectFormat(req as IncomingMessage, {})).toBe('openai')
    })

    it('should detect openai from /v1/completions path', () => {
      const req = makeReq('/v1/completions')
      expect(detectFormat(req as IncomingMessage, {})).toBe('openai')
    })
  })

  describe('header-based detection', () => {
    it('should detect anthropic from anthropic-version header', () => {
      const req = makeReq('/unknown', { 'anthropic-version': '2023-06-01' })
      expect(detectFormat(req as IncomingMessage, {})).toBe('anthropic')
    })
  })

  describe('body-based fallback detection', () => {
    it('should detect anthropic from x-api-key header + messages body', () => {
      const req = makeReq('/custom', { 'x-api-key': 'sk-ant-xxx' })
      const body = { messages: [] }
      expect(detectFormat(req as IncomingMessage, body)).toBe('anthropic')
    })

    it('should detect openai from Authorization header + messages body', () => {
      const req = makeReq('/custom', { authorization: 'Bearer sk-xxx' })
      const body = { messages: [] }
      expect(detectFormat(req as IncomingMessage, body)).toBe('openai')
    })
  })

  describe('unknown format', () => {
    it('should return unknown for unrecognized paths with no hints', () => {
      const req = makeReq('/health')
      expect(detectFormat(req as IncomingMessage, null)).toBe('unknown')
    })

    it('should return unknown when body has no messages field', () => {
      const req = makeReq('/custom', { authorization: 'Bearer sk-xxx' })
      const body = { model: 'gpt-4o' }
      expect(detectFormat(req as IncomingMessage, body)).toBe('unknown')
    })
  })
})
