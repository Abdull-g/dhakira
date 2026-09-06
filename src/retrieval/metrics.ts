// Retrieval telemetry (D2, v0.3.1): fail-open is the law at the hook, which also
// makes a slow daemon INVISIBLE — the hook aborts at 1.5 s, exits 0, and the user
// just sees "no memory". These process-local counters make that failure mode
// observable: every recall records its latency, and every time the daemon-side
// hybrid deadline fires (BM25 served instead) the `recallTimeouts` counter
// increments. Surfaced via GET /api/status and `dhakira doctor`.
//
// Pure module state, no I/O, engine-side (no proxy/dashboard imports).

export interface RetrievalMetrics {
  /** Recalls served since the daemon started. */
  recallCount: number
  /** Recalls where hybrid search missed the daemon deadline and BM25 was served. */
  recallTimeouts: number
  /** ISO timestamp of the most recent deadline hit, or null. */
  lastRecallTimeoutAt: string | null
  /** Wall-clock latency of the most recent recall (ms), or null before the first. */
  lastRecallMs: number | null
  /** Slowest recall observed (ms), or null before the first. */
  maxRecallMs: number | null
}

let recallCount = 0
let recallTimeouts = 0
let lastRecallTimeoutAt: string | null = null
let lastRecallMs: number | null = null
let maxRecallMs: number | null = null

/** Record one completed recall search and whether the hybrid deadline fired. */
export function recordRecall(elapsedMs: number, deadlineHit: boolean): void {
  recallCount++
  lastRecallMs = elapsedMs
  maxRecallMs = maxRecallMs === null ? elapsedMs : Math.max(maxRecallMs, elapsedMs)
  if (deadlineHit) {
    recallTimeouts++
    lastRecallTimeoutAt = new Date().toISOString()
  }
}

export function getRetrievalMetrics(): RetrievalMetrics {
  return { recallCount, recallTimeouts, lastRecallTimeoutAt, lastRecallMs, maxRecallMs }
}

/** Test hook — counters are process-local and would otherwise leak across tests. */
export function resetRetrievalMetrics(): void {
  recallCount = 0
  recallTimeouts = 0
  lastRecallTimeoutAt = null
  lastRecallMs = null
  maxRecallMs = null
}
