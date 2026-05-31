// ModelHarness — the model-control run loop (grammar-first, validate + retry, LOUD floor).
// Model-agnostic: depends only on the ModelHandle seam, never on a concrete backend.

import { createLogger } from '../utils/logger.js'
import type { ModelHandle } from './model-handle.js'
import type { HarnessRunOptions, HarnessRunResult, HarnessTask } from './types.js'

type Result<T> = import('../proxy/types.js').Result<T>

const logger = createLogger('harness')

const DEFAULT_MAX_ATTEMPTS = 2
const SNIPPET_LEN = 200

// LOUD floor accounting: a silent floor repeats Bug B, so every floor fall-back
// is both logged AND counted. Dashboard wiring comes later; this module-level
// counter is the T02 seam.
let floorCount = 0

/** Total number of times the harness has fallen back to a task floor. */
export function getHarnessFloorCount(): number {
  return floorCount
}

/** Reset the floor counter (test isolation). */
export function resetHarnessFloorCount(): void {
  floorCount = 0
}

/** Strip markdown code fences (```json ... ```) if present. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m)
  return match ? match[1].trim() : trimmed
}

export class ModelHarness {
  constructor(private readonly handle: ModelHandle) {}

  /**
   * Run a task: generate (grammar-constrained when the handle supports it),
   * parse + validate, retry on failure, then a LOUD floor (or hard fail).
   */
  async run<T>(
    task: HarnessTask<T>,
    prompt: string,
    options: HarnessRunOptions = {},
  ): Promise<Result<HarnessRunResult<T>>> {
    const startedAt = Date.now()
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    let lastConstrained = false

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let generated: { text: string; constrained: boolean }
      try {
        generated = await this.handle.generate(prompt, {
          jsonSchema: task.schema.jsonSchema,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        })
      } catch (err) {
        // Generation/infrastructure failure (model unavailable, upstream error).
        // Distinct from bad model OUTPUT — retry/floor address output quality,
        // not infra, so this is terminal. Surfaced loudly, never silent.
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error('harness generation failed', {
          task: task.name,
          attempt,
          error: error.message,
        })
        return { ok: false, error }
      }

      const { text, constrained } = generated
      lastConstrained = constrained

      let parsed: unknown
      try {
        parsed = JSON.parse(stripCodeFences(text))
      } catch {
        logger.warn('harness attempt failed to parse JSON', {
          task: task.name,
          attempt,
          snippet: text.slice(0, SNIPPET_LEN),
        })
        continue
      }

      const value = task.schema.validate(parsed)
      if (value !== null) {
        return {
          ok: true,
          value: {
            value,
            meta: {
              task: task.name,
              constrained,
              attempts: attempt,
              usedFloor: false,
              latencyMs: Date.now() - startedAt,
            },
          },
        }
      }

      logger.warn('harness attempt failed validation', {
        task: task.name,
        attempt,
        snippet: text.slice(0, SNIPPET_LEN),
      })
    }

    // Attempts exhausted. The floor ONLY fires for a constrained handle: a
    // grammar-constrained model that stutters is recoverable, but an
    // unconstrained model returning the wrong shape is a genuine error we must
    // surface (swallowing it would repeat Bug B). Either branch is LOUD; the
    // harness NEVER fails silently.
    const canFloor = task.floor !== undefined && this.handle.supportsConstraint()
    if (canFloor && task.floor) {
      floorCount += 1
      logger.warn('harness floor used', {
        task: task.name,
        attempts: maxAttempts,
        floorCount,
      })
      return {
        ok: true,
        value: {
          value: task.floor(),
          meta: {
            task: task.name,
            constrained: lastConstrained,
            attempts: maxAttempts,
            usedFloor: true,
            latencyMs: Date.now() - startedAt,
          },
        },
      }
    }

    logger.error('harness exhausted attempts without floor', {
      task: task.name,
      attempts: maxAttempts,
      hadFloor: task.floor !== undefined,
      constrained: this.handle.supportsConstraint(),
    })
    return {
      ok: false,
      error: new Error(
        task.failureMessage ?? `Harness task "${task.name}" failed after ${maxAttempts} attempt(s)`,
      ),
    }
  }
}
