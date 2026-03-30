import { describe, expect, it } from 'vitest'
import { formatConversation } from '../../src/capture/formatter.ts'
import type { CapturedConversation } from '../../src/capture/types.ts'

const TIMESTAMP = new Date('2026-03-20T01:30:00.000Z')

function makeConversation(overrides: Partial<CapturedConversation> = {}): CapturedConversation {
  return {
    id: 'conv_abc123',
    tool: 'cursor',
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
    timestamp: TIMESTAMP,
    tokenEstimate: 42,
    incognito: false,
    ...overrides,
  }
}

describe('formatConversation', () => {
  describe('YAML frontmatter', () => {
    it('should open and close with --- delimiters', () => {
      const result = formatConversation(makeConversation())
      const lines = result.split('\n')
      expect(lines[0]).toBe('---')
      // Find closing ---
      const closingIndex = lines.indexOf('---', 1)
      expect(closingIndex).toBeGreaterThan(1)
    })

    it('should include all required frontmatter fields', () => {
      const result = formatConversation(makeConversation())
      expect(result).toContain('id: conv_abc123')
      expect(result).toContain('tool: cursor')
      expect(result).toContain('provider: openai')
      expect(result).toContain('model: gpt-4o')
      expect(result).toContain(`timestamp: ${TIMESTAMP.toISOString()}`)
      expect(result).toContain('tokenEstimate: 42')
      expect(result).toContain('incognito: false')
    })

    it('should set incognito: true when conversation is incognito', () => {
      const result = formatConversation(makeConversation({ incognito: true }))
      expect(result).toContain('incognito: true')
    })
  })

  describe('message body', () => {
    it('should format a user message under ## User heading', () => {
      const result = formatConversation(
        makeConversation({ messages: [{ role: 'user', content: 'What is TypeScript?' }] }),
      )
      expect(result).toContain('## User\nWhat is TypeScript?')
    })

    it('should format an assistant message under ## Assistant heading', () => {
      const result = formatConversation(
        makeConversation({
          messages: [{ role: 'assistant', content: 'TypeScript is a typed superset of JS.' }],
        }),
      )
      expect(result).toContain('## Assistant\nTypeScript is a typed superset of JS.')
    })

    it('should format a system message under ## System heading', () => {
      const result = formatConversation(
        makeConversation({ messages: [{ role: 'system', content: 'You are helpful.' }] }),
      )
      expect(result).toContain('## System\nYou are helpful.')
    })

    it('should separate multiple messages with a blank line', () => {
      const result = formatConversation(
        makeConversation({
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
          ],
        }),
      )
      expect(result).toContain('## User\nHi\n\n## Assistant\nHello!')
    })

    it('should include a full conversation with system, user, and assistant', () => {
      const result = formatConversation(
        makeConversation({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Who are you?' },
            { role: 'assistant', content: 'I am an AI assistant.' },
          ],
        }),
      )
      expect(result).toContain('## System\nBe concise.')
      expect(result).toContain('## User\nWho are you?')
      expect(result).toContain('## Assistant\nI am an AI assistant.')
    })

    it('should place a blank line between frontmatter and body', () => {
      const result = formatConversation(makeConversation())
      // Frontmatter ends with ---; body starts after a blank line
      expect(result).toContain('---\n\n##')
    })

    it('should handle multi-line message content', () => {
      const multiLine = 'Line one.\nLine two.\nLine three.'
      const result = formatConversation(
        makeConversation({ messages: [{ role: 'user', content: multiLine }] }),
      )
      expect(result).toContain(`## User\n${multiLine}`)
    })

    it('should produce an empty body section for empty messages array', () => {
      const result = formatConversation(makeConversation({ messages: [] }))
      // Frontmatter should still be present; body is just empty
      expect(result).toContain('id: conv_abc123')
      expect(result).not.toContain('## User')
    })
  })

  describe('overall structure', () => {
    it('should match the expected CLAUDE.md format', () => {
      const result = formatConversation(
        makeConversation({
          messages: [
            { role: 'user', content: 'How do I implement auth in Next.js?' },
            { role: 'assistant', content: "Here's how you can implement authentication..." },
          ],
        }),
      )

      const expected = [
        '---',
        'id: conv_abc123',
        'tool: cursor',
        'provider: openai',
        'model: gpt-4o',
        `timestamp: ${TIMESTAMP.toISOString()}`,
        'tokenEstimate: 42',
        'incognito: false',
        '---',
        '',
        '## User',
        'How do I implement auth in Next.js?',
        '',
        '## Assistant',
        "Here's how you can implement authentication...",
      ].join('\n')

      expect(result).toBe(expected)
    })
  })
})
