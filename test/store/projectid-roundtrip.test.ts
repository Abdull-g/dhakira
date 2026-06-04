import { describe, expect, it } from 'vitest'

import { extractTurnPairs, formatTurnPair, type TurnPair } from '../../src/capture/turns.ts'
import { parseTurnPairFromBody } from '../../src/retrieval/loader.ts'

function pair(overrides: Partial<TurnPair> = {}): TurnPair {
  return {
    id: 'turn_proj_001',
    userContent: 'How do I run the tests?',
    assistantContent: 'Use npx vitest run.',
    timestamp: '2026-06-04T00:00:00.000Z',
    tool: 'claude-code',
    sessionId: 'conv_proj',
    turnIndex: 0,
    contextFingerprint: 'default',
    projectId: 'global',
    ...overrides,
  }
}

describe('projectId frontmatter write/read round-trip', () => {
  it('a non-global projectId survives formatTurnPair → parseTurnPairFromBody', () => {
    const content = formatTurnPair(pair({ projectId: 'git:github.com/owner/repo' }))
    expect(content).toMatch(/^projectId: git:github\.com\/owner\/repo$/m)
    const parsed = parseTurnPairFromBody(content)
    expect(parsed?.projectId).toBe('git:github.com/owner/repo')
  })

  it('a "global" projectId emits NO projectId line (byte-identical to pre-T07 format)', () => {
    const content = formatTurnPair(pair({ projectId: 'global' }))
    expect(content).not.toMatch(/projectId/)
    // And the reader still recovers "global" for that absent line.
    expect(parseTurnPairFromBody(content)?.projectId).toBe('global')
  })

  it('global vs the pre-T07 rendering are identical (no drift on untouched turns)', () => {
    const withGlobal = formatTurnPair(pair({ projectId: 'global' }))
    // Reconstruct the exact pre-T07 frontmatter (no projectId field at all).
    const preT07 = [
      '---',
      'id: turn_proj_001',
      'sessionId: conv_proj',
      'tool: claude-code',
      'timestamp: 2026-06-04T00:00:00.000Z',
      'turnIndex: 0',
      'contextFingerprint: default',
      '---',
      '',
      '## User\nHow do I run the tests?',
      '',
      '## Assistant\nUse npx vitest run.',
      '',
    ].join('\n')
    expect(withGlobal).toBe(preT07)
  })
})

describe('parseTurnPairFromBody — backward-compatible projectId read', () => {
  it('OLD turn file with NO projectId line → "global" (never breaks)', () => {
    const old = [
      '---',
      'id: turn_old',
      'sessionId: conv_old',
      'tool: claude-code',
      'timestamp: 2026-05-01T00:00:00.000Z',
      'turnIndex: 0',
      'contextFingerprint: abc123',
      '---',
      '',
      '## User\nhi',
      '',
      '## Assistant\nhello',
    ].join('\n')
    expect(parseTurnPairFromBody(old)?.projectId).toBe('global')
  })

  it('explicit projectId line is read verbatim', () => {
    const content = [
      '---',
      'id: turn_x',
      'sessionId: conv_x',
      'tool: codex',
      'timestamp: 2026-06-04T00:00:00.000Z',
      'turnIndex: 0',
      'contextFingerprint: default',
      'projectId: explicit:payments',
      '---',
      '',
      '## User\nq',
      '',
      '## Assistant\na',
    ].join('\n')
    expect(parseTurnPairFromBody(content)?.projectId).toBe('explicit:payments')
  })
})

describe('extractTurnPairs — stamps projectId onto every pair', () => {
  const messages = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
    { role: 'user' as const, content: 'second question' },
    { role: 'assistant' as const, content: 'second answer' },
  ]

  it('threads the supplied projectId through', () => {
    const pairs = extractTurnPairs(
      messages,
      'claude-code',
      'sess',
      new Date('2026-06-04T00:00:00.000Z'),
      'fp123',
      'git:github.com/owner/repo',
    )
    expect(pairs.length).toBe(2)
    for (const p of pairs) expect(p.projectId).toBe('git:github.com/owner/repo')
  })

  it('defaults to "global" when no projectId is given', () => {
    const pairs = extractTurnPairs(messages, 'claude-code', 'sess', new Date(), 'fp123')
    for (const p of pairs) expect(p.projectId).toBe('global')
  })
})
