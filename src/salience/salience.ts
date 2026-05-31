// Salience scorer — MODEL-FIRST via the T02 harness, with the deterministic
// heuristic as the LOUD floor. This is the harness's first real CAPABILITY
// consumer (extraction was the migration of an existing path).
//
// The harness is INJECTED (dependency injection) so salience reuses the SAME
// warm handle extraction already built — no second model is spun up. The
// HarnessTask (schema + floor closure + failureMessage) is built per-fact here.

import { fillTemplate, SALIENCE_PROMPT } from '../extraction/prompts.js'
import type { ExtractedFact } from '../extraction/types.js'
import type { ModelHarness } from '../harness/harness.js'
import type { HarnessTask } from '../harness/types.js'
import { createLogger } from '../utils/logger.js'
import { clampScore, heuristicSalience } from './heuristic.js'
import type { SalienceScore, SalienceTier } from './types.js'

const logger = createLogger('salience')

const SALIENCE_TIERS = ['core', 'standard', 'trivia'] as const

/** JSON-schema constraining the salience shape (GBNF grammar for the local model). */
const SALIENCE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    tier: { enum: ['core', 'standard', 'trivia'] },
    reason: { type: 'string' },
  },
} as const

/**
 * Local constrained path: 2 attempts then the heuristic floor (a grammar-
 * constrained model that stutters is recoverable). The unconstrained (external)
 * path can't floor — scoreSalience catches its hard-fail and degrades to the
 * heuristic itself, so salience NEVER blocks extraction.
 */
const SALIENCE_MAX_ATTEMPTS = 2

function isSalienceTier(value: string): value is SalienceTier {
  return (SALIENCE_TIERS as readonly string[]).includes(value)
}

/**
 * Validate + coerce parsed salience JSON into a SalienceScore.
 *   - score: coerced to number, clamped to [0,1]; non-numeric → null (retry/floor)
 *   - tier:  must be in the enum, else → null
 *   - reason: coerced to a trimmed string (may be empty)
 * Returns null on anything unusable, which triggers the harness retry/floor.
 */
export function validateSalience(parsed: unknown): SalienceScore | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const rawScore = typeof obj.score === 'number' ? obj.score : Number(obj.score)
  if (!Number.isFinite(rawScore)) return null
  const score = clampScore(rawScore)

  const tier = String(obj.tier ?? '')
  if (!isSalienceTier(tier)) return null

  const reason = String(obj.reason ?? '').trim()
  return { score, tier, reason }
}

/**
 * Build the per-fact HarnessTask. `floor` closes over THIS fact so the heuristic
 * fallback reflects the exact fact being scored. `failureMessage` is only
 * surfaced on the unconstrained no-floor path (handled by scoreSalience).
 */
export function buildSalienceTask(fact: ExtractedFact): HarnessTask<SalienceScore> {
  return {
    name: 'salience',
    schema: {
      jsonSchema: SALIENCE_JSON_SCHEMA,
      validate: validateSalience,
    },
    floor: () => heuristicSalience(fact),
    failureMessage: 'Salience response missing or invalid score/tier',
  }
}

/**
 * Score a single fact's salience through the (warm) harness. ALWAYS resolves to
 * a SalienceScore: the constrained path floors to the heuristic inside the
 * harness; the unconstrained path hard-fails and is caught here and degraded to
 * the heuristic — loudly. Salience must never block or throw out of extraction.
 */
export async function scoreSalience(
  fact: ExtractedFact,
  harness: ModelHarness,
): Promise<SalienceScore> {
  const task = buildSalienceTask(fact)
  const prompt = fillTemplate(SALIENCE_PROMPT, {
    fact_text: fact.text,
    category: fact.category,
    confidence: fact.confidence,
  })

  const result = await harness.run(task, prompt, { maxAttempts: SALIENCE_MAX_ATTEMPTS })
  if (result.ok) {
    return result.value.value
  }

  // Unconstrained (external) hard-fail: degrade to the deterministic heuristic
  // rather than failing the extraction. LOUD — never a silent fallback.
  logger.warn('salience scoring failed, using heuristic floor', {
    category: fact.category,
    confidence: fact.confidence,
    error: result.error.message,
  })
  return heuristicSalience(fact)
}
