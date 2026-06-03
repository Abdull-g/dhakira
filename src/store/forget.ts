// Forget (Step 6). Two clearly-separated layers:
//   1. The PURE eligibility core (`isForgetEligible` + policy) — deterministic,
//      NO I/O, NO model. The whole safety model lives here and is exhaustively
//      unit-testable. T04 (tier-policy) decided WHEN a memory becomes
//      forget-ELIGIBLE (`expiresAt`); this decides what ELIGIBLE actually IS.
//   2. The thin ORCHESTRATOR (`runForget`) beside it — enumerate → mark →
//      reindex. Soft-forget only (stamp `forgottenAt`, file kept on disk);
//      NEVER an unlink (Layer 2 / `--purge` is deferred, CP1).
//
// LAPTOP-SAFE: never loads a model. The pure core never touches disk; the
// orchestrator does file enumeration + a single store re-index, nothing more.
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'

import {
  readMemoryExpiresAt,
  readMemoryForgottenAt,
  readMemoryInvalidatedAt,
  readMemorySalience,
  softForgetMemoryFile,
} from '../extraction/runner.js'
import type { SalienceTier } from '../salience/types.js'
import { createLogger } from '../utils/logger.js'

type Result<T> = import('../proxy/types.js').Result<T>

const logger = createLogger('forget')

/** Why a memory was judged forget-eligible (drives the LOUD telemetry). */
export type ForgetReason = 'expired' | 'superseded-aged'

export interface ForgetPolicy {
  /**
   * Grace window (days) a SUPERSEDED source is kept after `invalidatedAt`
   * before becoming forget-eligible — so a bad consolidation can be caught and
   * reversed before its sources are soft-forgotten. The T05→T06 bridge.
   */
  supersededGraceDays: number
}

// Constants are the source of truth (T04 precedent — no decorative config block
// until there's a reader for it).
export const DEFAULT_FORGET_POLICY: ForgetPolicy = {
  supersededGraceDays: 14,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The minimal frontmatter shape eligibility depends on. Read via runner.ts readers (CP3). */
export interface ForgetCandidate {
  expiresAt: Date | null
  invalidatedAt: Date | null
  salienceTier: SalienceTier
  forgottenAt: Date | null
}

/**
 * Decide whether a memory is forget-eligible, and WHY. Pure: same inputs →
 * same output. Returns the reason so every forget can be logged LOUDLY.
 *
 * Eligibility (CP1, locked):
 *   - idempotency: already `forgottenAt` → never re-eligible (a 2nd run forgets 0).
 *   - superseded-aged: `invalidatedAt != null && invalidatedAt < now − grace`.
 *   - expired:        `expiresAt != null && expiresAt < now` (the T04 TTL fired).
 *
 * Hard guards:
 *   - CORE IMMUNITY: a `core`-tier memory is NEVER expiry-eligible — anchored on
 *     `salienceTier === 'core'`, NOT on `expiresAt == null`, so even a core file
 *     with a stray non-null `expiresAt` (data drift) is still protected. Core can
 *     leave ONLY via supersession + grace.
 *   - Pre-T04 backward-compat: a file with no `expiresAt` (→ null) is durable and
 *     is NEVER force-expired (expiry requires `expiresAt != null`).
 *
 * Supersession routes EXCLUSIVELY through grace: a superseded memory
 * (`invalidatedAt != null`) can leave ONLY via superseded-aged, NEVER via expiry
 * — regardless of its own TTL. Grace exists to give us 14 days to catch and
 * reverse a bad consolidation before its sources are retired; letting a fired
 * TTL retire an in-grace source early would defeat that recovery guarantee. A
 * superseded memory is already invisible to read paths, so holding it the full
 * window costs nothing (asymmetry of harm → protect the window).
 */
export function isForgetEligible(
  memory: ForgetCandidate,
  now: Date,
  policy: ForgetPolicy = DEFAULT_FORGET_POLICY,
): { eligible: boolean; reason: ForgetReason | null } {
  // Idempotency: a soft-forgotten memory is already gone — skip it.
  if (memory.forgottenAt !== null) return { eligible: false, reason: null }

  // Supersession is handled EXCLUSIVELY here — a superseded memory never falls
  // through to the expiry path, so an in-grace source is protected from its own
  // fired TTL until the full grace window elapses.
  if (memory.invalidatedAt !== null) {
    const graceCutoff = now.getTime() - policy.supersededGraceDays * MS_PER_DAY
    if (memory.invalidatedAt.getTime() < graceCutoff) {
      return { eligible: true, reason: 'superseded-aged' }
    }
    return { eligible: false, reason: null }
  }

  // Expired by TTL — load-bearing change. Core is immune by tier, never by the
  // accident of a null expiry; durable (null expiresAt) files are never expired.
  if (
    memory.salienceTier !== 'core' &&
    memory.expiresAt !== null &&
    memory.expiresAt.getTime() < now.getTime()
  ) {
    return { eligible: true, reason: 'expired' }
  }

  return { eligible: false, reason: null }
}

// ===========================================================================
// Orchestrator: enumerate → mark → reindex. Soft-forget ONLY (never unlink).
// ===========================================================================

export interface ForgetStats {
  /** Memory files scanned. */
  scanned: number
  /** Memories soft-forgotten this run. */
  forgotten: number
  /** Breakdown of forgotten by eligibility reason. */
  byReason: { expired: number; supersededAged: number }
  /** core-tier memories left untouched by core-immunity (observability of the guard). */
  skippedCore: number
}

/** Re-index the store after mutations (non-fatal on failure — mirrors consolidate/runner). */
async function reindexAfterForget(store: QMDStore): Promise<void> {
  try {
    await store.update()
  } catch (err) {
    logger.warn('QMD re-index after forget failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Enumerate memories/**\/*.md (mirrors loadActiveMemories). null = no memories dir yet. */
async function enumerateMemoryFiles(memoriesDir: string): Promise<string[] | null> {
  try {
    const entries = (await readdir(memoriesDir, { recursive: true })) as string[]
    return entries.filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }
}

/**
 * Evaluate ONE memory file and soft-forget it if eligible, folding the outcome
 * into `stats`. Mutates `stats` in place. Never throws — an unreadable file is
 * skipped (not even counted as scanned); a failed stamp is logged + skipped.
 */
async function forgetOneIfEligible(
  walletDir: string,
  filePath: string,
  memoryId: string,
  now: Date,
  policy: ForgetPolicy,
  stats: ForgetStats,
): Promise<void> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    // Skip unreadable files silently — never abort the sweep on one bad file.
    return
  }

  stats.scanned++
  const { salienceTier } = readMemorySalience(content)
  const { eligible, reason } = isForgetEligible(
    {
      expiresAt: readMemoryExpiresAt(content),
      invalidatedAt: readMemoryInvalidatedAt(content),
      salienceTier,
      forgottenAt: readMemoryForgottenAt(content),
    },
    now,
    policy,
  )

  if (!eligible) {
    // Observability of the core-immunity guard: a core memory we declined to forget.
    if (salienceTier === 'core') stats.skippedCore++
    return
  }

  try {
    await softForgetMemoryFile(walletDir, memoryId)
  } catch (err) {
    logger.warn('soft-forget failed, skipping', {
      id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  stats.forgotten++
  if (reason === 'expired') stats.byReason.expired++
  else if (reason === 'superseded-aged') stats.byReason.supersededAged++
  // LOUD per-memory telemetry (Bug B lesson): id + reason + tier, always.
  logger.info('memory forgotten', { id: memoryId, reason, tier: salienceTier })
}

/**
 * Run one soft-forget sweep over the wallet's slow store.
 * Pipeline:
 *   1. Enumerate memories/**\/*.md (mirrors loadActiveMemories enumeration).
 *   2. Read expiresAt / invalidatedAt / salienceTier / forgottenAt via the
 *      standalone runner.ts readers → isForgetEligible.
 *   3. Eligible → softForgetMemoryFile (stamp `forgottenAt`, file kept on disk).
 *   4. Re-index ONCE at the end if anything changed (non-fatal on failure).
 *
 * LOUD telemetry (Bug B lesson): every forget logs id + reason + tier, and the
 * run prints a summary. Forgetting is NEVER silent. NEVER throws — any failure is
 * captured in the Result (mirrors runConsolidation). An empty store is a clean
 * no-op (scanned = 0). Idempotent: a 2nd back-to-back run forgets 0 (the
 * `forgottenAt` guard in isForgetEligible).
 */
export async function runForget(
  walletDir: string,
  store: QMDStore,
  policy: ForgetPolicy = DEFAULT_FORGET_POLICY,
): Promise<Result<ForgetStats>> {
  try {
    const now = new Date()
    const stats: ForgetStats = {
      scanned: 0,
      forgotten: 0,
      byReason: { expired: 0, supersededAged: 0 },
      skippedCore: 0,
    }

    const memoriesDir = join(walletDir, 'memories')
    const relPaths = await enumerateMemoryFiles(memoriesDir)
    if (relPaths !== null) {
      for (const rel of relPaths) {
        await forgetOneIfEligible(
          walletDir,
          join(memoriesDir, rel),
          basename(rel, '.md'),
          now,
          policy,
          stats,
        )
      }
      if (stats.forgotten > 0) await reindexAfterForget(store)
    }

    logger.info('Forget sweep complete', { ...stats, byReason: { ...stats.byReason } })
    return { ok: true, value: stats }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
