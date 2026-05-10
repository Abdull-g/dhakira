// Capture-driven auto-extraction trigger.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'

import type { WalletConfig } from '../config/schema.js'
import { createLogger } from '../utils/logger.js'
import { runExtraction } from './runner.js'

const STATE_FILE = '.extraction-state.json'
const FIRST_RUN_THRESHOLD = 10
const SUBSEQUENT_RUN_THRESHOLD = 50

let capturedSinceLastTrigger = 0
let cachedLastRunAt: string | null | undefined
let isExtractionRunning = false
let pendingFollowUp = false

interface ExtractionState {
  lastRunAt: string | null
}

/**
 * Maybe start profile extraction after enough captured turns have accumulated.
 *
 * This function is intentionally process-local: it debounces captures with an
 * in-memory counter, runs at most one extraction at a time, and coalesces any
 * triggers that arrive while extraction is active into one follow-up run.
 */
export async function maybeTriggerExtraction(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig,
): Promise<void> {
  await loadCachedState(walletDir)

  if (isExtractionRunning) {
    pendingFollowUp = true
    return
  }

  capturedSinceLastTrigger++
  const threshold = cachedLastRunAt === null ? FIRST_RUN_THRESHOLD : SUBSEQUENT_RUN_THRESHOLD
  if (capturedSinceLastTrigger < threshold) return

  capturedSinceLastTrigger = 0

  await runExtractionWithLock(walletDir, store, config)
}

async function loadCachedState(walletDir: string): Promise<void> {
  if (cachedLastRunAt !== undefined) return

  try {
    const raw = await readFile(join(walletDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as ExtractionState
    cachedLastRunAt = parsed.lastRunAt ?? null
  } catch {
    cachedLastRunAt = null
  }
}

async function runExtractionWithLock(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig,
): Promise<void> {
  const logger = createLogger('extraction:trigger')
  isExtractionRunning = true

  try {
    const result = await runExtraction(walletDir, store, config.extraction)
    if (result.ok) {
      cachedLastRunAt = new Date().toISOString()
    } else {
      logger.warn('Auto-extraction failed', { error: result.error.message })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('Auto-extraction failed', { error: message })
  } finally {
    isExtractionRunning = false

    if (pendingFollowUp) {
      pendingFollowUp = false
      await runExtractionWithLock(walletDir, store, config)
    }
  }
}
