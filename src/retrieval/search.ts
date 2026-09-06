// Search across QMD collections — thin orchestrator over the retrieval seam.
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { loadCandidates } from './loader.js'
import { recordRecall } from './metrics.js'
import { QMDBackend, type QMDStore } from './qmd-backend.js'
import { rankCandidates } from './ranker.js'
import type { TurnSearchOptions, TurnSearchResult } from './types.js'

// Re-exported for callers/tests that import it from this module.
export { parseTurnPairFromBody } from './loader.js'

/**
 * Daemon-side hybrid-search deadline (D2, v0.3.1). The hook adapters abort at
 * DEFAULT_TIMEOUT_MS = 1500 ms (src/hooks/shared-adapter.ts) and fail open, so a
 * cold hybrid search (three models loading) used to mean the user silently got no
 * memory. After this many ms the daemon serves BM25 instead and lets hybrid
 * finish in the background (warming the models for the next call).
 *
 * INVARIANT: this MUST stay comfortably below the 1.5 s hook budget — it has to
 * leave room for the BM25 query, ranking, injection composition and the HTTP
 * round-trip. 900 ms leaves ~600 ms of headroom. Never raise the hook budget to
 * accommodate a slower daemon; fix the daemon.
 */
export const HYBRID_DEADLINE_MS = 900

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
 * Falls back to BM25 (`searchLex`) when hybrid search fails, returns nothing, or
 * misses HYBRID_DEADLINE_MS (cold models). Every search records latency + whether
 * the deadline fired (retrieval/metrics.ts → /api/status, `dhakira doctor`).
 */
export async function searchTurns(
  store: QMDStore,
  options: TurnSearchOptions,
): Promise<Result<TurnSearchResult[]>> {
  const logger = createLogger('retrieval')
  const { query, limit = 8, recencyBoost = 0.3 } = options
  const fetchLimit = limit * 2
  const startedAt = Date.now()
  let deadlineHit = false

  try {
    const backend = new QMDBackend(store)
    const raw = await loadCandidates(backend, query, fetchLimit, {
      deadlineMs: options.hybridDeadlineMs ?? HYBRID_DEADLINE_MS,
      onDeadline: () => {
        deadlineHit = true
      },
    })
    const results = rankCandidates(raw, options)
    recordRecall(Date.now() - startedAt, deadlineHit)

    logger.debug('Turn search complete', {
      query,
      results: results.length,
      recencyBoost,
      deadlineHit,
    })
    return { ok: true, value: results }
  } catch (err) {
    recordRecall(Date.now() - startedAt, deadlineHit)
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Turn search failed', { query, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
