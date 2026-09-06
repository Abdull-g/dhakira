// v0.3.1 tier map — LOCKED by the product owner (audit Q4 / D6):
//   raw captures PERMANENT · core PERMANENT · standard SUPERSESSION-ONLY · trivia 30 d
// plus the read-side migration rule for legacy standard-tier expiresAt stamps.

import { describe, expect, it } from 'vitest'

import type { TierPolicyConfig } from '../../src/store/tier-policy.ts'
import {
  computeExpiresAt,
  DEFAULT_TIER_POLICY,
  isAgeExpired,
  storageTierOf,
  ttlDaysFor,
} from '../../src/store/tier-policy.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

describe('computeExpiresAt — locked default policy', () => {
  it('core → null (permanent)', () => {
    expect(computeExpiresAt('core', CREATED_AT)).toBeNull()
  })

  it('standard → null (SUPERSESSION-ONLY; the 180-day age expiry is gone)', () => {
    expect(computeExpiresAt('standard', CREATED_AT)).toBeNull()
  })

  it('trivia → createdAt + 30 days', () => {
    const result = computeExpiresAt('trivia', CREATED_AT)
    expect(result).not.toBeNull()
    expect(result?.getTime()).toBe(CREATED_AT.getTime() + 30 * DAY_MS)
  })

  it('default policy constants: standard null / trivia 30', () => {
    expect(DEFAULT_TIER_POLICY).toEqual({ standardTtlDays: null, triviaTtlDays: 30 })
    expect(ttlDaysFor('core')).toBeNull()
    expect(ttlDaysFor('standard')).toBeNull()
    expect(ttlDaysFor('trivia')).toBe(30)
  })

  it('is pure: same inputs → same output', () => {
    expect(computeExpiresAt('trivia', CREATED_AT)?.getTime()).toBe(
      computeExpiresAt('trivia', CREATED_AT)?.getTime(),
    )
  })
})

describe('computeExpiresAt — custom policy (a TTL can still be opted into)', () => {
  const policy: TierPolicyConfig = { standardTtlDays: 90, triviaTtlDays: 7 }

  it('respects a custom standard TTL when one is configured', () => {
    expect(computeExpiresAt('standard', CREATED_AT, policy)?.getTime()).toBe(
      CREATED_AT.getTime() + 90 * DAY_MS,
    )
  })

  it('respects a custom trivia TTL', () => {
    expect(computeExpiresAt('trivia', CREATED_AT, policy)?.getTime()).toBe(
      CREATED_AT.getTime() + 7 * DAY_MS,
    )
  })

  it('core stays permanent regardless of policy', () => {
    expect(computeExpiresAt('core', CREATED_AT, policy)).toBeNull()
  })

  it('a null trivia TTL makes trivia durable too', () => {
    expect(
      computeExpiresAt('trivia', CREATED_AT, { standardTtlDays: null, triviaTtlDays: null }),
    ).toBeNull()
  })
})

describe('storageTierOf', () => {
  it('core → slow (permanent)', () => {
    expect(storageTierOf('core')).toBe('slow')
  })

  it('standard → slow (durable by age; leaves only via supersession)', () => {
    expect(storageTierOf('standard')).toBe('slow')
  })

  it('trivia → fast (age-expiring)', () => {
    expect(storageTierOf('trivia')).toBe('fast')
  })

  it('follows the policy: standard becomes fast only when a TTL is configured', () => {
    expect(storageTierOf('standard', { standardTtlDays: 90, triviaTtlDays: 30 })).toBe('fast')
  })
})

describe('isAgeExpired — the single read-side rule (forget, synthesis, consolidation)', () => {
  const now = new Date('2026-09-06T00:00:00.000Z')
  const past = new Date('2026-06-01T00:00:00.000Z')
  const future = new Date('2027-01-01T00:00:00.000Z')

  it('trivia with a past expiresAt → expired', () => {
    expect(isAgeExpired('trivia', past, now)).toBe(true)
  })

  it('trivia with a future expiresAt → not expired', () => {
    expect(isAgeExpired('trivia', future, now)).toBe(false)
  })

  it('null expiresAt is never expired (pre-T04 files, permanent tiers)', () => {
    expect(isAgeExpired('trivia', null, now)).toBe(false)
    expect(isAgeExpired('standard', null, now)).toBe(false)
    expect(isAgeExpired('core', null, now)).toBe(false)
  })

  it('MIGRATION: a standard memory carrying a legacy (v0.3.0, +180 d) past expiresAt is NOT expired', () => {
    expect(isAgeExpired('standard', past, now)).toBe(false)
  })

  it('core with a stray past expiresAt (data drift) is NOT expired', () => {
    expect(isAgeExpired('core', past, now)).toBe(false)
  })

  it('boundary: expiresAt exactly == now → not expired (strict <)', () => {
    expect(isAgeExpired('trivia', new Date(now.getTime()), now)).toBe(false)
  })

  it('honours a policy that gives standard a TTL', () => {
    expect(isAgeExpired('standard', past, now, { standardTtlDays: 90, triviaTtlDays: 30 })).toBe(
      true,
    )
  })
})
