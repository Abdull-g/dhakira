// Build injection block from global profile + scoped project doc + turn search results.
//
// THREE independently-degradable layers share ONE token ceiling (config.maxTokens):
//   1. ## About You              — global identity. Highest priority, kept WHOLE.
//   2. ## Project: <name>        — scoped synthesis. The star; soft-capped, trimmed
//                                  Open-threads-first under pressure.
//   3. ## Relevant Past Conv.    — Layer-1 turns. Fill the REMAINDER, greedy, maxTurns.
//
// Degrade under pressure in REVERSE priority: turns get only what's left (so they
// drop first), then the project doc is trimmed from its tail (Open threads is
// rendered last for exactly this), and global identity is ALWAYS kept. The global
// layer is never trimmed — it is small by construction, and trimming it would break
// byte-compatibility with the pre-T08 profile-only injection.

import type { WalletConfig } from '../config/schema.js'
import type { TurnSearchResult } from '../retrieval/types.js'
import { estimateTokens } from '../utils/tokens.js'
import type { InjectionBlock } from './types.js'

const HEADER = '<dhakira_context>'
const FOOTER = '</dhakira_context>'
const PROFILE_SECTION_HEADER = '## About You'
const PROJECT_SECTION_HEADER = '## Project'
const TURNS_SECTION_HEADER = '## Relevant Past Conversations'

// Include assistant response verbatim when it fits within this token count (~800 chars)
const VERBATIM_TOKEN_LIMIT = 200
// Maximum sentences to extract from a long assistant response
const MAX_SENTENCES = 3

// Soft-cap fallbacks if a (test) config omits the T08 per-layer fields. Production
// config always provides them (defaults.ts); these keep the builder resilient.
const DEFAULT_PROJECT_MAX_TOKENS = 700

// Project-doc section labels (must match synthesize.ts render order; Open threads
// is LAST so trimming drops it first). Used to trim whole sections under budget.
const PROJECT_SECTION_LABELS = [
  'What this is:',
  'Key decisions:',
  'Conventions:',
  'Gotchas:',
  'Open threads:',
]

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
 * Split a rendered project doc into its labeled sections (in order). A flat
 * fallback doc (no section labels) returns as a single unit. Section content
 * (bullets) lives WITH its label, so trimming by section keeps bullets intact.
 */
function splitProjectSections(doc: string): string[] {
  const lines = doc.split('\n')
  const sections: string[] = []
  let current: string[] = []
  let sawLabel = false

  for (const line of lines) {
    if (PROJECT_SECTION_LABELS.some((label) => line.startsWith(label))) {
      sawLabel = true
      if (current.length > 0) sections.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) sections.push(current.join('\n'))

  return sawLabel ? sections : [doc]
}

/** Drop trailing LINES until the text fits the budget (the flat/last-resort trim). */
function trimTrailingLines(text: string, maxTokens: number): string {
  const lines = text.split('\n')
  while (lines.length > 1 && estimateTokens(lines.join('\n')) > maxTokens) {
    lines.pop()
  }
  const result = lines.join('\n')
  return estimateTokens(result) <= maxTokens ? result : ''
}

/**
 * Trim a project doc to a token budget, REVERSE priority: drop whole trailing
 * sections (Open threads first) until it fits; if even the first section is over,
 * trim its lines; budget ≤ 0 → drop entirely. Returns the trimmed body.
 */
function trimProjectDoc(doc: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(doc) <= maxTokens) return doc

  const sections = splitProjectSections(doc)
  if (sections.length > 1) {
    const kept = [...sections]
    while (kept.length > 1 && estimateTokens(kept.join('\n')) > maxTokens) {
      kept.pop() // Open threads is last → drops first.
    }
    const joined = kept.join('\n')
    if (estimateTokens(joined) <= maxTokens) return joined
    return trimTrailingLines(joined, maxTokens)
  }
  return trimTrailingLines(doc, maxTokens)
}

/**
 * Trim + frame the project section to min(soft cap, ceiling room after the
 * must-keep chrome + global). Returns '' when nothing survives the budget.
 */
function fitProjectSection(
  project: string,
  projectHeader: string,
  profileSection: string,
  config: WalletConfig['injection'],
): string {
  const projectCap = config.projectMaxTokens ?? DEFAULT_PROJECT_MAX_TOKENS
  const chrome = [HEADER, profileSection, projectHeader, TURNS_SECTION_HEADER, FOOTER]
    .filter((s) => s.length > 0)
    .join('\n\n')
  const roomForProjectBody = config.maxTokens - estimateTokens(chrome)
  const projectBudget = Math.min(projectCap, Math.max(0, roomForProjectBody))
  const trimmed = trimProjectDoc(project, projectBudget)
  return trimmed.length > 0 ? `${projectHeader}\n${trimmed}` : ''
}

/** Greedy highest-score-first turn selection within the remaining budget + maxTurns. */
function selectTurnEntries(sorted: TurnSearchResult[], maxTurns: number, budget: number): string[] {
  let remaining = budget
  const included: string[] = []
  for (const result of sorted) {
    if (included.length >= maxTurns) break
    const entry = formatTurnEntry(result)
    const cost = estimateTokens((included.length > 0 ? '\n\n' : '') + entry)
    if (cost > remaining) break
    included.push(entry)
    remaining -= cost
  }
  return included
}

/**
 * Build the injection block for the current request.
 *
 * @param globalProfile  the global identity body (## About You). Kept whole.
 * @param projectDoc     the scoped project synthesis body, or null to omit.
 * @param searchResults  Layer-1 turn search results (query-ranked).
 * @param config         injection limits (shared ceiling + per-layer soft caps).
 * @param projectName    optional display name for the `## Project: <name>` header.
 *
 * Returns an empty block when global, project, and turns are all absent. With no
 * project doc, output is byte-compatible with the pre-T08 (global + turns) builder.
 */
export function buildInjectionBlock(
  globalProfile: string,
  projectDoc: string | null,
  searchResults: TurnSearchResult[],
  config: WalletConfig['injection'],
  projectName?: string,
): InjectionBlock {
  const trimmedProfile = globalProfile.trim()
  const hasProfile = trimmedProfile.length > 0

  const sorted = [...searchResults].sort((a, b) => b.score - a.score)

  const project = projectDoc?.trim() ?? ''
  let hasProject = project.length > 0

  if (!hasProfile && !hasProject && sorted.length === 0) {
    return { text: '', tokenCount: 0, memoryCount: 0, hasProfile: false, hasProject: false }
  }

  // Tier 1: global identity — kept whole (highest priority, small by construction).
  const profileSection = hasProfile ? `${PROFILE_SECTION_HEADER}\n${trimmedProfile}` : ''

  // Tier 2: project synthesis — trim to soft cap / ceiling room, Open-threads-first.
  const projectHeader = projectName
    ? `${PROJECT_SECTION_HEADER}: ${projectName}`
    : PROJECT_SECTION_HEADER
  const projectSection = hasProject
    ? fitProjectSection(project, projectHeader, profileSection, config)
    : ''
  hasProject = projectSection.length > 0

  // Skeleton = everything except the turn entries. Its cost is the baseline before
  // turns greedily fill the remainder.
  const skeletonParts = [
    HEADER,
    profileSection,
    projectSection,
    TURNS_SECTION_HEADER,
    FOOTER,
  ].filter((s) => s.length > 0)
  const skeletonCost = estimateTokens(skeletonParts.join('\n\n'))

  // Tier 3: Layer-1 turns — fill the remainder, highest-score first, up to maxTurns.
  const turnsBudget = Math.max(0, config.maxTokens - skeletonCost)
  const includedEntries = selectTurnEntries(sorted, config.maxTurns, turnsBudget)

  // Assemble final text.
  const contentParts: string[] = [HEADER]
  if (hasProfile) contentParts.push(profileSection)
  if (hasProject) contentParts.push(projectSection)

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
    hasProject,
  }
}
