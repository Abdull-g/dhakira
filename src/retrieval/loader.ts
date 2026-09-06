// Retrieval LOAD path (OPEN): backend plumbing + turn-pair parsing.
// QMD-free — talks only to the RetrievalBackend seam.
import type { TurnPair } from '../capture/turns.js'
import { createLogger } from '../utils/logger.js'
import type { RawCandidate, RetrievalBackend } from './backend.js'

/**
 * Parse a TurnPair from the markdown body of a turn pair file.
 * Expects YAML frontmatter followed by ## User / ## Assistant sections.
 * Returns null if the body is malformed or missing required fields.
 */
export function parseTurnPairFromBody(body: string): TurnPair | null {
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

  const userRecorded = get('userRecorded') === 'true' ? true : undefined

  return {
    id,
    sessionId,
    tool: get('tool'),
    timestamp,
    turnIndex: parseInt(get('turnIndex') || '0', 10),
    userContent: userMatch?.[1]?.trim() ?? '',
    assistantContent: assistantMatch?.[1]?.trim() ?? '',
    contextFingerprint: get('contextFingerprint') || 'default',
    // Backward-compat: pre-T07 turns have no projectId line → "global" (never break).
    projectId: get('projectId') || 'global',
    ...(userRecorded === undefined ? {} : { userRecorded }),
  }
}

export interface LoadCandidatesOptions {
  /**
   * Daemon-side deadline (ms) for the hybrid search. When it fires, BM25
   * (`searchLex`) is served immediately and the hybrid search is left running in
   * the background (it warms the models for the next call). Undefined = no
   * deadline (wait for hybrid).
   */
  deadlineMs?: number
  /** Called once if the deadline fires (telemetry). */
  onDeadline?: () => void
}

/** Sentinel returned by the race when the deadline wins. */
const DEADLINE: unique symbol = Symbol('hybrid-deadline')

function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Load raw candidates from the backend.
 *
 * Order of preference (v0.3.1, audit D2 + defect #13):
 *   1. hybrid search (BM25 + vector + rerank) when it answers in time with hits;
 *   2. BM25 (`searchLex`) when hybrid
 *      a. misses the daemon deadline (cold models — hybrid keeps running in the
 *         background so the NEXT call is warm),
 *      b. returns EMPTY but successful (previously returned as the final answer;
 *         BM25 hits were the hybrid seed set, so this can never add noise), or
 *      c. throws (models unavailable).
 * Never throws for a hybrid failure; a BM25 failure propagates to searchTurns.
 */
export async function loadCandidates(
  backend: RetrievalBackend,
  query: string,
  fetchLimit: number,
  options: LoadCandidatesOptions = {},
): Promise<RawCandidate[]> {
  const logger = createLogger('retrieval')
  const lex = (): Promise<RawCandidate[]> =>
    backend.searchLex(query, { collection: 'turns', limit: fetchLimit })

  const hybrid = backend.search({ query, collection: 'turns', limit: fetchLimit })
  let hits: RawCandidate[] | typeof DEADLINE
  try {
    hits =
      options.deadlineMs === undefined
        ? await hybrid
        : await raceDeadline(hybrid, options.deadlineMs)
  } catch (hybridErr) {
    logger.warn('Hybrid search unavailable, falling back to BM25', {
      error: hybridErr instanceof Error ? hybridErr.message : String(hybridErr),
    })
    return lex()
  }

  if (hits === DEADLINE) {
    logger.warn('Hybrid search missed the daemon deadline, serving BM25', {
      deadlineMs: options.deadlineMs,
    })
    options.onDeadline?.()
    // Let hybrid finish in the background — it is what loads/warms the models.
    hybrid.then(
      (late) => logger.debug('Late hybrid result discarded', { candidates: late.length }),
      (err: unknown) =>
        logger.debug('Late hybrid search failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
    )
    return lex()
  }

  if (hits.length > 0) return hits

  logger.debug('Hybrid returned 0 candidates, trying BM25')
  return lex()
}
