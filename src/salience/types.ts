// Salience type definitions — the engine's judgment of how intrinsically
// important a memory is. Computed once at extraction (model warm), stored on
// the memory, never recomputed on the retrieval hot path.

export type SalienceTier = 'core' | 'standard' | 'trivia'

export interface SalienceScore {
  /** 0..1 intrinsic importance. */
  score: number
  /** Coarse tier (Step 4 two-tier store consumes this later). */
  tier: SalienceTier
  /** One-line model rationale (or 'heuristic floor' when floored). */
  reason: string
}
