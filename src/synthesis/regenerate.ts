// Scoped project-doc rebuild trigger (T08, CP4). Runs after extraction, AFTER
// regenerateProfile (global), to rebuild ONLY the project docs whose memories
// changed this batch — the touched-set threaded from the runner, NOT every bucket.
//
// FRESHNESS BY REBUILD: each touched project's doc is re-synthesized from its
// CURRENT live memory set (forgotten/superseded already excluded by collect), so
// the always-injected doc never goes stale. A project that emptied out has its
// doc REMOVED (a stale doc is worse than none).
//
// WARM HANDLE: one buildExtractionHarness(config) over the cached extractor
// singleton, shared across all project syntheses — never a second model.
//
// NON-FATAL + LOUD: a synthesis failure for one project never aborts extraction
// or the other projects; every regen is logged + counted.
//
// STANDING ORDER #7: imports nothing from src/proxy/ or src/dashboard/.

import { join } from 'node:path'

import type { WalletConfig } from '../config/schema.js'
import { buildExtractionHarness } from '../extraction/extract.js'
import { createLogger } from '../utils/logger.js'
import { collectScopedMemories } from './collect.js'
import { removeProjectDoc, writeProjectDoc } from './project-doc.js'
import { synthesizeProjectDoc } from './synthesize.js'

const logger = createLogger('synthesis')
const GLOBAL_PROJECT_ID = 'global'

/**
 * Regenerate the project docs for exactly the touched (non-global) projectIds.
 * Global is handled by regenerateProfile; this is the scoped per-project layer.
 */
export async function regenerateProjectDocs(
  walletDir: string,
  config: WalletConfig['extraction'],
  touchedProjectIds: Iterable<string>,
): Promise<void> {
  // Unique, non-global. Global is the profile.md path, not a project doc.
  const targets = [...new Set(touchedProjectIds)].filter(
    (id) => id.length > 0 && id !== GLOBAL_PROJECT_ID,
  )
  if (targets.length === 0) return

  const collected = await collectScopedMemories(join(walletDir, 'memories'))
  if (!collected.ok) {
    logger.warn('project-doc regen skipped: memory collection failed', {
      error: collected.error.message,
      targets: targets.length,
    })
    return
  }
  const buckets = collected.value

  const harness = buildExtractionHarness(config)
  let written = 0
  let removed = 0

  for (const projectId of targets) {
    try {
      const bucket = buckets.get(projectId) ?? []
      const doc = await synthesizeProjectDoc(bucket, harness)
      if (doc === null) {
        // No eligible live memories (or flat-also-empty) → drop the stale doc.
        await removeProjectDoc(walletDir, projectId)
        removed += 1
      } else {
        await writeProjectDoc(walletDir, projectId, doc)
        written += 1
      }
    } catch (err) {
      logger.warn('project-doc regen failed for one project (non-fatal)', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('project docs regenerated', { targets: targets.length, written, removed })
}
