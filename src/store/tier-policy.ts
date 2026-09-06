// Two-tier storage policy (Step 4). Pure + deterministic. Decides how long a
// memory of a given salience tier stays durable before it becomes ELIGIBLE for
// forgetting (Step 6 enforces; this module only computes the eligibility date).
//
// Tier map — LOCKED by the product owner for v0.3.1 (audit Q4 / D6):
//   raw captures (conversations/)  PERMANENT — never touched by this module
//   core facts                     PERMANENT — never age-expire
//   standard facts                 SUPERSESSION-ONLY — never age-expire; they leave
//                                  only via the superseded-aged path in forget.ts
//   trivia facts                   30 days
//
// Migration (v0.3.0 → v0.3.1): standard facts written under the old policy carry
// an `expiresAt` ~180 days after creation. Those stamps are IGNORED on read
// (`isAgeExpired` → false for a tier with no TTL), so nobody's standard facts
// silently die at +180 d. No file is rewritten.
import type { SalienceTier } from '../salience/types.js'

export interface TierPolicyConfig {
  /**
   * Days a 'standard' memory stays durable before becoming forget-eligible.
   * null = never by age (supersession-only) — the shipped default.
   */
  standardTtlDays: number | null
  /** Days a 'trivia' memory stays durable before becoming forget-eligible. */
  triviaTtlDays: number | null
}

export const DEFAULT_TIER_POLICY: TierPolicyConfig = {
  standardTtlDays: null,
  triviaTtlDays: 30,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The TTL (days) a tier is subject to under `policy`, or null when the tier never age-expires. */
export function ttlDaysFor(
  tier: SalienceTier,
  policy: TierPolicyConfig = DEFAULT_TIER_POLICY,
): number | null {
  if (tier === 'core') return null
  return tier === 'trivia' ? policy.triviaTtlDays : policy.standardTtlDays
}

/** Coarse storage tier a salience tier maps to. 'fast' = age-expiring; 'slow' = durable by age. */
export function storageTierOf(
  tier: SalienceTier,
  policy: TierPolicyConfig = DEFAULT_TIER_POLICY,
): 'slow' | 'fast' {
  return ttlDaysFor(tier, policy) === null ? 'slow' : 'fast'
}

/**
 * Compute the expiry timestamp for a memory. Returns null for memories that never
 * age-expire. Pure: same inputs → same output.
 *   core     → null (permanent)
 *   standard → null under the default policy (supersession-only)
 *   trivia   → createdAt + triviaTtlDays
 */
export function computeExpiresAt(
  tier: SalienceTier,
  createdAt: Date,
  policy: TierPolicyConfig = DEFAULT_TIER_POLICY,
): Date | null {
  const days = ttlDaysFor(tier, policy)
  if (days === null) return null
  return new Date(createdAt.getTime() + days * MS_PER_DAY)
}

/**
 * Whether a stored memory is age-expired RIGHT NOW. This is the single read-side
 * rule every consumer applies (forget eligibility, synthesis collection, the
 * consolidation active set): a stamp only counts if the memory's tier is subject
 * to a TTL under the policy. A stray or legacy `expiresAt` on a core/standard
 * memory is therefore inert — which is exactly the v0.3.0 → v0.3.1 migration.
 */
export function isAgeExpired(
  tier: SalienceTier,
  expiresAt: Date | null,
  now: Date,
  policy: TierPolicyConfig = DEFAULT_TIER_POLICY,
): boolean {
  if (expiresAt === null) return false
  if (ttlDaysFor(tier, policy) === null) return false
  return expiresAt.getTime() < now.getTime()
}
