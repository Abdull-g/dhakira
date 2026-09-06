// Capture-driven auto-extraction trigger.
import { readFile, writeFile } from 'node:fs/promises'
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
  /**
   * v0.3.1 (audit D14): the capture counter is PERSISTED alongside the runner's
   * state so a daemon restart does not reset it — before this, a wallet that was
   * restarted every few turns could sit just under the threshold forever.
   */
  capturedSinceLastTrigger?: number
}

/**
 * Maybe start profile extraction after enough captured turns have accumulated.
 *
 * Debounces captures with a counter (in memory, mirrored to .extraction-state.json),
 * runs at most one extraction at a time, and coalesces any triggers that arrive
 * while extraction is active into one follow-up run.
 */
export async function maybeTriggerExtraction(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig,
): Promise<void> {
  const logger = createLogger('extraction:trigger')
  logger.info('Auto-extract trigger invoked', {
    captured: capturedSinceLastTrigger,
    lastRunAt: cachedLastRunAt ?? 'unknown',
  })

  await loadCachedState(walletDir)

  if (isExtractionRunning) {
    pendingFollowUp = true
    return
  }

  capturedSinceLastTrigger++
  const threshold = cachedLastRunAt === null ? FIRST_RUN_THRESHOLD : SUBSEQUENT_RUN_THRESHOLD
  if (capturedSinceLastTrigger < threshold) {
    await persistCounter(walletDir)
    return
  }

  capturedSinceLastTrigger = 0
  // Kick extraction off FIRST (the lock flips synchronously), then mirror the
  // reset counter to disk while it runs.
  const running = runExtractionWithLock(walletDir, store, config)
  await persistCounter(walletDir)
  await running
}

async function loadCachedState(walletDir: string): Promise<void> {
  if (cachedLastRunAt !== undefined) return

  try {
    const raw = await readFile(join(walletDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as ExtractionState
    cachedLastRunAt = parsed.lastRunAt ?? null
    // Resume the counter from disk on the first trigger after a (re)start.
    if (
      typeof parsed.capturedSinceLastTrigger === 'number' &&
      parsed.capturedSinceLastTrigger > 0
    ) {
      capturedSinceLastTrigger = Math.max(capturedSinceLastTrigger, parsed.capturedSinceLastTrigger)
    }
  } catch {
    cachedLastRunAt = null
  }
}

/** Serializes the read-modify-write below so concurrent captures never interleave. */
let persistChain: Promise<void> = Promise.resolve()

/**
 * Mirror the in-memory counter to the state file. Read-modify-write so the
 * runner's fields (processed ids, rolling summary, lastRunAt) are preserved; the
 * runner's own saveState preserves this field in return. Fire-and-forget from
 * the capture path (never delays a capture or the extraction kick-off) and best
 * effort — a failed write only costs restart-resilience. Returns the chain so
 * callers that need the file settled (tests) can await it.
 */
function persistCounter(walletDir: string): Promise<void> {
  const value = capturedSinceLastTrigger
  persistChain = persistChain.then(async () => {
    const path = join(walletDir, STATE_FILE)
    try {
      let current: Record<string, unknown> = {}
      try {
        current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      } catch {
        // No state file yet — write a minimal one.
      }
      current.capturedSinceLastTrigger = value
      if (current.lastRunAt === undefined) current.lastRunAt = null
      await writeFile(path, JSON.stringify(current, null, 2), 'utf8')
    } catch (err) {
      // Best effort: losing this write only costs restart-resilience of the counter.
      createLogger('extraction:trigger').debug('Could not persist capture counter', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return persistChain
}

/** Await any in-flight counter persistence (tests / graceful shutdown). */
export function flushTriggerState(): Promise<void> {
  return persistChain
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
