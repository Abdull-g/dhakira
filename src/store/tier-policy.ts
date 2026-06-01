// Two-tier storage policy (Step 4). Pure + deterministic. Decides how long a
// memory of a given salience tier stays durable before it becomes ELIGIBLE for
// forgetting (Step 6 enforces; this module only computes the eligibility date).
//
// Tier model (CLS): 'core' = slow/neocortical = durable (never expires).
// 'standard' / 'trivia' = fast/hippocampal = TTL'd, eligible for later forgetting.
import type { SalienceTier } from '../salience/types.js'

export interface TierPolicyConfig {
  /** Days a 'standard' memory stays durable before becoming forget-eligible. */
  standardTtlDays: number
  /** Days a 'trivia' memory stays durable before becoming forget-eligible. */
  triviaTtlDays: number
}

export const DEFAULT_TIER_POLICY: TierPolicyConfig = {
  standardTtlDays: 180,
  triviaTtlDays: 30,
}

/** Coarse storage tier a salience tier maps to. 'core' → slow (durable); else fast (TTL'd). */
export function storageTierOf(tier: SalienceTier): 'slow' | 'fast' {
  return tier === 'core' ? 'slow' : 'fast'
}

/**
 * Compute the expiry timestamp for a memory. Returns null for durable (slow-tier)
 * memories that never expire. Pure: same inputs → same output.
 *   core     → null (durable, never forget-eligible)
 *   standard → createdAt + standardTtlDays
 *   trivia   → createdAt + triviaTtlDays
 */
export function computeExpiresAt(
  tier: SalienceTier,
  createdAt: Date,
  policy: TierPolicyConfig = DEFAULT_TIER_POLICY,
): Date | null {
  if (tier === 'core') return null
  const days = tier === 'trivia' ? policy.triviaTtlDays : policy.standardTtlDays
  return new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000)
}
