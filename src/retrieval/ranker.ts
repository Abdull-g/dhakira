// Retrieval RANK path (CLOSED): OUR scoring brain. No backend/QMD coupling.
import { createLogger } from '../utils/logger.js'
import type { RawCandidate } from './backend.js'
import { parseTurnPairFromBody } from './loader.js'
import type { ScopeMode, TurnSearchOptions, TurnSearchResult } from './types.js'

/**
 * Recency decay factor: 1.0 for today, linearly decreasing to 0.0 at 90 days ago.
 */
function computeRecencyFactor(timestamp: string): number {
  const daysDiff = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24)
  return Math.max(0, 1 - daysDiff / 90)
}

/**
 * Jaccard-style word overlap between two strings.
 * Returns a value in [0, 1] where 1 = identical word sets.
 */
function computeWordOverlap(a: string, b: string): number {
  const toWords = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter(Boolean))
  const setA = toWords(a)
  const setB = toWords(b)
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) {
    if (setB.has(w)) intersection++
  }
  return intersection / Math.max(setA.size, setB.size)
}

/**
 * Remove near-duplicate results from the same session.
 * Two results are duplicates if they share the same sessionId and have >90%
 * word overlap across their combined user + assistant text.
 * The list must be pre-sorted by score descending so the higher-scored item is kept.
 */
function deduplicateBySession(results: TurnSearchResult[]): TurnSearchResult[] {
  const kept: TurnSearchResult[] = []
  for (const candidate of results) {
    const candidateText = `${candidate.turnPair.userContent} ${candidate.turnPair.assistantContent}`
    const isDuplicate = kept.some((k) => {
      if (k.turnPair.sessionId !== candidate.turnPair.sessionId) return false
      const kText = `${k.turnPair.userContent} ${k.turnPair.assistantContent}`
      return computeWordOverlap(kText, candidateText) > 0.9
    })
    if (!isDuplicate) kept.push(candidate)
  }
  return kept
}

/**
 * Project-scope multiplier for the context ranking axis (T07).
 *
 * 'boost' (DEFAULT, shipping) gives a soft 1.5x to turns sharing the request's
 * projectId — stable across tools/machines (the moat), unlike the demoted
 * system-prompt fingerprint it replaces. 'only' (hard project isolation) is a
 * RESERVED seam: it is threaded end-to-end so it's not a future refactor, but no
 * behavior ships — it currently behaves identically to 'boost' and no caller sets
 * it (observe-first, same gate as consolidation's dark flag / T06's purge).
 */
function projectScopeMultiplier(scopeMode: ScopeMode, matched: boolean): number {
  if (!matched) return 1.0
  switch (scopeMode) {
    case 'boost':
    case 'only':
      return 1.5
  }
}

/**
 * Apply OUR ranking to raw backend candidates.
 *
 * Parses each body, applies recency boosting so recent relevant turns score higher:
 *   finalScore = relevanceScore × (1 + recencyBoost × recencyFactor) × contextMultiplier
 * where recencyFactor decays linearly from 1.0 (today) to 0.0 (≥90 days ago) and
 * contextMultiplier is 1.5x for turns sharing the request's projectId (the T07
 * context axis — fingerprint is no longer compared directly; it only feeds the
 * upstream resolver). "global" never boosts.
 *
 * Then sorts by score descending, collapses same-session near-duplicates (>90% word
 * overlap, keeping the higher-scored entry), filters below `minScore`, and slices to `limit`.
 */
export function rankCandidates(
  candidates: RawCandidate[],
  options: TurnSearchOptions,
): TurnSearchResult[] {
  const logger = createLogger('retrieval')
  const { limit = 8, minScore = 0.3, recencyBoost = 0.3, projectId, scopeMode = 'boost' } = options

  // Parse turn pairs, apply recency boost, collect valid results.
  const scored: TurnSearchResult[] = []
  for (const raw of candidates) {
    const turnPair = parseTurnPairFromBody(raw.body)
    if (!turnPair) {
      logger.warn('Could not parse turn pair from body', { file: raw.file })
      continue
    }
    const recencyFactor = computeRecencyFactor(turnPair.timestamp)
    const projectMatch =
      projectId !== undefined && projectId !== 'global' && turnPair.projectId === projectId
    const contextMultiplier = projectScopeMultiplier(scopeMode, projectMatch)
    const finalScore = raw.score * (1 + recencyBoost * recencyFactor) * contextMultiplier
    scored.push({ turnPair, score: finalScore, source: raw.file })
  }

  // Sort, deduplicate, filter, slice.
  scored.sort((a, b) => b.score - a.score)
  const deduped = deduplicateBySession(scored)
  return deduped.filter((r) => r.score >= minScore).slice(0, limit)
}
