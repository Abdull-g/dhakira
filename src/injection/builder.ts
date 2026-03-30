// Build injection block from profile + turn search results

import type { WalletConfig } from '../config/schema.js'
import type { TurnSearchResult } from '../retrieval/types.js'
import { estimateTokens } from '../utils/tokens.js'
import type { InjectionBlock } from './types.js'

const HEADER = '<dhakira_context>'
const FOOTER = '</dhakira_context>'
const PROFILE_SECTION_HEADER = '## About You'
const TURNS_SECTION_HEADER = '## Relevant Past Conversations'

// Include assistant response verbatim when it fits within this token count (~800 chars)
const VERBATIM_TOKEN_LIMIT = 200
// Maximum sentences to extract from a long assistant response
const MAX_SENTENCES = 3

/**
 * Format a timestamp to YYYY-MM-DD using the local date of the ISO string.
 */
function formatDate(timestamp: string): string {
  try {
    return new Date(timestamp).toISOString().slice(0, 10)
  } catch {
    return timestamp.slice(0, 10)
  }
}

/**
 * Truncate a long assistant response to the first 2-3 sentences.
 *
 * Sentence boundaries are detected as punctuation (.!?) followed by whitespace
 * and an uppercase letter, a dash, a backtick, or a digit — covering most
 * natural English prose without splitting inside URLs or code spans.
 *
 * Returns the text unchanged when it fits within VERBATIM_TOKEN_LIMIT.
 */
function truncateAssistant(text: string): string {
  if (estimateTokens(text) <= VERBATIM_TOKEN_LIMIT) return text

  const boundaryRe = /(?<=[.!?])\s+(?=[A-Z0-9\-`*])/g
  const sentences = text.split(boundaryRe)

  const result: string[] = []
  for (const sentence of sentences) {
    result.push(sentence.trimEnd())
    if (result.length >= MAX_SENTENCES) break
  }
  return result.join(' ')
}

/**
 * Format a single TurnSearchResult as a dated conversation entry.
 *
 * Output format:
 *   [YYYY-MM-DD] You: {user message}
 *   → {assistant response (possibly truncated)}
 */
function formatTurnEntry(result: TurnSearchResult): string {
  const date = formatDate(result.turnPair.timestamp)
  const user = result.turnPair.userContent.replace(/\n+/g, ' ').trim()
  const assistant = truncateAssistant(result.turnPair.assistantContent)
  return `[${date}] You: ${user}\n→ ${assistant}`
}

/**
 * Build the injection block for the current request.
 *
 * Token budget:
 *   - The skeleton (HEADER + profile section + turns header + FOOTER) is
 *     computed first; its token cost is subtracted from maxTokens.
 *   - Turn entries fill the remaining budget greedily, highest-score first.
 *   - No more than config.maxTurns entries are included regardless of budget.
 *
 * Returns an empty block when both profile and searchResults are absent.
 */
export function buildInjectionBlock(
  profile: string,
  searchResults: TurnSearchResult[],
  config: WalletConfig['injection'],
): InjectionBlock {
  const trimmedProfile = profile.trim()
  const hasProfile = trimmedProfile.length > 0

  const sorted = [...searchResults].sort((a, b) => b.score - a.score)

  if (!hasProfile && sorted.length === 0) {
    return { text: '', tokenCount: 0, memoryCount: 0, hasProfile: false }
  }

  // Build the skeleton: everything except the turn entries themselves.
  // This gives us the baseline token cost before we start filling turns.
  const skeletonParts: string[] = [HEADER]
  if (hasProfile) skeletonParts.push(`${PROFILE_SECTION_HEADER}\n${trimmedProfile}`)
  skeletonParts.push(TURNS_SECTION_HEADER)
  skeletonParts.push(FOOTER)
  const skeleton = skeletonParts.join('\n\n')
  const skeletonCost = estimateTokens(skeleton)

  let turnsBudget = Math.max(0, config.maxTokens - skeletonCost)

  // Greedily include turn entries within budget, up to maxTurns
  const includedEntries: string[] = []
  for (const result of sorted) {
    if (includedEntries.length >= config.maxTurns) break
    const entry = formatTurnEntry(result)
    // Account for the blank-line separator between entries
    const cost = estimateTokens((includedEntries.length > 0 ? '\n\n' : '') + entry)
    if (cost > turnsBudget) break
    includedEntries.push(entry)
    turnsBudget -= cost
  }

  // Assemble final text
  const contentParts: string[] = [HEADER]
  if (hasProfile) contentParts.push(`${PROFILE_SECTION_HEADER}\n${trimmedProfile}`)

  const turnsBody =
    includedEntries.length > 0
      ? `${TURNS_SECTION_HEADER}\n${includedEntries.join('\n\n')}`
      : TURNS_SECTION_HEADER

  contentParts.push(turnsBody)
  contentParts.push(FOOTER)

  const fullText = contentParts.join('\n\n')

  return {
    text: fullText,
    tokenCount: estimateTokens(fullText),
    memoryCount: includedEntries.length,
    hasProfile,
  }
}
