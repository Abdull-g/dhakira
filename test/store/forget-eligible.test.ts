import { describe, expect, it } from 'vitest'

import type { SalienceTier } from '../../src/salience/types.ts'
import {
  DEFAULT_FORGET_POLICY,
  type ForgetCandidate,
  isForgetEligible,
} from '../../src/store/forget.ts'

const NOW = new Date('2026-06-03T00:00:00.000Z')

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
}
function daysAhead(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000)
}

function candidate(overrides: Partial<ForgetCandidate> = {}): ForgetCandidate {
  return {
    expiresAt: null,
    invalidatedAt: null,
    salienceTier: 'standard' as SalienceTier,
    forgottenAt: null,
    ...overrides,
  }
}

describe('isForgetEligible — expiry path (the load-bearing change)', () => {
  it('expired trivia memory → eligible, reason "expired"', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: daysAgo(1) }),
      NOW,
    )
    expect(result).toEqual({ eligible: true, reason: 'expired' })
  })

  it('long-expired trivia memory → eligible, reason "expired"', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: daysAgo(170) }),
      NOW,
    )
    expect(result).toEqual({ eligible: true, reason: 'expired' })
  })

  it('not-yet-expired trivia (expiresAt in the future) → not eligible', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: daysAhead(10) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('expiresAt exactly == now → not eligible (strict <, not <=)', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: new Date(NOW) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })
})

// v0.3.1 — LOCKED tier map: standard facts are SUPERSESSION-ONLY.
describe('isForgetEligible — standard is supersession-only (v0.3.1 tier map)', () => {
  it('a standard memory with a PAST expiresAt (legacy v0.3.0 +180 d stamp) is NOT expiry-eligible (migration)', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'standard', expiresAt: daysAgo(1) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('a long-expired legacy standard stamp is still inert', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'standard', expiresAt: daysAgo(400) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('standard leaves ONLY via supersession + grace', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'standard', expiresAt: daysAgo(400), invalidatedAt: daysAgo(30) }),
      NOW,
    )
    expect(result).toEqual({ eligible: true, reason: 'superseded-aged' })
  })

  it('a policy that re-enables a standard TTL makes the stamp count again (opt-in, not default)', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'standard', expiresAt: daysAgo(1) }),
      NOW,
      { supersededGraceDays: 14, tiers: { standardTtlDays: 180, triviaTtlDays: 30 } },
    )
    expect(result).toEqual({ eligible: true, reason: 'expired' })
  })
})

describe('isForgetEligible — durable / backward-compat (never force-expired)', () => {
  it('durable memory (expiresAt == null) → never eligible by expiry', () => {
    const result = isForgetEligible(candidate({ expiresAt: null }), NOW)
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('pre-T04 file (no expiresAt line → null, default standard tier) is NEVER eligible', () => {
    // A legacy file read by readMemoryExpiresAt yields null; readMemorySalience
    // defaults it to `standard`. It must stay durable, NOT get swept.
    const result = isForgetEligible(
      candidate({ salienceTier: 'standard', expiresAt: null, invalidatedAt: null }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })
})

describe('isForgetEligible — core immunity (anchored on tier, not null expiry)', () => {
  it('core memory with null expiresAt → never eligible by expiry', () => {
    const result = isForgetEligible(candidate({ salienceTier: 'core', expiresAt: null }), NOW)
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('core file with a STRAY non-null past expiresAt (data drift) is STILL protected', () => {
    // The guard must be on salienceTier === 'core', not on expiresAt == null.
    const result = isForgetEligible(
      candidate({ salienceTier: 'core', expiresAt: daysAgo(500) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('core memory can ONLY leave via supersession + grace', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'core', expiresAt: daysAgo(500), invalidatedAt: daysAgo(30) }),
      NOW,
    )
    expect(result).toEqual({ eligible: true, reason: 'superseded-aged' })
  })
})

describe('isForgetEligible — supersession + grace window', () => {
  it('superseded but FRESH (within grace) → not eligible', () => {
    const result = isForgetEligible(candidate({ invalidatedAt: daysAgo(3) }), NOW)
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('superseded and AGED (past grace) → eligible, reason "superseded-aged"', () => {
    const result = isForgetEligible(candidate({ invalidatedAt: daysAgo(20) }), NOW)
    expect(result).toEqual({ eligible: true, reason: 'superseded-aged' })
  })

  it('invalidatedAt exactly at the grace boundary → not eligible (strict <)', () => {
    const atBoundary = daysAgo(DEFAULT_FORGET_POLICY.supersededGraceDays)
    const result = isForgetEligible(candidate({ invalidatedAt: atBoundary }), NOW)
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('respects a custom grace policy', () => {
    const sevenDayGrace = { ...DEFAULT_FORGET_POLICY, supersededGraceDays: 7 }
    const result = isForgetEligible(candidate({ invalidatedAt: daysAgo(10) }), NOW, sevenDayGrace)
    expect(result).toEqual({ eligible: true, reason: 'superseded-aged' })
  })
})

describe('isForgetEligible — idempotency (a 2nd run forgets 0)', () => {
  it('already forgotten (forgottenAt set) → not eligible, even if expired', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', forgottenAt: daysAgo(1), expiresAt: daysAgo(100) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })

  it('already forgotten → not eligible, even if superseded-aged', () => {
    const result = isForgetEligible(
      candidate({ forgottenAt: daysAgo(1), invalidatedAt: daysAgo(100) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })
})

describe('isForgetEligible — supersession routes EXCLUSIVELY through grace', () => {
  it('expired AND superseded-aged → "superseded-aged" (supersession is handled exclusively)', () => {
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: daysAgo(100), invalidatedAt: daysAgo(20) }),
      NOW,
    )
    expect(result).toEqual({ eligible: true, reason: 'superseded-aged' })
  })

  it('expired AND superseded-FRESH → grace protects it (not eligible, despite fired TTL)', () => {
    // Grace takes ABSOLUTE precedence: a superseded source can never be retired
    // by its own expiry — only via superseded-aged once the full window elapses.
    // This preserves the 14-day reverse-a-bad-consolidation recovery guarantee.
    const result = isForgetEligible(
      candidate({ salienceTier: 'trivia', expiresAt: daysAgo(100), invalidatedAt: daysAgo(3) }),
      NOW,
    )
    expect(result).toEqual({ eligible: false, reason: null })
  })
})
