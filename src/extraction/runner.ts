// Orchestrate the full nightly extraction pipeline

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { parse } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import type { Result } from '../proxy/types.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { extractFacts } from './extract.js'
import { regenerateProfile } from './profile-gen.js'
import {
  cleanSessionContent,
  hasSubstantiveContent,
  reconstructSessions,
} from './session-reconstructor.js'
import type { ExtractedFact, MemoryRecord, UpdateAction } from './types.js'
import { processUpdates } from './update.js'

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
}

interface ConvFrontmatter {
  id: string
  incognito: boolean
  timestamp: string
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
    return JSON.parse(raw) as ExtractionState
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function saveState(walletDir: string, state: ExtractionState): Promise<void> {
  await writeFile(join(walletDir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8')
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
    }
  } catch {
    return null
  }
}

function countMessages(content: string): number {
  return (content.match(/^## (User|Assistant)$/gm) ?? []).length
}

function buildMemoryContent(memory: MemoryRecord): string {
  const lines = [
    '---',
    `id: ${memory.id}`,
    `category: ${memory.category}`,
    `confidence: ${memory.confidence}`,
    `source: ${memory.source}`,
    `createdAt: ${memory.createdAt.toISOString()}`,
    `validFrom: ${memory.validFrom.toISOString()}`,
    `invalidatedAt: ${memory.invalidatedAt ? memory.invalidatedAt.toISOString() : 'null'}`,
    '---',
  ]
  return `${lines.join('\n')}\n\n${memory.text}`
}

async function writeMemoryFile(walletDir: string, memory: MemoryRecord): Promise<void> {
  const memoriesDir = join(walletDir, 'memories')
  await mkdir(memoriesDir, { recursive: true })
  await writeFile(join(memoriesDir, `${memory.id}.md`), buildMemoryContent(memory), 'utf8')
}

async function invalidateMemoryFile(walletDir: string, memoryId: string): Promise<void> {
  const filePath = join(walletDir, 'memories', `${memoryId}.md`)
  const content = await readFile(filePath, 'utf8')
  const updated = content.replace(
    /^invalidatedAt: null$/m,
    `invalidatedAt: ${new Date().toISOString()}`,
  )
  await writeFile(filePath, updated, 'utf8')
}

function factToMemory(fact: ExtractedFact, sourceId: string, convTimestamp: Date): MemoryRecord {
  return {
    id: generateId('mem'),
    text: fact.text,
    category: fact.category,
    confidence: fact.confidence,
    source: sourceId,
    createdAt: new Date(),
    validFrom: convTimestamp,
    invalidatedAt: null,
  }
}

async function applyActions(
  walletDir: string,
  actions: UpdateAction[],
  sourceId: string,
  convTimestamp: Date,
  stats: ExtractionStats,
): Promise<void> {
  const logger = createLogger('extraction')

  for (const action of actions) {
    try {
      if (action.action === 'ADD') {
        const memory = factToMemory(action.fact, sourceId, convTimestamp)
        await writeMemoryFile(walletDir, memory)
        stats.memoriesCreated++
      } else if (action.action === 'UPDATE') {
        await invalidateMemoryFile(walletDir, action.targetId)
        const memory = factToMemory(action.fact, sourceId, convTimestamp)
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
}

/** Process a single session file: clean, extract facts, decide actions, write memories */
async function processConversation(
  filePath: string,
  rollingSummary: string,
  ctx: ConversationContext,
): Promise<ConversationResult | null> {
  const logger = createLogger('extraction')
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf8')
  } catch {
    return null
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
    return { succeeded: false, rollingSummary, stats: {} }
  }

  const { facts, summaryUpdate } = extractResult.value
  const partialStats: Partial<ExtractionStats> = { factsExtracted: facts.length }

  if (facts.length > 0) {
    const updateResult = await processUpdates(facts, ctx.store, ctx.config)
    if (updateResult.ok) {
      const actionStats: ExtractionStats = {
        conversationsProcessed: 0,
        factsExtracted: 0,
        memoriesCreated: 0,
        memoriesUpdated: 0,
        memoriesInvalidated: 0,
        memoriesNoop: 0,
      }
      await applyActions(ctx.walletDir, updateResult.value, fm.id, convTimestamp, actionStats)
      partialStats.memoriesCreated = actionStats.memoriesCreated
      partialStats.memoriesUpdated = actionStats.memoriesUpdated
      partialStats.memoriesInvalidated = actionStats.memoriesInvalidated
      partialStats.memoriesNoop = actionStats.memoriesNoop
    } else {
      logger.warn('processUpdates failed', { id: fm.id, error: updateResult.error.message })
    }
  }

  return { succeeded: true, rollingSummary: summaryUpdate, stats: partialStats }
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
): Promise<{ rollingSummary: string; stats: ExtractionStats; failedCount: number }> {
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

  // Reconstruct sessions: 119 files → ~10 session representatives
  const sessions = await reconstructSessions(walletDir)

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
    const { filePath, id } = pending[i]

    // Abort on too many consecutive failures (persistent error like bad API key)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('Aborting extraction: too many consecutive failures', {
        consecutiveFailures,
        remaining: pending.length - i,
      })
      break
    }

    const result = await processConversation(filePath, rollingSummary, ctx)

    if (result === null) {
      // Conversation was skipped (incognito, too few messages, no real content)
      // Mark as processed — it won't change on re-run
      processedIds.add(id)
      continue
    }

    if (result.succeeded) {
      // Success — mark as processed, update stats
      processedIds.add(id)
      rollingSummary = result.rollingSummary
      stats.conversationsProcessed++
      mergeStats(stats, result.stats)
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

  return { rollingSummary, stats, failedCount }
}

/**
 * Run the full extraction pipeline:
 * 1. Find unprocessed conversations (tracked in .extraction-state.json)
 * 2. Skip conversations with < 3 messages or flagged incognito
 * 3. Extract facts from each conversation via LLM (Phase 1)
 * 4. Decide ADD/UPDATE/INVALIDATE/NOOP for each fact (Phase 2)
 * 5. Write memory files and apply invalidations
 * 6. Regenerate profile.md from HIGH-confidence memories
 * 7. Re-index QMD store and save updated state
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
  const { rollingSummary, stats, failedCount } = await processAllConversations(
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

    await regenerateProfile(walletDir, config)
  }

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
