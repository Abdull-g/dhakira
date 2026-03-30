// Retrieval type definitions
import type { TurnPair as CapturedTurnPair } from '../capture/turns.js'

export type { CapturedTurnPair as TurnPair }

export interface SearchResult {
  /** The content that matched */
  content: string
  /** Which collection it came from */
  source: 'conversations' | 'memories'
  /** Path to the source file */
  filePath: string
  /** Relevance score (0-1) */
  score: number
  /** Additional metadata from the file */
  metadata: Record<string, unknown>
}

export interface SearchOptions {
  /** The search query */
  query: string
  /** Maximum results to return */
  limit?: number
  /** Minimum relevance score */
  minScore?: number
  /** Which collections to search */
  collections?: ('conversations' | 'memories')[]
}

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
  /** Context fingerprint of the current request's system prompt.
   *  Turns sharing this fingerprint receive a 1.5x score multiplier. */
  contextFingerprint?: string
}

export interface TurnSearchResult {
  /** The turn pair that matched */
  turnPair: CapturedTurnPair
  /** Combined relevance + recency score */
  score: number
  /** File path of the source turn pair */
  source: string
}
