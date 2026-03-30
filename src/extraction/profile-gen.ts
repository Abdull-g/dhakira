// Regenerate profile.md from current memories

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { callLLM, extractContent } from './extract.js'
import { fillTemplate, PROFILE_PROMPT } from './prompts.js'

interface MemoryFrontmatter {
  confidence: string
  invalidatedAt: string | null | undefined
}

function parseMemoryFrontmatter(content: string): MemoryFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    return {
      confidence: String(parsed.confidence ?? ''),
      // YAML parses "null" literal as JS null; treat empty string as not-set
      invalidatedAt:
        parsed.invalidatedAt === null
          ? null
          : parsed.invalidatedAt
            ? String(parsed.invalidatedAt)
            : undefined,
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

  const memories: string[] = []
  for (const rel of relPaths) {
    try {
      const content = await readFile(join(memoriesDir, rel), 'utf8')
      const fm = parseMemoryFrontmatter(content)
      if (!fm || fm.confidence !== 'HIGH' || fm.invalidatedAt) continue
      const body = extractMemoryBody(content)
      if (body) memories.push(body)
    } catch {
      // Skip unreadable files silently
    }
  }
  return { ok: true, value: memories }
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

  const llmResult = await callLLM(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
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
