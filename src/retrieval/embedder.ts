// Fire-and-forget trigger for QMD vector embedding generation
import type { QMDStore } from '@tobilu/qmd'

import { createLogger } from '../utils/logger.js'

/**
 * Trigger vector embedding generation for all collections that need it.
 * Returns immediately — the work happens in the background.
 *
 * Call this after writing new turn pair files so QMD can embed them
 * asynchronously without blocking the response stream.
 */
export function triggerTurnEmbedding(store: QMDStore): void {
  const logger = createLogger('retrieval:embedder')

  store
    .embed()
    .then((result) => {
      logger.info('Embedding generation complete', {
        docsProcessed: result.docsProcessed,
        chunksEmbedded: result.chunksEmbedded,
        errors: result.errors,
      })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Embedding generation failed', { error: message })
    })
}
