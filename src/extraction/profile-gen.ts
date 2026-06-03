// Regenerate profile.md from current memories

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import type { SalienceTier } from '../salience/types.js'
import { createLogger } from '../utils/logger.js'
import { callExtractionLLM, extractContent } from './extract.js'
import { fillTemplate, PROFILE_PROMPT } from './prompts.js'

type Result<T> = import('../proxy/types.js').Result<T>

/**
 * Max memories fed to profile synthesis. Below this count, all eligible
 * memories are included (behavior unchanged); above it, salience-tier
 * preference selects the most important ones (see collectHighConfidenceMemories).
 */
const PROFILE_MAX_MEMORIES = 40

/** Backward-compat default tier for memory files written before salience existed. */
const DEFAULT_SALIENCE_TIER: SalienceTier = 'standard'
const SALIENCE_TIERS: readonly SalienceTier[] = ['core', 'standard', 'trivia']

/** Selection preference above the cap: core first, then standard, then trivia. */
const TIER_RANK: Record<SalienceTier, number> = {
  core: 0,
  standard: 1,
  trivia: 2,
}

interface MemoryFrontmatter {
  confidence: string
  invalidatedAt: string | null | undefined
  forgottenAt: string | null | undefined
  salienceTier: SalienceTier
}

function parseMemoryFrontmatter(content: string): MemoryFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    // Backward-compat: old files have no salienceTier line → default 'standard'.
    // Inlined here (not imported from runner.js) to avoid a module cycle.
    const rawTier = String(parsed.salienceTier ?? '')
    const salienceTier = SALIENCE_TIERS.includes(rawTier as SalienceTier)
      ? (rawTier as SalienceTier)
      : DEFAULT_SALIENCE_TIER
    return {
      confidence: String(parsed.confidence ?? ''),
      // YAML parses "null" literal as JS null; treat empty string as not-set
      invalidatedAt:
        parsed.invalidatedAt === null
          ? null
          : parsed.invalidatedAt
            ? String(parsed.invalidatedAt)
            : undefined,
      // T06: a soft-forgotten memory must be invisible everywhere a superseded
      // one is. Same null/empty handling as invalidatedAt.
      forgottenAt:
        parsed.forgottenAt === null
          ? null
          : parsed.forgottenAt
            ? String(parsed.forgottenAt)
            : undefined,
      salienceTier,
    }
  } catch {
    return null
  }
}

function extractMemoryBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/)
  return match?.[1]?.trim() ?? ''
}

/** Collect body text from all non-invalidated HIGH-confidence memory files */
async function collectHighConfidenceMemories(memoriesDir: string): Promise<Result<string[]>> {
  let relPaths: string[]
  try {
    const entries = (await readdir(memoriesDir, { recursive: true })) as string[]
    relPaths = entries.filter((f) => f.endsWith('.md'))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }

  const eligible: { body: string; tier: SalienceTier }[] = []
  for (const rel of relPaths) {
    try {
      const content = await readFile(join(memoriesDir, rel), 'utf8')
      const fm = parseMemoryFrontmatter(content)
      if (!fm || fm.confidence !== 'HIGH' || fm.invalidatedAt || fm.forgottenAt) continue
      const body = extractMemoryBody(content)
      if (body) eligible.push({ body, tier: fm.salienceTier })
    } catch {
      // Skip unreadable files silently
    }
  }

  // At/under the cap: behavior UNCHANGED — include all in directory order
  // (protects small wallets + existing tests).
  if (eligible.length <= PROFILE_MAX_MEMORIES) {
    return { ok: true, value: eligible.map((m) => m.body) }
  }

  // Over the cap: prefer high-salience memories (core → standard → trivia).
  // Array.sort is stable, so original order is preserved within a tier; then
  // keep only the top PROFILE_MAX_MEMORIES that feed profile synthesis.
  const ranked = [...eligible].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])
  return { ok: true, value: ranked.slice(0, PROFILE_MAX_MEMORIES).map((m) => m.body) }
}

/** Call LLM and write the resulting profile text to disk */
async function writeProfileFromLLM(
  profilePath: string,
  memories: string[],
  config: WalletConfig['extraction'],
): Promise<Result<string>> {
  const logger = createLogger('extraction')
  const memoriesText = memories.map((m, i) => `${i + 1}. ${m}`).join('\n')
  const prompt = fillTemplate(PROFILE_PROMPT, { memories: memoriesText })

  logger.info('Regenerating profile', { memoryCount: memories.length })

  const llmResult = await callExtractionLLM(config, [{ role: 'user', content: prompt }])
  if (!llmResult.ok) return llmResult

  const contentResult = extractContent(llmResult.value)
  if (!contentResult.ok) return contentResult

  const profileContent = contentResult.value.trim()
  try {
    await writeFile(profilePath, profileContent, 'utf8')
    logger.info('Profile regenerated', { length: profileContent.length })
    return { ok: true, value: profileContent }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Regenerate {walletDir}/profile.md from all active HIGH-confidence memories.
 *
 * Reads every file in {walletDir}/memories/, filters to non-invalidated
 * HIGH-confidence records, calls the LLM with PROFILE_PROMPT, and writes
 * the result to {walletDir}/profile.md.
 */
export async function regenerateProfile(
  walletDir: string,
  config: WalletConfig['extraction'],
): Promise<Result<string>> {
  const logger = createLogger('extraction')
  const profilePath = join(walletDir, 'profile.md')

  const memoriesResult = await collectHighConfidenceMemories(join(walletDir, 'memories'))
  if (!memoriesResult.ok) {
    logger.error('Failed to collect memories for profile gen', {
      error: memoriesResult.error.message,
    })
    return memoriesResult
  }

  if (memoriesResult.value.length === 0) {
    logger.info('No HIGH-confidence memories — writing empty profile')
    try {
      await writeFile(profilePath, '', 'utf8')
      return { ok: true, value: '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  return writeProfileFromLLM(profilePath, memoriesResult.value, config)
}
