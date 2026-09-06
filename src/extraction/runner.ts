// Orchestrate the full nightly extraction pipeline

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { parse } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import { clampScore, heuristicSalience } from '../salience/heuristic.js'
import { scoreSalience } from '../salience/salience.js'
import type { SalienceTier } from '../salience/types.js'
import { computeExpiresAt } from '../store/tier-policy.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { buildExtractionHarness, extractFacts } from './extract.js'
import { regenerateProfile } from './profile-gen.js'
import {
  cleanSessionContent,
  hasSubstantiveContent,
  reconstructSessions,
  type SessionFile,
} from './session-reconstructor.js'
import type { ExtractedFact, MemoryRecord, ScoredFact, UpdateAction } from './types.js'
import { processUpdates } from './update.js'

type Result<T> = import('../proxy/types.js').Result<T>

export interface ExtractionStats {
  conversationsProcessed: number
  factsExtracted: number
  memoriesCreated: number
  memoriesUpdated: number
  memoriesInvalidated: number
  memoriesNoop: number
}

interface ExtractionState {
  processedConversationIds: string[]
  rollingSummary: string
  lastRunAt: string | null
  /** Owned by trigger.ts (D14) — preserved here so a save never resets it. */
  capturedSinceLastTrigger?: number
}

interface ConvFrontmatter {
  id: string
  incognito: boolean
  timestamp: string
  projectId: string
}

const STATE_FILE = '.extraction-state.json'
const EMPTY_STATE: ExtractionState = {
  processedConversationIds: [],
  rollingSummary: '',
  lastRunAt: null,
}

async function loadState(walletDir: string): Promise<ExtractionState> {
  try {
    const raw = await readFile(join(walletDir, STATE_FILE), 'utf8')
    // The trigger may have created a minimal file (counter only) before the first
    // run — fill any missing runner fields from the empty state.
    const parsed = JSON.parse(raw) as Partial<ExtractionState>
    return {
      ...EMPTY_STATE,
      ...parsed,
      processedConversationIds: Array.isArray(parsed.processedConversationIds)
        ? parsed.processedConversationIds
        : [],
      rollingSummary: typeof parsed.rollingSummary === 'string' ? parsed.rollingSummary : '',
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function saveState(walletDir: string, state: ExtractionState): Promise<void> {
  // Preserve the trigger's capture counter as it is ON DISK right now (captures
  // may have arrived during this run), not the value loaded at run start.
  const onDisk = await loadState(walletDir)
  const merged: ExtractionState = {
    ...state,
    ...(onDisk.capturedSinceLastTrigger === undefined
      ? {}
      : { capturedSinceLastTrigger: onDisk.capturedSinceLastTrigger }),
  }
  await writeFile(join(walletDir, STATE_FILE), JSON.stringify(merged, null, 2), 'utf8')
}

function parseConvFrontmatter(content: string): ConvFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    return {
      id: String(parsed.id ?? ''),
      incognito: Boolean(parsed.incognito),
      timestamp: String(parsed.timestamp ?? new Date().toISOString()),
      // Backward-compat: pre-T08 conversations have no projectId line → 'global'
      // (mirrors loader.ts:41 / turns.ts default). Never break on old files.
      projectId: parsed.projectId ? String(parsed.projectId) : 'global',
    }
  } catch {
    return null
  }
}

function countMessages(content: string): number {
  return (content.match(/^## (User|Assistant)$/gm) ?? []).length
}

export function buildMemoryContent(memory: MemoryRecord): string {
  const lines = [
    '---',
    `id: ${memory.id}`,
    `category: ${memory.category}`,
    `confidence: ${memory.confidence}`,
    `salienceScore: ${memory.salienceScore}`,
    `salienceTier: ${memory.salienceTier}`,
    `source: ${memory.source}`,
    `createdAt: ${memory.createdAt.toISOString()}`,
    `validFrom: ${memory.validFrom.toISOString()}`,
    `invalidatedAt: ${memory.invalidatedAt ? memory.invalidatedAt.toISOString() : 'null'}`,
    `expiresAt: ${memory.expiresAt ? memory.expiresAt.toISOString() : 'null'}`,
  ]
  // Additive + backward-compat (T08): only EMIT projectId when it resolved to a
  // real scope, so a 'global' memory produces byte-identical frontmatter to
  // pre-T08 (same discipline as consolidated/forgottenAt below).
  if (memory.projectId && memory.projectId !== 'global') {
    lines.push(`projectId: ${memory.projectId}`)
  }
  // Additive + backward-compat: only EMIT this line when true, so a normal
  // (non-consolidated) memory produces byte-identical frontmatter to pre-T05.
  if (memory.consolidated) lines.push('consolidated: true')
  // Additive + backward-compat (T06): only EMIT when soft-forgotten, so an
  // active memory produces byte-identical frontmatter to pre-T06.
  if (memory.forgottenAt) lines.push(`forgottenAt: ${memory.forgottenAt.toISOString()}`)
  lines.push('---')
  return `${lines.join('\n')}\n\n${memory.text}`
}

const DEFAULT_SALIENCE_SCORE = 0.5
const DEFAULT_SALIENCE_TIER: SalienceTier = 'standard'
const SALIENCE_TIERS: readonly SalienceTier[] = ['core', 'standard', 'trivia']

/**
 * Read salience from a memory file's frontmatter. Backward-compatible (REQUIRED):
 * OLD memory files written before salience existed have no salience lines, so
 * they default to a neutral 0.5 / 'standard' rather than failing to parse.
 * (Step 4's two-tier store will consume this; exposed now for that + tests.)
 */
export function readMemorySalience(content: string): {
  salienceScore: number
  salienceTier: SalienceTier
} {
  const fallback = { salienceScore: DEFAULT_SALIENCE_SCORE, salienceTier: DEFAULT_SALIENCE_TIER }
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return fallback
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    const rawScore = Number(parsed.salienceScore)
    const salienceScore = Number.isFinite(rawScore) ? clampScore(rawScore) : DEFAULT_SALIENCE_SCORE
    const rawTier = String(parsed.salienceTier ?? '')
    const salienceTier = SALIENCE_TIERS.includes(rawTier as SalienceTier)
      ? (rawTier as SalienceTier)
      : DEFAULT_SALIENCE_TIER
    return { salienceScore, salienceTier }
  } catch {
    return fallback
  }
}

/**
 * Read expiresAt from a memory file's frontmatter. Backward-compatible:
 * memory files written before T04 have no expiresAt line → null (durable).
 * Step 6 (Forget) consumes this; exposed now for that + tests.
 */
export function readMemoryExpiresAt(content: string): Date | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    if (parsed.expiresAt === null || parsed.expiresAt === undefined) return null
    const raw = String(parsed.expiresAt)
    if (raw === 'null' || raw === '') return null
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * Read invalidatedAt from a memory file's frontmatter. Backward-compatible:
 * memory files with no/`null`/empty invalidatedAt → null (still active). Mirrors
 * readMemoryExpiresAt's null/'null'/empty handling. Step 6 (Forget) consumes
 * this for the superseded-aged eligibility path; exposed standalone (NOT reusing
 * the inline parse paths in consolidate.ts/profile-gen.ts) so the reader stays
 * clean and independently unit-tested.
 */
export function readMemoryInvalidatedAt(content: string): Date | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    if (parsed.invalidatedAt === null || parsed.invalidatedAt === undefined) return null
    const raw = String(parsed.invalidatedAt)
    if (raw === 'null' || raw === '') return null
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * Read forgottenAt from a memory file's frontmatter. Backward-compatible:
 * memory files with no/`null`/empty forgottenAt → null (still active). Mirrors
 * readMemoryExpiresAt's null/'null'/empty handling. Step 6 (Forget) consumes
 * this for the idempotency guard AND the read-path active filters.
 */
export function readMemoryForgottenAt(content: string): Date | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    if (parsed.forgottenAt === null || parsed.forgottenAt === undefined) return null
    const raw = String(parsed.forgottenAt)
    if (raw === 'null' || raw === '') return null
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * Read the `consolidated` marker from a memory file's frontmatter. Backward-
 * compatible: pre-T05 memory files have no such line → false. Only the literal
 * `true` counts. Consumed by consolidation's loadActiveMemories (idempotency).
 */
export function readMemoryConsolidated(content: string): boolean {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return false
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    return parsed.consolidated === true || String(parsed.consolidated ?? '') === 'true'
  } catch {
    return false
  }
}

export async function writeMemoryFile(walletDir: string, memory: MemoryRecord): Promise<void> {
  const memoriesDir = join(walletDir, 'memories')
  await mkdir(memoriesDir, { recursive: true })
  await writeFile(join(memoriesDir, `${memory.id}.md`), buildMemoryContent(memory), 'utf8')
}

export async function invalidateMemoryFile(walletDir: string, memoryId: string): Promise<void> {
  const filePath = join(walletDir, 'memories', `${memoryId}.md`)
  const content = await readFile(filePath, 'utf8')
  const updated = content.replace(
    /^invalidatedAt: null$/m,
    `invalidatedAt: ${new Date().toISOString()}`,
  )
  await writeFile(filePath, updated, 'utf8')
}

/**
 * Soft-forget a memory file (Step 6): additively stamp a `forgottenAt: <iso>`
 * line as the LAST frontmatter line. Sibling of invalidateMemoryFile — reversible
 * (stamp, file kept on disk), NEVER an unlink. Additive + backward-compat: files
 * never soft-forgotten have no `forgottenAt` line and stay byte-identical.
 *
 * The pattern is anchored to the document-opening frontmatter block (`^---\n` +
 * lazy `[\s\S]*?` stopping at the first closing `---`), so it stamps the last
 * frontmatter line regardless of body content. This STRUCTURALLY can't corrupt
 * the body — a `---` markdown horizontal rule in the text cannot be mistaken for
 * the frontmatter fence. If the pattern doesn't match (malformed/missing
 * frontmatter), we do NOT write: warn + skip, so we never mangle a file we don't
 * understand. Caller guarantees idempotency (isForgetEligible skips
 * already-forgotten), mirroring invalidateMemoryFile.
 *
 * NOTE(future pass): invalidateMemoryFile has the same theoretical fragility
 * (an unanchored `^invalidatedAt: null$` line match) — out of scope for T06; flag
 * for a later hardening pass.
 */
export async function softForgetMemoryFile(walletDir: string, memoryId: string): Promise<void> {
  const filePath = join(walletDir, 'memories', `${memoryId}.md`)
  const content = await readFile(filePath, 'utf8')
  const pattern = /^(---\n[\s\S]*?\n)---\n/
  if (!pattern.test(content)) {
    createLogger('extraction').warn('soft-forget skipped: no parseable frontmatter', {
      id: memoryId,
    })
    return
  }
  const updated = content.replace(pattern, `$1forgottenAt: ${new Date().toISOString()}\n---\n`)
  await writeFile(filePath, updated, 'utf8')
}

function factToMemory(
  fact: ExtractedFact,
  sourceId: string,
  convTimestamp: Date,
  projectId: string,
): MemoryRecord {
  // Salience rides on the fact as a ScoredFact through processUpdates. Defensive
  // default: if an unscored fact ever reaches storage, fall back to the
  // deterministic heuristic so we NEVER persist an undefined salience.
  const salience = (fact as ScoredFact).salience ?? heuristicSalience(fact)
  // Compute createdAt ONCE so the stored field and the expiry derived from it
  // are consistent (no second new Date() drift).
  const createdAt = new Date()
  // TODO(T06): thread config.store TTLs once forgetting enforces expiry (constants are the source until then)
  return {
    id: generateId('mem'),
    text: fact.text,
    category: fact.category,
    confidence: fact.confidence,
    salienceScore: salience.score,
    salienceTier: salience.tier,
    source: sourceId,
    projectId,
    createdAt,
    validFrom: convTimestamp,
    invalidatedAt: null,
    expiresAt: computeExpiresAt(salience.tier, createdAt),
  }
}

async function applyActions(
  walletDir: string,
  actions: UpdateAction[],
  sourceId: string,
  convTimestamp: Date,
  projectId: string,
  stats: ExtractionStats,
): Promise<void> {
  const logger = createLogger('extraction')

  for (const action of actions) {
    try {
      if (action.action === 'ADD') {
        const memory = factToMemory(action.fact, sourceId, convTimestamp, projectId)
        await writeMemoryFile(walletDir, memory)
        stats.memoriesCreated++
      } else if (action.action === 'UPDATE') {
        await invalidateMemoryFile(walletDir, action.targetId)
        const memory = factToMemory(action.fact, sourceId, convTimestamp, projectId)
        await writeMemoryFile(walletDir, memory)
        stats.memoriesUpdated++
      } else if (action.action === 'INVALIDATE') {
        await invalidateMemoryFile(walletDir, action.targetId)
        stats.memoriesInvalidated++
      } else {
        stats.memoriesNoop++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('Failed to apply memory action, skipping', {
        action: action.action,
        error: message,
      })
    }
  }
}

interface ConversationContext {
  walletDir: string
  store: QMDStore
  config: WalletConfig['extraction']
  existingProfile: string
}

interface ConversationResult {
  /** Whether the extraction LLM call succeeded (vs rate limit, auth error, etc.) */
  succeeded: boolean
  rollingSummary: string
  stats: Partial<ExtractionStats>
  /** The projectId this conversation's memories belong to (T08 scoped trigger). */
  projectId: string
  /** Whether this conversation actually created/updated/invalidated any memory. */
  changedMemories: boolean
}

/** Process a single session file: clean, extract facts, decide actions, write memories */
async function processConversation(
  session: SessionFile,
  rollingSummary: string,
  ctx: ConversationContext,
): Promise<ConversationResult | null> {
  const logger = createLogger('extraction')
  let rawContent: string
  if (session.content !== undefined) {
    // Synthetic hook session (D1): assembled in memory from several one-turn
    // archives — there is no single file to read.
    rawContent = session.content
  } else {
    try {
      rawContent = await readFile(session.filePath, 'utf8')
    } catch {
      return null
    }
  }

  const fm = parseConvFrontmatter(rawContent)
  if (!fm?.id || fm.incognito) return null

  // Clean the session: strip system boilerplate, injection tags, empty messages
  const cleanedContent = cleanSessionContent(rawContent)

  // Skip if no substantive user content after cleaning
  if (!hasSubstantiveContent(cleanedContent)) return null

  logger.info('Processing session', { id: fm.id, chars: cleanedContent.length })
  const convTimestamp = new Date(fm.timestamp)

  const extractResult = await extractFacts(
    cleanedContent,
    ctx.existingProfile,
    rollingSummary,
    ctx.config,
    fm.id,
    fm.timestamp.split('T')[0],
  )
  if (!extractResult.ok) {
    logger.warn('Extraction failed', { id: fm.id, error: extractResult.error.message })
    // Return succeeded: false so the caller knows NOT to mark this as processed
    return {
      succeeded: false,
      rollingSummary,
      stats: {},
      projectId: fm.projectId,
      changedMemories: false,
    }
  }

  const { facts, summaryUpdate } = extractResult.value
  const partialStats: Partial<ExtractionStats> = { factsExtracted: facts.length }

  if (facts.length > 0) {
    // Score salience ONCE per fact, at extraction time while the model is warm,
    // through the SAME harness/handle extraction uses (no second model). The
    // salience rides WITH each fact (ScoredFact) so it survives the dedup/reorder
    // in processUpdates and arrives intact at factToMemory.
    const harness = buildExtractionHarness(ctx.config)
    const scoredFacts: ScoredFact[] = []
    for (const fact of facts) {
      const salience = await scoreSalience(fact, harness)
      scoredFacts.push({ ...fact, salience })
    }

    const updateResult = await processUpdates(scoredFacts, ctx.store, ctx.config)
    if (updateResult.ok) {
      const actionStats: ExtractionStats = {
        conversationsProcessed: 0,
        factsExtracted: 0,
        memoriesCreated: 0,
        memoriesUpdated: 0,
        memoriesInvalidated: 0,
        memoriesNoop: 0,
      }
      await applyActions(
        ctx.walletDir,
        updateResult.value,
        fm.id,
        convTimestamp,
        fm.projectId,
        actionStats,
      )
      partialStats.memoriesCreated = actionStats.memoriesCreated
      partialStats.memoriesUpdated = actionStats.memoriesUpdated
      partialStats.memoriesInvalidated = actionStats.memoriesInvalidated
      partialStats.memoriesNoop = actionStats.memoriesNoop
    } else {
      logger.warn('processUpdates failed', { id: fm.id, error: updateResult.error.message })
    }
  }

  const changedMemories =
    (partialStats.memoriesCreated ?? 0) +
      (partialStats.memoriesUpdated ?? 0) +
      (partialStats.memoriesInvalidated ?? 0) >
    0

  return {
    succeeded: true,
    rollingSummary: summaryUpdate,
    stats: partialStats,
    projectId: fm.projectId,
    changedMemories,
  }
}

function mergeStats(into: ExtractionStats, partial: Partial<ExtractionStats>): void {
  into.factsExtracted += partial.factsExtracted ?? 0
  into.memoriesCreated += partial.memoriesCreated ?? 0
  into.memoriesUpdated += partial.memoriesUpdated ?? 0
  into.memoriesInvalidated += partial.memoriesInvalidated ?? 0
  into.memoriesNoop += partial.memoriesNoop ?? 0
}

/** Delay helper for rate limiting */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Minimum delay between extraction API calls (ms).
 * Anthropic's Haiku rate limit is 50K input tokens/min. Each conversation
 * is ~2-5K tokens after system prompt stripping, so ~10-25 calls/min is safe.
 * 3 seconds between calls = ~20 calls/min = well within limits.
 */
const EXTRACTION_DELAY_MS = 5000

/**
 * Max consecutive failures before aborting the run.
 * Prevents burning through the entire queue on persistent errors
 * (bad API key, account issues, etc.)
 */
const MAX_CONSECUTIVE_FAILURES = 5

/** Reconstruct sessions, then process each unprocessed session */
async function processAllConversations(
  walletDir: string,
  processedIds: Set<string>,
  initialSummary: string,
  ctx: ConversationContext,
): Promise<{
  rollingSummary: string
  stats: ExtractionStats
  failedCount: number
  touchedProjectIds: Set<string>
}> {
  const logger = createLogger('extraction')
  const stats: ExtractionStats = {
    conversationsProcessed: 0,
    factsExtracted: 0,
    memoriesCreated: 0,
    memoriesUpdated: 0,
    memoriesInvalidated: 0,
    memoriesNoop: 0,
  }
  let rollingSummary = initialSummary
  let failedCount = 0
  let consecutiveFailures = 0
  // T08: the projectIds whose live memory set changed this run → exactly the docs
  // to rebuild (scoped, NOT every bucket).
  const touchedProjectIds = new Set<string>()

  // Reconstruct sessions: 119 files → ~10 session representatives. Hook turns
  // already processed are excluded before grouping (D1: incremental sessions).
  const sessions = await reconstructSessions(walletDir, { processedIds })

  // Filter to unprocessed sessions only
  const pending = sessions.filter((s) => !processedIds.has(s.id))

  if (pending.length > 0) {
    logger.info('Starting extraction', {
      totalSessions: sessions.length,
      pending: pending.length,
      alreadyProcessed: processedIds.size,
    })
  }

  // Process one at a time with delay between calls
  for (let i = 0; i < pending.length; i++) {
    const session = pending[i]
    const { id } = session

    // Abort on too many consecutive failures (persistent error like bad API key)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('Aborting extraction: too many consecutive failures', {
        consecutiveFailures,
        remaining: pending.length - i,
      })
      break
    }

    const result = await processConversation(session, rollingSummary, ctx)

    if (result === null) {
      // Conversation was skipped (incognito, too few messages, no real content).
      // Mark the session id as processed — it won't change on re-run. For a
      // synthetic hook group the id is derived from its members, so the SAME
      // members are never re-evaluated, while a new turn arriving in that
      // session forms a new group (new id) and gets a fresh look. The member
      // ids are deliberately NOT marked here so they can be regrouped.
      processedIds.add(id)
      continue
    }

    if (result.succeeded) {
      // Success — mark as processed (and every hook member folded in), update stats
      processedIds.add(id)
      for (const memberId of session.memberIds ?? []) processedIds.add(memberId)
      rollingSummary = result.rollingSummary
      stats.conversationsProcessed++
      mergeStats(stats, result.stats)
      if (result.changedMemories) touchedProjectIds.add(result.projectId)
      consecutiveFailures = 0

      logger.info('Conversation extracted', {
        id,
        facts: result.stats.factsExtracted ?? 0,
        progress: `${i + 1}/${pending.length}`,
      })
    } else {
      // Failed (rate limit, network error, etc.) — do NOT mark as processed
      // It will be retried on the next extraction run
      failedCount++
      consecutiveFailures++

      logger.warn('Conversation failed, will retry next run', {
        id,
        consecutiveFailures,
        progress: `${i + 1}/${pending.length}`,
      })
    }

    // Rate limit: wait between API calls (skip delay after the last one)
    if (i < pending.length - 1) {
      await delay(EXTRACTION_DELAY_MS)
    }
  }

  return { rollingSummary, stats, failedCount, touchedProjectIds }
}

/**
 * Off-line consolidation sweep (Step 5), gated behind extraction.consolidate
 * (DEFAULT FALSE → dark). Fully non-fatal: a consolidation failure must NEVER
 * abort extraction. The dynamic import avoids a static runner↔consolidate cycle
 * (consolidate imports writeMemoryFile/invalidateMemoryFile from here).
 */
async function maybeConsolidate(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig['extraction'],
): Promise<void> {
  if (!config.consolidate) return
  const logger = createLogger('extraction')
  try {
    const { runConsolidation } = await import('../store/consolidate.js')
    const cr = await runConsolidation(walletDir, store, config)
    if (!cr.ok) logger.warn('consolidation failed (non-fatal)', { error: cr.error.message })
  } catch (err) {
    logger.warn('consolidation failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Scheduled forget sweep (v0.3.1, audit D6). `runForget` used to be reachable only
 * through `dhakira forget`, so TTLs never fired on their own. It is model-free and
 * laptop-safe (forget.ts header), so it runs at the end of EVERY extraction run —
 * even one that processed nothing — and once at daemon start (src/index.ts).
 * Fully non-fatal; the dynamic import avoids a static runner↔forget cycle
 * (forget imports the frontmatter readers + softForgetMemoryFile from here).
 */
async function maybeForget(walletDir: string, store: QMDStore): Promise<void> {
  const logger = createLogger('extraction')
  try {
    const { runForget } = await import('../store/forget.js')
    const fr = await runForget(walletDir, store)
    if (!fr.ok) logger.warn('forget sweep failed (non-fatal)', { error: fr.error.message })
  } catch (err) {
    logger.warn('forget sweep failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * T08 scoped project-doc rebuild trigger. Runs after regenerateProfile (global).
 * Fully non-fatal: a synthesis failure must NEVER abort extraction. The dynamic
 * import keeps the synthesis chain (collect/synthesize/harness) off the hot path
 * until there is actually something to rebuild.
 */
async function maybeRegenerateProjectDocs(
  walletDir: string,
  config: WalletConfig['extraction'],
  touchedProjectIds: Set<string>,
): Promise<void> {
  const logger = createLogger('extraction')
  try {
    const { regenerateProjectDocs } = await import('../synthesis/regenerate.js')
    await regenerateProjectDocs(walletDir, config, touchedProjectIds)
  } catch (err) {
    logger.warn('project-doc regeneration failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Run the full extraction pipeline:
 * 1. Find unprocessed conversations (tracked in .extraction-state.json)
 * 2. Skip conversations with < 3 messages or flagged incognito
 * 3. Extract facts from each conversation via LLM (Phase 1)
 * 4. Decide ADD/UPDATE/INVALIDATE/NOOP for each fact (Phase 2)
 * 5. Write memory files and apply invalidations
 * 6. Regenerate profile.md from HIGH-confidence memories
 * 7. Re-index QMD store, run the forget sweep, and save updated state
 */
export async function runExtraction(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig['extraction'],
): Promise<Result<ExtractionStats>> {
  const logger = createLogger('extraction')

  const state = await loadState(walletDir)
  const processedIds = new Set(state.processedConversationIds)

  let existingProfile = ''
  try {
    existingProfile = await readFile(join(walletDir, 'profile.md'), 'utf8')
  } catch {
    /* First run — profile does not exist yet */
  }

  const ctx: ConversationContext = { walletDir, store, config, existingProfile }
  const { rollingSummary, stats, failedCount, touchedProjectIds } = await processAllConversations(
    walletDir,
    processedIds,
    state.rollingSummary,
    ctx,
  )

  if (stats.conversationsProcessed > 0) {
    try {
      await store.update()
    } catch (err) {
      logger.warn('QMD re-index failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Generate vector embeddings for new memories — enables hybrid search
    // (BM25 + semantic similarity + reranking). Runs locally via llama.cpp.
    try {
      logger.info('Generating embeddings for hybrid search...')
      await store.embed()
      logger.info('Embeddings generated')
    } catch (err) {
      logger.warn('Embedding generation failed (hybrid search will fall back to BM25)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Off-line consolidation sweep (Step 5), gated + dark by default. Runs
    // BEFORE regenerateProfile so the profile is built from the already-
    // consolidated store. Extracted to a helper to keep runExtraction simple.
    await maybeConsolidate(walletDir, store, config)

    await regenerateProfile(walletDir, config)

    // T08: rebuild ONLY the touched (non-global) project docs through the CP3
    // synthesis ladder. Scoped, freshness-by-rebuild, fully non-fatal.
    await maybeRegenerateProjectDocs(walletDir, config, touchedProjectIds)
  }

  // v0.3.1 (D6): the forget sweep runs on every extraction run, processed or not.
  await maybeForget(walletDir, store)

  // Save state — only successfully processed IDs are in processedIds
  // Failed conversations are NOT included, so they'll be retried next run
  await saveState(walletDir, {
    processedConversationIds: [...processedIds],
    rollingSummary,
    lastRunAt: new Date().toISOString(),
  })

  logger.info('Extraction run complete', { ...stats, failedCount })
  return { ok: true, value: stats }
}
