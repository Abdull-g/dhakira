// Search across QMD collections
import type { HybridQueryResult, SearchResult as QMDSearchResult, QMDStore } from '@tobilu/qmd'
import type { TurnPair } from '../capture/turns.js'
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import type { TurnSearchOptions, TurnSearchResult } from './types.js'

// ---------------------------------------------------------------------------
// Turn search helpers
// ---------------------------------------------------------------------------

/**
 * Parse a TurnPair from the markdown body of a turn pair file.
 * Expects YAML frontmatter followed by ## User / ## Assistant sections.
 * Returns null if the body is malformed or missing required fields.
 */
function parseTurnPairFromBody(body: string): TurnPair | null {
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fmMatch?.[1]) return null

  const fm = fmMatch[1]
  const get = (key: string): string =>
    fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''

  const id = get('id')
  const sessionId = get('sessionId')
  const timestamp = get('timestamp')
  if (!id || !sessionId || !timestamp) return null

  const afterFm = body.slice(fmMatch[0].length)
  const userMatch = afterFm.match(/## User\n([\s\S]*?)(?=\n## Assistant|$)/)
  const assistantMatch = afterFm.match(/## Assistant\n([\s\S]*)$/)

  return {
    id,
    sessionId,
    tool: get('tool'),
    timestamp,
    turnIndex: parseInt(get('turnIndex') || '0', 10),
    userContent: userMatch?.[1]?.trim() ?? '',
    assistantContent: assistantMatch?.[1]?.trim() ?? '',
    contextFingerprint: get('contextFingerprint') || 'default',
  }
}

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
 * Retrieve the body text from a hybrid or lexical search result.
 * For hybrid results the body is always present; for lexical results it is
 * optional — we fetch it via `store.getDocumentBody()` when missing.
 */
async function resolveBody(
  store: QMDStore,
  raw: HybridQueryResult | QMDSearchResult,
  isHybrid: boolean,
): Promise<string> {
  if (isHybrid) {
    return (raw as HybridQueryResult).body
  }
  const lex = raw as QMDSearchResult
  if (lex.body !== undefined && lex.body !== null) return lex.body
  const fp = lex.filepath ?? ((lex as Record<string, unknown>).file as string) ?? ''
  return (await store.getDocumentBody(fp)) ?? ''
}

// ---------------------------------------------------------------------------
// searchTurns
// ---------------------------------------------------------------------------

/**
 * Search the "turns" collection using hybrid search (BM25 + vector + reranking).
 *
 * Applies recency boosting so recent relevant turns score higher than old ones:
 *   finalScore = relevanceScore × (1 + recencyBoost × recencyFactor)
 * where recencyFactor decays linearly from 1.0 (today) to 0.0 (≥90 days ago).
 *
 * Same-session near-duplicates (>90% word overlap) are collapsed — only the
 * higher-scored entry is kept. Results below `minScore` are excluded.
 *
 * Falls back to BM25 (`searchLex`) when hybrid search fails (e.g. embedding
 * models not yet loaded on cold start).
 */
export async function searchTurns(
  store: QMDStore,
  options: TurnSearchOptions,
): Promise<Result<TurnSearchResult[]>> {
  const logger = createLogger('retrieval')
  const { query, limit = 8, minScore = 0.3, recencyBoost = 0.3, contextFingerprint } = options
  const fetchLimit = limit * 2

  try {
    // Attempt hybrid search; fall back to BM25 on failure.
    let rawPairs: Array<{ score: number; body: string; file: string }>

    try {
      const hybridResults = await store.search({ query, collection: 'turns', limit: fetchLimit })
      rawPairs = hybridResults.map((r) => ({ score: r.score, body: r.body, file: r.file }))
    } catch (hybridErr) {
      logger.warn('Hybrid search unavailable, falling back to BM25', {
        error: hybridErr instanceof Error ? hybridErr.message : String(hybridErr),
      })
      const lexResults = await store.searchLex(query, { collection: 'turns', limit: fetchLimit })
      rawPairs = await Promise.all(
        lexResults.map(async (r) => {
          const fp = r.filepath ?? ((r as Record<string, unknown>).file as string) ?? ''
          const body = await resolveBody(store, r, false)
          return { score: r.score, body, file: fp }
        }),
      )
    }

    // Parse turn pairs, apply recency boost, collect valid results.
    const scored: TurnSearchResult[] = []
    for (const raw of rawPairs) {
      const turnPair = parseTurnPairFromBody(raw.body)
      if (!turnPair) {
        logger.warn('Could not parse turn pair from body', { file: raw.file })
        continue
      }
      const recencyFactor = computeRecencyFactor(turnPair.timestamp)
      const contextMultiplier =
        contextFingerprint &&
        contextFingerprint !== 'default' &&
        turnPair.contextFingerprint === contextFingerprint
          ? 1.5
          : 1.0
      const finalScore = raw.score * (1 + recencyBoost * recencyFactor) * contextMultiplier
      scored.push({ turnPair, score: finalScore, source: raw.file })
    }

    // Sort, deduplicate, filter, slice.
    scored.sort((a, b) => b.score - a.score)
    const deduped = deduplicateBySession(scored)
    const results = deduped.filter((r) => r.score >= minScore).slice(0, limit)

    logger.debug('Turn search complete', { query, results: results.length, recencyBoost })
    return { ok: true, value: results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Turn search failed', { query, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
