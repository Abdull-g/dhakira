import { describe, expect, it } from 'vitest'

import { formatConversation } from '../../src/capture/formatter.ts'
import type { CapturedConversation } from '../../src/capture/types.ts'
import { buildMemoryContent } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'

const TIMESTAMP = new Date('2026-03-20T01:30:00.000Z')

function conversation(overrides: Partial<CapturedConversation> = {}): CapturedConversation {
  return {
    id: 'conv_abc123',
    tool: 'cursor',
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
    timestamp: TIMESTAMP,
    tokenEstimate: 42,
    incognito: false,
    projectId: 'global',
    ...overrides,
  }
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    text: 'Senior backend engineer based in Riyadh',
    category: 'IDENTITY',
    confidence: 'HIGH',
    salienceScore: 0.92,
    salienceTier: 'standard',
    source: 'conv_1',
    projectId: 'global',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Conversation frontmatter — the capture end of the thread
// ───────────────────────────────────────────────────────────────────────────
describe('conversation projectId frontmatter (capture)', () => {
  it('a non-global projectId is emitted after incognito, before the closing fence', () => {
    const content = formatConversation(conversation({ projectId: 'git:github.com/owner/repo' }))
    expect(content).toMatch(/^projectId: git:github\.com\/owner\/repo$/m)
    // It sits inside the frontmatter (before the body).
    expect(content).toMatch(/incognito: false\nprojectId: git:github\.com\/owner\/repo\n---/)
  })

  it('a "global" projectId emits NO projectId line, byte-identical to pre-T08', () => {
    const withGlobal = formatConversation(conversation({ projectId: 'global' }))
    expect(withGlobal).not.toMatch(/projectId/)

    const preT08 = [
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
      'Hello!',
    ].join('\n')
    expect(withGlobal).toBe(preT08)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Memory frontmatter — the storage end of the thread
// ───────────────────────────────────────────────────────────────────────────
describe('memory projectId frontmatter (storage)', () => {
  it('a non-global projectId is emitted on the memory record', () => {
    const content = buildMemoryContent(record({ projectId: 'explicit:payments' }))
    expect(content).toMatch(/^projectId: explicit:payments$/m)
  })

  it('a "global" memory emits NO projectId line, byte-identical to pre-T08', () => {
    const content = buildMemoryContent(record({ projectId: 'global' }))
    expect(content).not.toMatch(/projectId/)

    const preT08 = [
      '---',
      'id: mem_1',
      'category: IDENTITY',
      'confidence: HIGH',
      'salienceScore: 0.92',
      'salienceTier: standard',
      'source: conv_1',
      'createdAt: 2026-01-01T00:00:00.000Z',
      'validFrom: 2026-01-01T00:00:00.000Z',
      'invalidatedAt: null',
      'expiresAt: null',
      '---',
      '',
      'Senior backend engineer based in Riyadh',
    ].join('\n')
    expect(content).toBe(preT08)
  })

  it('projectId coexists with the consolidated/forgottenAt conditional lines', () => {
    const content = buildMemoryContent(
      record({
        projectId: 'git:github.com/o/r',
        consolidated: true,
        forgottenAt: new Date('2026-06-03T12:00:00.000Z'),
      }),
    )
    // projectId precedes consolidated, which precedes forgottenAt (stable order).
    expect(content).toMatch(
      /projectId: git:github\.com\/o\/r\nconsolidated: true\nforgottenAt: 2026-06-03T12:00:00\.000Z/,
    )
  })
})
