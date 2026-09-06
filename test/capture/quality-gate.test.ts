import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyQualityGate,
  clearQualityGateRejections,
  evaluateTurnPair,
  getQualityGateRejections,
  REJECTION_LOG_MAX,
} from '../../src/capture/quality-gate.ts'
import type { TurnPair } from '../../src/capture/turns.ts'

interface CorpusRecord {
  reqBody: unknown
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v1.jsonl')

function makePair(overrides: Partial<TurnPair> = {}): TurnPair {
  return {
    id: 'turn_quality_001',
    userContent: 'Please explain how to run the test suite.',
    assistantContent: 'Run npm test from the repository root.',
    timestamp: '2026-05-02T00:00:00.000Z',
    tool: 'claude-code',
    sessionId: 'conv_quality',
    turnIndex: 0,
    contextFingerprint: 'default',
    projectId: 'global',
    ...overrides,
  }
}

async function corpusUserPrompts(): Promise<string[]> {
  const raw = await readFile(CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .flatMap((line): string[] => {
      const record = JSON.parse(line) as CorpusRecord
      const body = record.reqBody
      if (!isRecord(body) || !Array.isArray(body.messages)) return []
      return body.messages.flatMap((message): string[] => {
        if (!isRecord(message) || message.role !== 'user') return []
        if (typeof message.content === 'string') return [message.content]
        return []
      })
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('quality gate', () => {
  beforeEach(() => {
    clearQualityGateRejections()
  })

  it('keeps a substantive turn pair', () => {
    const result = evaluateTurnPair(makePair())

    expect(result.keep).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('rejects user content shorter than 10 characters using a corpus example', async () => {
    const prompts = await corpusUserPrompts()
    expect(prompts).toContain('hi')

    const result = evaluateTurnPair(makePair({ userContent: 'hi' }))

    expect(result.keep).toBe(false)
    expect(result.reasons).toContain('user_too_short')
  })

  it('rejects short assistant junk patterns', () => {
    const result = evaluateTurnPair(makePair({ assistantContent: 'Sure,' }))

    expect(result.keep).toBe(false)
    expect(result.reasons).toContain('assistant_junk_short')
  })

  it('rejects JSON-only title stubs', () => {
    const result = evaluateTurnPair(makePair({ assistantContent: '{"title":"Fix tests"}' }))

    expect(result.keep).toBe(false)
    expect(result.reasons).toContain('assistant_json_stub')
  })

  it('rejects content that is 90 percent whitespace or non-printable', () => {
    const result = evaluateTurnPair(makePair({ assistantContent: `\u0000\n\t         x` }))

    expect(result.keep).toBe(false)
    expect(result.reasons).toContain('mostly_whitespace_or_nonprintable')
  })

  it('logs rejections in memory only', () => {
    const kept = applyQualityGate([
      makePair({ id: 'turn_good' }),
      makePair({ id: 'turn_bad', userContent: 'short' }),
    ])

    expect(kept.map((pair) => pair.id)).toEqual(['turn_good'])
    expect(getQualityGateRejections()).toEqual([
      { pairId: 'turn_bad', reasons: ['user_too_short'] },
    ])
  })

  it('caps the in-memory rejection log as a ring buffer (D14: no unbounded growth in a long-lived daemon)', () => {
    clearQualityGateRejections()
    const pairs = Array.from({ length: REJECTION_LOG_MAX + 25 }, (_, i) =>
      makePair({ id: `turn_bad_${i}`, userContent: 'short' }),
    )
    applyQualityGate(pairs)
    const log = getQualityGateRejections()
    expect(log).toHaveLength(REJECTION_LOG_MAX)
    // Oldest dropped, newest kept.
    expect(log[0]?.pairId).toBe('turn_bad_25')
    expect(log[log.length - 1]?.pairId).toBe(`turn_bad_${REJECTION_LOG_MAX + 24}`)
    clearQualityGateRejections()
  })

  it('tags oversized and complex tool flows without rejecting them', () => {
    const result = evaluateTurnPair(
      makePair({
        userContent: 'Please inspect these files and explain the result.',
        assistantContent: 'A'.repeat(50_001),
        metadata: { toolsUsed: ['Read', 'Write', 'Bash', 'Read', 'Write', 'Bash'] },
      }),
    )

    expect(result.keep).toBe(true)
    expect(result.tags).toEqual(['oversized', 'complex_tool_flow'])
  })
})
