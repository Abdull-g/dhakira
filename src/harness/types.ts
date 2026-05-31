// Model-control harness — shared types (model-agnostic, llama-free).

/** A schema the harness validates output against (and constrains generation to, when supported). */
export interface HarnessSchema<T> {
  /** JSON-schema object the handle constrains generation to (GBNF JSON-schema-compatible). */
  jsonSchema: Readonly<Record<string, unknown>>
  /** Validate + coerce parsed JSON into T. Returns null if invalid (triggers retry/floor). */
  validate(parsed: unknown): T | null
}

/** Telemetry about how a single harness run went — feeds dashboard trust UI later. */
export interface HarnessMeta {
  task: string
  /** did we use grammar-constrained generation? */
  constrained: boolean
  /** 1 = clean first try */
  attempts: number
  /** did we fall back to the heuristic floor? */
  usedFloor: boolean
  latencyMs: number
}

export interface HarnessRunResult<T> {
  value: T
  meta: HarnessMeta
}

/** A task definition the harness runs. Prompt is a TUNABLE INPUT here, not the foundation. */
export interface HarnessTask<T> {
  name: string
  schema: HarnessSchema<T>
  /**
   * Optional LOUD heuristic fallback when the model whiffs after retries.
   * ONLY used when the handle supports constraint (a constrained model that
   * stutters is recoverable). An unconstrained model returning the wrong shape
   * is a genuine error and is surfaced, never floored. Omit = hard fail.
   */
  floor?: () => T
  /**
   * Message for the no-floor hard-fail Error, so callers can preserve their
   * existing error strings. Falls back to a generic harness message if omitted.
   */
  failureMessage?: string
}

export interface HarnessRunOptions {
  /** default 2, then floor (or hard-fail if no floor) */
  maxAttempts?: number
  maxTokens?: number
  temperature?: number
}
