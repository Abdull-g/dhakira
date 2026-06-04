// Extraction type definitions

import type { SalienceScore, SalienceTier } from '../salience/types.js'

export interface ExtractedFact {
  /** The fact text */
  text: string
  /** Category of this fact */
  category: 'IDENTITY' | 'PREFERENCE' | 'CONTEXT' | 'RELATIONSHIP' | 'SKILL' | 'EVENT'
  /** How confident we are */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

/**
 * An ExtractedFact enriched with salience. ExtractedFact stays the model's raw
 * extraction output; salience is added as a separate enrichment stage and rides
 * WITH the fact through the pipeline (processUpdates → factToMemory).
 */
export interface ScoredFact extends ExtractedFact {
  salience: SalienceScore
}

export type UpdateAction =
  | { action: 'ADD'; fact: ExtractedFact }
  | { action: 'UPDATE'; fact: ExtractedFact; targetId: string }
  | { action: 'INVALIDATE'; fact: ExtractedFact; targetId: string }
  | { action: 'NOOP'; reason: string }

export interface ExtractionResult {
  /** Extracted facts from this conversation */
  facts: ExtractedFact[]
  /** Summary update for rolling context */
  summaryUpdate: string
  /** Which conversation this was extracted from */
  conversationId: string
}

export interface MemoryRecord {
  /** Unique memory ID */
  id: string
  /** The memory text */
  text: string
  /** Category */
  category: ExtractedFact['category']
  /** Confidence level */
  confidence: ExtractedFact['confidence']
  /** Intrinsic importance 0..1 (computed once at extraction, stored on the memory). */
  salienceScore: number
  /** Coarse salience tier (Step 4 two-tier store consumes this later). */
  salienceTier: SalienceTier
  /** Source conversation ID */
  source: string
  /**
   * T07 context axis (T08): the project this memory belongs to, threaded from the
   * source conversation's resolved projectId. 'global' = cross-project identity
   * (the default). Drives projectId-scoped synthesis. Emitted to frontmatter only
   * when non-global, so global memories stay byte-identical to pre-T08.
   */
  projectId: string
  /** When this memory was created */
  createdAt: Date
  /** When the fact became true */
  validFrom: Date
  /** When this was invalidated (null if still valid) */
  invalidatedAt: Date | null
  /** When this memory becomes forget-eligible (Step 6). null = durable. */
  expiresAt: Date | null
  /** True if this memory was produced by a consolidation sweep (Step 5). Absent on all pre-T05 memories. */
  consolidated?: boolean
  /** When this memory was soft-forgotten (Step 6). Absent/null = active. Only emitted once set, so untouched files stay byte-identical. */
  forgottenAt?: Date | null
}
