// Deterministic salience FLOOR — derived purely from the signals extraction
// ALREADY produces (category + confidence). Two roles:
//   1. The harness floor for the salience task (when the local model stutters).
//   2. A sane standalone default (e.g. backward-compatible reads, external
//      hard-fail degradation).
// Pure function: same fact in → same score out, no I/O, no model.

import type { ExtractedFact } from '../extraction/types.js'
import type { SalienceScore, SalienceTier } from './types.js'

/**
 * Category weight: IDENTITY/RELATIONSHIP are the most defining facts about a
 * person, PREFERENCE/SKILL are mid (useful but malleable), CONTEXT/EVENT are
 * the lowest (often time-bound or incidental). Tuned constants — adjust here.
 */
const CATEGORY_WEIGHT: Record<ExtractedFact['category'], number> = {
  IDENTITY: 1.0,
  RELATIONSHIP: 0.9,
  PREFERENCE: 0.7,
  SKILL: 0.65,
  CONTEXT: 0.55,
  EVENT: 0.45,
}

/** Confidence weight: HIGH > MEDIUM > LOW. Pulls a shaky fact's score down. */
const CONFIDENCE_WEIGHT: Record<ExtractedFact['confidence'], number> = {
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.4,
}

/** Tier thresholds on the 0..1 score. */
const CORE_THRESHOLD = 0.65
const STANDARD_THRESHOLD = 0.35

/** Clamp any number into [0, 1]; non-finite input degrades to 0. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.min(1, Math.max(0, score))
}

/** Map a 0..1 score to its coarse tier. */
export function tierForScore(score: number): SalienceTier {
  if (score >= CORE_THRESHOLD) return 'core'
  if (score >= STANDARD_THRESHOLD) return 'standard'
  return 'trivia'
}

/**
 * Deterministic salience from category + confidence:
 *   score = clamp(categoryWeight * confidenceWeight, 0, 1)
 *   tier  = thresholds on score
 * reason is the LOUD marker that a heuristic floor was used.
 */
export function heuristicSalience(fact: ExtractedFact): SalienceScore {
  const score = clampScore(CATEGORY_WEIGHT[fact.category] * CONFIDENCE_WEIGHT[fact.confidence])
  return { score, tier: tierForScore(score), reason: 'heuristic floor' }
}
