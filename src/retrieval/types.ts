// Retrieval type definitions
import type { TurnPair as CapturedTurnPair } from '../capture/turns.js'

export type { CapturedTurnPair as TurnPair }

/**
 * How the project scope is applied to the context ranking axis.
 * - 'boost' (DEFAULT): soft 1.5x for same-project turns; turns from other
 *   projects are kept (unboosted); global memory surfaces everywhere.
 * - 'only' (v0.3.1, audit D15): hard project isolation — same-project turns get
 *   the 1.5x AND turns from OTHER projects are dropped. 'global' turns (e.g.
 *   profile-derived identity) are still kept. With no request scope there is
 *   nothing to isolate to, so it behaves like 'boost'.
 */
export type ScopeMode = 'boost' | 'only'

export interface TurnSearchOptions {
  /** The search query (typically the user's current message) */
  query: string
  /** Maximum number of turn pairs to return */
  limit?: number // default: 8
  /** Minimum relevance score after recency boost (0-1) */
  minScore?: number // default: 0.3
  /** Recency boost factor (0 = no boost, 1 = strong boost) */
  recencyBoost?: number // default: 0.3
  /** Optional date range filter */
  dateRange?: { after?: string; before?: string }
  /** Resolved projectId of the current request (the T07 context axis). Turns sharing
   *  this projectId receive a 1.5x score multiplier — stable across tools and machines,
   *  unlike the demoted system-prompt fingerprint it replaces. "global" never boosts. */
  projectId?: string
  /** Project scoping mode — see ScopeMode. Defaults to 'boost'. */
  scopeMode?: ScopeMode
  /**
   * Override for the daemon-side hybrid deadline (ms). Defaults to
   * HYBRID_DEADLINE_MS (search.ts). Tests and `dhakira doctor` use this; hook
   * traffic never sets it.
   */
  hybridDeadlineMs?: number
}

export interface TurnSearchResult {
  /** The turn pair that matched */
  turnPair: CapturedTurnPair
  /** Combined relevance + recency score */
  score: number
  /** File path of the source turn pair */
  source: string
}
