import { describe, expect, it } from 'vitest'

import type { ExtractedFact } from '../../src/extraction/types.ts'
import { clampScore, heuristicSalience, tierForScore } from '../../src/salience/heuristic.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fact(
  category: ExtractedFact['category'],
  confidence: ExtractedFact['confidence'],
): ExtractedFact {
  return { text: `${category}/${confidence} fact`, category, confidence }
}

// ---------------------------------------------------------------------------
// heuristicSalience — the deterministic floor mapping
// ---------------------------------------------------------------------------

describe('heuristicSalience — category x confidence mapping', () => {
  it('IDENTITY + HIGH → top score, core tier', () => {
    const s = heuristicSalience(fact('IDENTITY', 'HIGH'))
    expect(s.score).toBe(1)
    expect(s.tier).toBe('core')
    expect(s.reason).toBe('heuristic floor')
  })

  it('EVENT + LOW → low score, trivia tier', () => {
    const s = heuristicSalience(fact('EVENT', 'LOW'))
    // 0.45 (EVENT) * 0.4 (LOW) = 0.18
    expect(s.score).toBeCloseTo(0.18, 5)
    expect(s.tier).toBe('trivia')
    expect(s.reason).toBe('heuristic floor')
  })

  it('PREFERENCE + MEDIUM → mid score, standard tier', () => {
    const s = heuristicSalience(fact('PREFERENCE', 'MEDIUM'))
    // 0.7 (PREFERENCE) * 0.7 (MEDIUM) = 0.49
    expect(s.score).toBeCloseTo(0.49, 5)
    expect(s.tier).toBe('standard')
  })

  it('RELATIONSHIP + HIGH → core (second-highest category at full confidence)', () => {
    const s = heuristicSalience(fact('RELATIONSHIP', 'HIGH'))
    expect(s.score).toBeCloseTo(0.9, 5)
    expect(s.tier).toBe('core')
  })

  it('every category/confidence combination stays within [0, 1]', () => {
    const categories: ExtractedFact['category'][] = [
      'IDENTITY',
      'PREFERENCE',
      'CONTEXT',
      'RELATIONSHIP',
      'SKILL',
      'EVENT',
    ]
    const confidences: ExtractedFact['confidence'][] = ['HIGH', 'MEDIUM', 'LOW']
    for (const c of categories) {
      for (const conf of confidences) {
        const s = heuristicSalience(fact(c, conf))
        expect(s.score).toBeGreaterThanOrEqual(0)
        expect(s.score).toBeLessThanOrEqual(1)
        expect(s.reason).toBe('heuristic floor')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// clampScore
// ---------------------------------------------------------------------------

describe('clampScore', () => {
  it('clamps values above 1 down to 1', () => {
    expect(clampScore(1.5)).toBe(1)
    expect(clampScore(42)).toBe(1)
  })

  it('clamps values below 0 up to 0', () => {
    expect(clampScore(-0.2)).toBe(0)
    expect(clampScore(-99)).toBe(0)
  })

  it('passes through in-range values unchanged', () => {
    expect(clampScore(0)).toBe(0)
    expect(clampScore(0.5)).toBe(0.5)
    expect(clampScore(1)).toBe(1)
  })

  it('degrades non-finite input to 0', () => {
    expect(clampScore(Number.NaN)).toBe(0)
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampScore(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// tierForScore — threshold boundaries (core >= 0.65, standard >= 0.35)
// ---------------------------------------------------------------------------

describe('tierForScore — thresholds', () => {
  it('score >= 0.65 → core', () => {
    expect(tierForScore(0.65)).toBe('core')
    expect(tierForScore(0.8)).toBe('core')
    expect(tierForScore(1)).toBe('core')
  })

  it('0.35 <= score < 0.65 → standard', () => {
    expect(tierForScore(0.35)).toBe('standard')
    expect(tierForScore(0.5)).toBe('standard')
    expect(tierForScore(0.6499)).toBe('standard')
  })

  it('score < 0.35 → trivia', () => {
    expect(tierForScore(0.3499)).toBe('trivia')
    expect(tierForScore(0.1)).toBe('trivia')
    expect(tierForScore(0)).toBe('trivia')
  })
})
