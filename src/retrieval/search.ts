// Search across QMD collections — thin orchestrator over the retrieval seam.
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { loadCandidates } from './loader.js'
import { QMDBackend, type QMDStore } from './qmd-backend.js'
import { rankCandidates } from './ranker.js'
import type { TurnSearchOptions, TurnSearchResult } from './types.js'

// Re-exported for callers/tests that import it from this module.
export { parseTurnPairFromBody } from './loader.js'

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
  const { query, limit = 8, recencyBoost = 0.3 } = options
  const fetchLimit = limit * 2

  try {
    const backend = new QMDBackend(store)
    const raw = await loadCandidates(backend, query, fetchLimit)
    const results = rankCandidates(raw, options)

    logger.debug('Turn search complete', { query, results: results.length, recencyBoost })
    return { ok: true, value: results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Turn search failed', { query, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
