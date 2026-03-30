// Phase 2: decide ADD/UPDATE/INVALIDATE/NOOP for each extracted fact

import { basename } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'

import type { WalletConfig } from '../config/schema.js'
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { callLLM, extractContent } from './extract.js'
import { fillTemplate, UPDATE_PROMPT } from './prompts.js'
import type { ExtractedFact, UpdateAction } from './types.js'

interface UpdateDecision {
  action: 'ADD' | 'UPDATE' | 'INVALIDATE' | 'NOOP'
  targetId?: string
  reason?: string
}

/** Strip markdown code fences (```json ... ```) if present */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m)
  return match ? match[1].trim() : trimmed
}

function parseUpdateDecision(content: string): Result<UpdateDecision> {
  const cleaned = stripCodeFences(content)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      error: new Error(`Failed to parse update decision JSON: ${cleaned.slice(0, 200)}`),
    }
  }

  const action = String(parsed.action ?? '')
  if (!['ADD', 'UPDATE', 'INVALIDATE', 'NOOP'].includes(action)) {
    return { ok: false, error: new Error(`Unknown action in update decision: "${action}"`) }
  }

  const decision: UpdateDecision = { action: action as UpdateDecision['action'] }
  if (parsed.targetId) decision.targetId = String(parsed.targetId)
  if (parsed.reason) decision.reason = String(parsed.reason)

  return { ok: true, value: decision }
}

function decisionToAction(decision: UpdateDecision, fact: ExtractedFact): Result<UpdateAction> {
  switch (decision.action) {
    case 'ADD':
      return { ok: true, value: { action: 'ADD', fact } }
    case 'UPDATE':
      if (!decision.targetId) {
        return { ok: false, error: new Error('UPDATE action missing targetId') }
      }
      return { ok: true, value: { action: 'UPDATE', fact, targetId: decision.targetId } }
    case 'INVALIDATE':
      if (!decision.targetId) {
        return { ok: false, error: new Error('INVALIDATE action missing targetId') }
      }
      return { ok: true, value: { action: 'INVALIDATE', fact, targetId: decision.targetId } }
    case 'NOOP':
      return { ok: true, value: { action: 'NOOP', reason: decision.reason ?? 'Already captured' } }
  }
}

/** Search existing memories for similar content using hybrid search (BM25 + vector).
 *  Falls back to BM25 if hybrid search fails. */
async function searchExistingMemories(store: QMDStore, factText: string): Promise<Result<string>> {
  try {
    // Try hybrid search first — catches semantic duplicates BM25 misses
    // Use BM25 for UPDATE dedup — hybrid search loads ~2GB models into RAM
    // which is too slow for per-fact checks (especially in benchmark runs).
    // BM25 is fast and catches exact/near-exact duplicates well enough.
    // Hybrid search can be re-enabled when models are pre-loaded (future optimization).
    const results = await store.searchLex(factText, { limit: 5, collection: 'memories' })

    if (results.length === 0) return { ok: true, value: '(no existing memories found)' }
    const text = results
      .map((r) => {
        const fp = String(r.filepath ?? '')
        const body = String(r.body ?? r.title ?? '(no content)')
        return `[${basename(fp, '.md')}] ${body}`
      })
      .join('\n')
    return { ok: true, value: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/** Determine the UpdateAction for a single fact, defaulting to ADD on any failure */
async function decideActionForFact(
  fact: ExtractedFact,
  store: QMDStore,
  config: WalletConfig['extraction'],
): Promise<UpdateAction> {
  const logger = createLogger('extraction')

  const searchResult = await searchExistingMemories(store, fact.text)
  if (!searchResult.ok) {
    logger.warn('Memory search failed, defaulting to ADD', {
      fact: fact.text,
      error: searchResult.error.message,
    })
    return { action: 'ADD', fact }
  }

  const prompt = fillTemplate(UPDATE_PROMPT, {
    new_fact: `[${fact.category}] (${fact.confidence}) ${fact.text}`,
    existing_memories: searchResult.value,
  })

  const llmResult = await callLLM(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
  if (!llmResult.ok) {
    logger.warn('LLM call failed, defaulting to ADD', {
      fact: fact.text,
      error: llmResult.error.message,
    })
    return { action: 'ADD', fact }
  }

  const contentResult = extractContent(llmResult.value)
  if (!contentResult.ok) {
    logger.warn('Empty LLM response, defaulting to ADD', {
      fact: fact.text,
      error: contentResult.error.message,
    })
    return { action: 'ADD', fact }
  }

  const decisionResult = parseUpdateDecision(contentResult.value)
  if (!decisionResult.ok) {
    logger.warn('Unparseable decision, defaulting to ADD', {
      fact: fact.text,
      error: decisionResult.error.message,
    })
    return { action: 'ADD', fact }
  }

  const actionResult = decisionToAction(decisionResult.value, fact)
  if (!actionResult.ok) {
    logger.warn('Invalid action, defaulting to ADD', {
      fact: fact.text,
      error: actionResult.error.message,
    })
    return { action: 'ADD', fact }
  }

  logger.debug('Update decision', { fact: fact.text, action: decisionResult.value.action })
  return actionResult.value
}

/** Delay helper for rate limiting */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Delay between UPDATE LLM calls to avoid rate limits */
const UPDATE_DELAY_MS = 2000

/**
 * Phase 2: For each extracted fact, search existing memories and ask the LLM
 * to decide ADD / UPDATE / INVALIDATE / NOOP.
 *
 * Processes facts sequentially with delay between API calls to stay within
 * rate limits. Uses the QMD store's lexical search to surface the most similar
 * existing memories before asking the LLM to compare. On any non-fatal failure
 * (search error, LLM error, parse error) the fact defaults to ADD so no
 * information is silently lost.
 */
export async function processUpdates(
  facts: ExtractedFact[],
  store: QMDStore,
  config: WalletConfig['extraction'],
): Promise<Result<UpdateAction[]>> {
  const logger = createLogger('extraction')
  const actions: UpdateAction[] = []

  for (let i = 0; i < facts.length; i++) {
    const action = await decideActionForFact(facts[i], store, config)
    actions.push(action)

    // Rate limit: wait between API calls (skip delay after the last one)
    if (i < facts.length - 1) {
      await delay(UPDATE_DELAY_MS)
    }
  }

  logger.info('Update decisions complete', { factCount: facts.length })
  return { ok: true, value: actions }
}
