// Direct SQLite document registration — bypasses QMD's filesystem scan.
//
// Why this exists:
// QMD's store.update() scans the entire collection directory to find new files.
// That's O(n) per call — fine for batch operations, but wasteful in the proxy
// hot path where we just wrote a single file. This module registers documents
// directly into QMD's SQLite tables, making them instantly BM25-searchable via
// the FTS5 trigger that fires on INSERT.
//
// How it stays in sync with QMD:
// We use the exact same algorithms QMD uses internally for path normalization
// (handelize), content hashing (SHA-256), and title extraction. Background
// reconciliation (store.update) runs periodically as a safety net to catch
// manual edits, deletions, or crash-recovery missed inserts.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'

import { createLogger } from '../utils/logger.js'

const logger = createLogger('retrieval:indexer')

// ---------------------------------------------------------------------------
// QMD-compatible utility functions
//
// These replicate the exact logic from QMD's store.js so our direct inserts
// produce the same database paths as store.update(). Verified by tests that
// compare output against QMD's own functions.
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of content, returned as hex string.
 * Matches QMD's hashContent() exactly.
 */
export async function hashContent(content: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Extract a title from markdown content.
 * Matches QMD's extractTitle() for .md files: returns the first ## or # heading.
 * Falls back to the filename (without extension) if no heading found.
 */
export function extractTitle(content: string, filename: string): string {
  const match = content.match(/^##?\s+(.+)$/m)
  if (match?.[1]) {
    return match[1].trim()
  }
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .split('/')
      .pop() || filename
  )
}

/**
 * Convert Unicode emoji to hex codepoints.
 * Matches QMD's internal emojiToHex() helper.
 */
function emojiToHex(segment: string): string {
  return segment.replace(
    /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}]/gu,
    (ch) => {
      const cp = ch.codePointAt(0)
      return cp !== undefined ? `u${cp.toString(16)}` : ch
    },
  )
}

/**
 * Normalize a file path for QMD's documents table.
 * Matches QMD's handelize() exactly: lowercases, replaces special chars with
 * dashes, preserves directory structure and file extensions.
 *
 * This is the most critical function for correctness — if our path doesn't
 * match what store.update() produces, we get duplicate index entries.
 */
export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty')
  }

  const segments = path.split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1] || ''
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '')
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt)
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`)
  }

  const result = path
    .replace(/___/g, '/') // Triple underscore becomes folder separator
    .toLowerCase()
    .split('/')
    .map((segment: string, idx: number, arr: string[]) => {
      const isLastSegment = idx === arr.length - 1

      // Convert emoji to hex codepoints before cleaning
      segment = emojiToHex(segment)

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i)
        const ext = extMatch ? extMatch[1] : ''
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment
        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-') // Keep route marker "$", dash-separate
          .replace(/^-+|-+$/g, '') // Remove leading/trailing dashes
        return cleanedName + ext
      } else {
        // For directories, just clean normally
        return segment.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '')
      }
    })
    .filter(Boolean)
    .join('/')

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Direct indexing
// ---------------------------------------------------------------------------

/**
 * Compute the QMD-compatible relative path for a turn pair file.
 *
 * QMD's reindexCollection scans from the collection root ({walletDir}/turns/)
 * and gets relative paths like "2026-03-27/conv_abc123-0.md". It then passes
 * those through handelize() to produce the DB path.
 *
 * We replicate this: given the absolute filePath and the walletDir, extract
 * the portion after "{walletDir}/turns/" and handelize it.
 */
function computeRelativePath(filePath: string, walletDir: string): string {
  const turnsRoot = join(walletDir, 'turns') + '/'
  const relative = filePath.startsWith(turnsRoot) ? filePath.slice(turnsRoot.length) : filePath
  return relative
}

/**
 * Register a single turn pair directly into QMD's SQLite index.
 *
 * This makes the document instantly searchable via BM25 (FTS5 trigger fires
 * on INSERT). Vector embeddings are generated later by the background
 * reconciliation job.
 *
 * @param store - The QMD store (we access store.internal for direct DB writes)
 * @param filePath - Absolute path to the .md file on disk
 * @param content - The full markdown content of the turn pair file
 * @param walletDir - The wallet directory root (needed to compute relative path)
 */
export async function indexTurnPair(
  store: QMDStore,
  filePath: string,
  content: string,
  walletDir: string,
): Promise<void> {
  const internal = store.internal

  const relativePath = computeRelativePath(filePath, walletDir)
  const dbPath = handelize(relativePath)
  const hash = await hashContent(content)
  const title = extractTitle(content, relativePath)
  const now = new Date().toISOString()

  // Check if already indexed (idempotent — safe if background reconciliation ran first)
  const existing = internal.findActiveDocument('turns', dbPath)
  if (existing && existing.hash === hash) {
    logger.debug('Turn pair already indexed, skipping', { path: dbPath })
    return
  }

  // Register content (content-addressable — INSERT OR IGNORE on duplicate hash)
  internal.insertContent(hash, content, now)

  // Register document (ON CONFLICT updates — idempotent with store.update())
  internal.insertDocument('turns', dbPath, title, hash, now, now)

  logger.info('Turn pair indexed directly', { path: dbPath, hash: hash.slice(0, 8) })
}

/**
 * Run background reconciliation: full filesystem scan + vector embedding.
 *
 * This catches:
 * - Turn pairs written to disk but missed by indexTurnPair (crash recovery)
 * - Manually edited or deleted files
 * - External changes to the wallet directory
 *
 * Also generates vector embeddings for any documents that don't have them yet,
 * upgrading those documents from BM25-only to full hybrid search.
 */
export async function reconcile(store: QMDStore): Promise<void> {
  const startTime = Date.now()

  try {
    const updateResult = await store.update({ collections: ['turns'] })
    logger.info('Reconciliation scan complete', {
      indexed: updateResult.indexed,
      updated: updateResult.updated,
      removed: updateResult.removed,
      unchanged: updateResult.unchanged,
      needsEmbedding: updateResult.needsEmbedding,
      durationMs: Date.now() - startTime,
    })

    if (updateResult.needsEmbedding > 0) {
      const embedStart = Date.now()
      const embedResult = await store.embed()
      logger.info('Embedding generation complete', {
        docsProcessed: embedResult.docsProcessed,
        chunksEmbedded: embedResult.chunksEmbedded,
        errors: embedResult.errors,
        durationMs: Date.now() - embedStart,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Reconciliation failed', { error: message })
  }
}

// ---------------------------------------------------------------------------
// Reconciliation scheduler
// ---------------------------------------------------------------------------

let reconciliationTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start periodic background reconciliation.
 *
 * Runs an initial reconciliation immediately (catches any turns from a previous
 * session that weren't embedded), then repeats on the given interval.
 *
 * Also serves as the model warm-up path: the first embed() call loads the
 * embedding model into memory, so subsequent hybrid searches are fast.
 *
 * @param store - The QMD store
 * @param intervalMs - How often to reconcile (default: 5 minutes)
 */
export function startReconciliation(store: QMDStore, intervalMs: number = 5 * 60 * 1000): void {
  // Run immediately on startup (async, non-blocking)
  reconcile(store).catch(() => {})

  reconciliationTimer = setInterval(() => {
    reconcile(store).catch(() => {})
  }, intervalMs)

  logger.info('Background reconciliation started', { intervalMs })
}

/**
 * Stop periodic background reconciliation.
 */
export function stopReconciliation(): void {
  if (reconciliationTimer !== null) {
    clearInterval(reconciliationTimer)
    reconciliationTimer = null
    logger.info('Background reconciliation stopped')
  }
}
