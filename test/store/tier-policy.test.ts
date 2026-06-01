import { describe, expect, it } from 'vitest'

import type { TierPolicyConfig } from '../../src/store/tier-policy.ts'
import {
  computeExpiresAt,
  DEFAULT_TIER_POLICY,
  storageTierOf,
} from '../../src/store/tier-policy.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

describe('computeExpiresAt — default policy', () => {
  it('core → null (durable, never forget-eligible)', () => {
    expect(computeExpiresAt('core', CREATED_AT)).toBeNull()
  })

  it('standard → createdAt + 180 days', () => {
    const result = computeExpiresAt('standard', CREATED_AT)
    expect(result).not.toBeNull()
    expect(result?.getTime()).toBe(CREATED_AT.getTime() + 180 * DAY_MS)
  })

  it('trivia → createdAt + 30 days', () => {
    const result = computeExpiresAt('trivia', CREATED_AT)
    expect(result).not.toBeNull()
    expect(result?.getTime()).toBe(CREATED_AT.getTime() + 30 * DAY_MS)
  })

  it('default policy constants are 180 / 30', () => {
    expect(DEFAULT_TIER_POLICY).toEqual({ standardTtlDays: 180, triviaTtlDays: 30 })
  })

  it('is pure: same inputs → same output', () => {
    expect(computeExpiresAt('standard', CREATED_AT)?.getTime()).toBe(
      computeExpiresAt('standard', CREATED_AT)?.getTime(),
    )
  })
})

describe('computeExpiresAt — custom policy', () => {
  const policy: TierPolicyConfig = { standardTtlDays: 90, triviaTtlDays: 7 }

  it('respects a custom standard TTL', () => {
    expect(computeExpiresAt('standard', CREATED_AT, policy)?.getTime()).toBe(
      CREATED_AT.getTime() + 90 * DAY_MS,
    )
  })

  it('respects a custom trivia TTL', () => {
    expect(computeExpiresAt('trivia', CREATED_AT, policy)?.getTime()).toBe(
      CREATED_AT.getTime() + 7 * DAY_MS,
    )
  })

  it('core stays durable regardless of policy', () => {
    expect(computeExpiresAt('core', CREATED_AT, policy)).toBeNull()
  })
})

describe('storageTierOf', () => {
  it('maps core → slow (durable)', () => {
    expect(storageTierOf('core')).toBe('slow')
  })

  it('maps standard → fast (TTL’d)', () => {
    expect(storageTierOf('standard')).toBe('fast')
  })

  it('maps trivia → fast (TTL’d)', () => {
    expect(storageTierOf('trivia')).toBe('fast')
  })
})
