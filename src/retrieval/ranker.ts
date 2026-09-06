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
 * Both modes give a soft 1.5x to turns sharing the request's projectId — stable
 * across tools/machines (the moat), unlike the demoted system-prompt fingerprint
 * it replaces. The modes differ in what happens to NON-matching turns: 'boost'
 * keeps them (unboosted); 'only' drops them (see scopeFilter). "global" turns
 * are never boosted in either mode.
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
 * v0.3.1 (audit D15): 'only' is a REAL post-filter now, not a silent alias of
 * 'boost'. With a real request scope it keeps turns that share the projectId
 * plus 'global' turns (cross-project identity such as profile-derived memory
 * must still surface); everything from OTHER projects is dropped. With no scope
 * (undefined / 'global') there is nothing to isolate to, so nothing is dropped.
 */
function scopeFilter(
  results: TurnSearchResult[],
  scopeMode: ScopeMode,
  projectId: string | undefined,
): TurnSearchResult[] {
  if (scopeMode !== 'only' || projectId === undefined || projectId === 'global') return results
  return results.filter(
    (r) => r.turnPair.projectId === projectId || r.turnPair.projectId === 'global',
  )
}

/**
 * v0.3.1 (audit D13): hybrid scores are a 0–1 position-blended value, BM25
 * (`searchLex`) scores are unbounded — so one `minScore` cannot mean the same
 * thing on both paths. DECISION: normalize BM25 scores by the top BM25 hit so
 * they land in (0, 1] and `minScore` becomes a RELATIVE cut on the fallback path
 * ("keep hits scoring at least 30% of the best keyword match"). Rejected
 * alternative — skipping `minScore` for BM25 — would inject weak keyword hits
 * unfiltered whenever the models are cold. Hybrid scores are untouched.
 */
function normalizeRelevance(candidates: RawCandidate[]): (raw: RawCandidate) => number {
  let lexTop = 0
  for (const c of candidates) {
    if (c.source === 'lex' && c.score > lexTop) lexTop = c.score
  }
  return (raw) => (raw.source === 'lex' && lexTop > 0 ? raw.score / lexTop : raw.score)
}

/**
 * Apply OUR ranking to raw backend candidates.
 *
 * Parses each body, applies recency boosting so recent relevant turns score higher:
 *   finalScore = relevanceScore × (1 + recencyBoost × recencyFactor) × contextMultiplier
 * where relevanceScore is the hybrid score (or the BM25 score normalized by the top
 * BM25 hit — see normalizeRelevance), recencyFactor decays linearly from 1.0
 * (today) to 0.0 (≥90 days ago) and contextMultiplier is 1.5x for turns sharing
 * the request's projectId (the T07 context axis — fingerprint is no longer
 * compared directly; it only feeds the upstream resolver). "global" never boosts.
 *
 * Then sorts by score descending, collapses same-session near-duplicates (>90% word
 * overlap, keeping the higher-scored entry), applies the scopeMode filter, filters
 * below `minScore`, and slices to `limit`.
 */
export function rankCandidates(
  candidates: RawCandidate[],
  options: TurnSearchOptions,
): TurnSearchResult[] {
  const logger = createLogger('retrieval')
  const { limit = 8, minScore = 0.3, recencyBoost = 0.3, projectId, scopeMode = 'boost' } = options
  const relevanceOf = normalizeRelevance(candidates)

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
    const finalScore = relevanceOf(raw) * (1 + recencyBoost * recencyFactor) * contextMultiplier
    scored.push({ turnPair, score: finalScore, source: raw.file })
  }

  // Sort, deduplicate, scope-filter, threshold, slice.
  scored.sort((a, b) => b.score - a.score)
  const deduped = scopeFilter(deduplicateBySession(scored), scopeMode, projectId)
  return deduped.filter((r) => r.score >= minScore).slice(0, limit)
}
