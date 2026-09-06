// Session Reconstructor — Deduplicate overlapping captures into clean sessions
//
// Chat APIs send cumulative message history with every request. A 20-message
// conversation produces 20 captured files, each containing the previous messages
// plus one new exchange. This module identifies these overlapping captures and
// selects only the most complete file per session.
//
// The raw capture files are NEVER modified or deleted — they remain as ground
// truth. This module produces a list of "session representative" file paths
// that the extraction runner should process.
//
// HOOK ARCHIVES (v0.3.1, audit D1): a hook (Claude Code / Codex) fires once per
// real turn, so each hook archive (`provider: hook`) holds exactly ONE user +
// assistant exchange — it is a TURN of a session, not a session. Treating each
// as its own session meant every hook capture failed the "< 3 messages" gate and
// Layer 2 (extraction → salience → consolidation → forget → profile/project docs)
// never ran for hook-only wallets. Hook archives are now grouped into synthetic
// sessions by (tool, projectId, hook session_id — or calendar day when the tool
// did not send one) and the gate is applied to the GROUP's message count.
// Non-hook (proxy) archives keep the original cumulative-history algorithm.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse } from 'yaml'

import { createLogger } from '../utils/logger.js'

export interface SessionFile {
  /** Path to the representative file for this session (first member for hook groups) */
  filePath: string
  /** Conversation ID from frontmatter (synthetic `hooksess_…` id for hook groups) */
  id: string
  /** Number of user+assistant messages */
  messageCount: number
  /** Model used */
  model: string
  /** Timestamp from frontmatter */
  timestamp: string
  /** Tool name */
  tool: string
  /**
   * Hook groups only: the pre-assembled session content (frontmatter + every
   * member's User/Assistant sections in order). There is no single file on disk
   * for a synthetic session, so the runner reads this instead of `filePath`.
   */
  content?: string
  /**
   * Hook groups only: the archive ids folded into this synthetic session. The
   * runner marks each one processed on success so a later run only groups the
   * turns that arrived since.
   */
  memberIds?: string[]
}

export interface ReconstructOptions {
  /**
   * Conversation ids already processed by extraction. Hook archives in this set
   * are excluded BEFORE grouping, so each run groups only the not-yet-processed
   * turns of a session (incremental extraction over a long-lived session).
   */
  processedIds?: ReadonlySet<string>
}

interface CaptureInfo {
  filePath: string
  id: string
  messageCount: number
  model: string
  timestamp: string
  tool: string
  incognito: boolean
  /** Capture provider from frontmatter ('hook' for hook-ingested archives). */
  provider: string
  /** Hook session id from frontmatter, when the tool sent one. */
  sessionId: string | null
  /** Resolved project scope ('global' when the archive carries no projectId). */
  projectId: string
  /** Markdown body after the frontmatter — retained for hook archives only. */
  body: string
}

/** Synthetic-session id prefix for grouped hook turns (never collides with `conv_`). */
export const HOOK_SESSION_ID_PREFIX = 'hooksess_'

/** Minimum user+assistant messages a session (or hook group) needs to be extracted. */
const MIN_SESSION_MESSAGES = 3

function isHookCapture(info: CaptureInfo): boolean {
  return info.provider === 'hook'
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/)
  return match ? content.slice(match[0].length) : content
}

/** The grouping key: same tool + same project + same hook session (or same calendar day). */
function hookGroupKey(info: CaptureInfo): string {
  const scope = info.sessionId ?? `day:${info.timestamp.slice(0, 10)}`
  return `${info.tool}|${info.projectId}|${scope}`
}

/**
 * Deterministic synthetic id for a hook group: same members → same id, so a run
 * that fails mid-way (not marked processed) rebuilds the identical group and
 * retries, while a group whose membership changed gets a fresh id.
 */
function hookSessionId(key: string, memberIds: string[]): string {
  const digest = createHash('sha256')
    .update(`${key}\n${memberIds.join('\n')}`)
    .digest('hex')
  return `${HOOK_SESSION_ID_PREFIX}${digest.slice(0, 16)}`
}

/**
 * Assemble one synthetic session from a group of hook turns. The frontmatter
 * mirrors a real capture file (id / incognito / timestamp / projectId are exactly
 * what the runner's parseConvFrontmatter reads) and the body is every member's
 * User/Assistant sections in chronological order, so cleanSessionContent and
 * hasSubstantiveContent work unchanged.
 */
function buildHookSession(key: string, members: CaptureInfo[]): SessionFile {
  const first = members[0] as CaptureInfo
  const memberIds = members.map((m) => m.id)
  const id = hookSessionId(key, memberIds)
  const model = members.find((m) => m.model.length > 0)?.model ?? ''
  const frontmatter = [
    '---',
    `id: ${id}`,
    `tool: ${first.tool}`,
    'provider: hook',
    `model: ${model}`,
    `timestamp: ${first.timestamp}`,
    'incognito: false',
    ...(first.projectId === 'global' ? [] : [`projectId: ${first.projectId}`]),
    ...(first.sessionId === null ? [] : [`sessionId: ${first.sessionId}`]),
    '---',
  ].join('\n')
  const body = members.map((m) => m.body.trim()).filter((b) => b.length > 0)

  return {
    filePath: first.filePath,
    id,
    messageCount: members.reduce((sum, m) => sum + m.messageCount, 0),
    model,
    timestamp: first.timestamp,
    tool: first.tool,
    content: `${frontmatter}\n\n${body.join('\n\n')}\n`,
    memberIds,
  }
}

/**
 * Group hook archives into synthetic sessions. Members are already sorted by
 * timestamp; groups are emitted in first-seen order. Groups below the message
 * gate are dropped here (the caller only sees representatives).
 */
function groupHookCaptures(captures: CaptureInfo[], minMessages: number): SessionFile[] {
  const groups = new Map<string, CaptureInfo[]>()
  for (const capture of captures) {
    const key = hookGroupKey(capture)
    const members = groups.get(key)
    if (members) members.push(capture)
    else groups.set(key, [capture])
  }

  const sessions: SessionFile[] = []
  for (const [key, members] of groups) {
    const session = buildHookSession(key, members)
    if (session.messageCount < minMessages) continue
    sessions.push(session)
  }
  return sessions
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    return parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function countMessages(content: string): number {
  return (content.match(/^## (User|Assistant)$/gm) ?? []).length
}

/** Check if a file is an internal tool call (Haiku with very few messages, no real user content) */
function isInternalToolCall(info: CaptureInfo): boolean {
  // Haiku calls with ≤ 2 messages are typically title generation, quota checks, etc.
  if (info.model.includes('haiku') && info.messageCount <= 2) return true
  return false
}

/** Read + parse every capture file under conversations/. null = directory unreadable/missing. */
async function loadCaptures(convDir: string): Promise<CaptureInfo[] | null> {
  let relPaths: string[] = []
  try {
    const entries = (await readdir(convDir, { recursive: true })) as string[]
    relPaths = entries.filter((f) => f.endsWith('.md')).sort()
  } catch {
    return null
  }

  const captures: CaptureInfo[] = []
  for (const rel of relPaths) {
    const filePath = join(convDir, rel)
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    const info = toCaptureInfo(filePath, content)
    if (info !== null) captures.push(info)
  }
  return captures
}

/** Frontmatter → CaptureInfo. null when the file has no parseable id. */
function toCaptureInfo(filePath: string, content: string): CaptureInfo | null {
  const fm = parseFrontmatter(content)
  if (!fm?.id) return null

  const provider = String(fm.provider ?? '')
  const rawSessionId = typeof fm.sessionId === 'string' ? fm.sessionId.trim() : ''
  return {
    filePath,
    id: String(fm.id),
    messageCount: countMessages(content),
    model: String(fm.model ?? ''),
    timestamp: String(fm.timestamp ?? ''),
    tool: String(fm.tool ?? ''),
    incognito: Boolean(fm.incognito),
    provider,
    sessionId: rawSessionId.length > 0 ? rawSessionId : null,
    projectId: fm.projectId ? String(fm.projectId) : 'global',
    // Only hook archives need their body retained (they are concatenated into a
    // synthetic session). Proxy archives are re-read by the runner from disk.
    body: provider === 'hook' ? stripFrontmatter(content) : '',
  }
}

/**
 * The original proxy algorithm: a session is a sequence of files from the same
 * tool where message count is monotonically increasing (each file is the
 * previous + more messages). When message count drops, it's a new session.
 * Skips incognito captures and internal tool calls.
 */
function groupProxyCaptures(captures: CaptureInfo[]): CaptureInfo[][] {
  const sessions: CaptureInfo[][] = []
  let currentSession: CaptureInfo[] = []
  let prevMsgCount = -1
  let prevTool = ''

  for (const capture of captures) {
    if (capture.incognito) continue
    if (isInternalToolCall(capture)) continue

    const isContinuation = capture.tool === prevTool && capture.messageCount > prevMsgCount
    if (isContinuation) {
      currentSession.push(capture)
    } else {
      // New session — flush the previous one
      if (currentSession.length > 0) sessions.push(currentSession)
      currentSession = [capture]
    }

    prevMsgCount = capture.messageCount
    prevTool = capture.tool
  }

  // Don't forget the last session
  if (currentSession.length > 0) sessions.push(currentSession)
  return sessions
}

/**
 * Scan the conversations directory, identify overlapping captures,
 * and return one representative file per real session.
 *
 * Algorithm:
 * 1. Read all capture files and extract metadata (tool, model, msg count, timestamp)
 * 2. Sort by timestamp
 * 3. Walk through in order: if the current file has MORE messages than the previous
 *    file for the same tool/model family, it's a continuation (same session).
 *    The newer file supersedes the older one.
 * 4. If the current file has FEWER or equal messages, it's a new session.
 * 5. Return the last (most complete) file from each session group.
 *
 * Also filters out:
 * - Internal tool calls (Haiku with ≤ 2 messages)
 * - Incognito conversations
 * - Files with < 3 total messages (too short for extraction)
 *
 * Hook archives (`provider: hook`) bypass the cumulative walk: they are grouped
 * into synthetic sessions (see the header) and the < 3 gate applies to the group.
 */
export async function reconstructSessions(
  walletDir: string,
  options: ReconstructOptions = {},
): Promise<SessionFile[]> {
  const logger = createLogger('session-reconstructor')
  const processedIds = options.processedIds ?? new Set<string>()

  const captures = await loadCaptures(join(walletDir, 'conversations'))
  if (captures === null) return []

  // Sort by timestamp for chronological processing
  captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Hook archives: turns of a session, grouped separately (D1). Already-processed
  // turns are excluded first so a long-lived session is extracted incrementally.
  const hookCaptures = captures.filter(
    (c) => isHookCapture(c) && !c.incognito && !processedIds.has(c.id),
  )
  const hookSessions = groupHookCaptures(hookCaptures, MIN_SESSION_MESSAGES)

  // Proxy archives: the original cumulative-history walk (hook archives excluded).
  const sessions = groupProxyCaptures(captures.filter((c) => !isHookCapture(c)))

  // From each session, pick the LAST file (most complete)
  const representatives: SessionFile[] = []
  for (const session of sessions) {
    const best = session[session.length - 1]

    // Skip sessions with very few messages (not enough content for extraction)
    if (best.messageCount < MIN_SESSION_MESSAGES) continue

    representatives.push({
      filePath: best.filePath,
      id: best.id,
      messageCount: best.messageCount,
      model: best.model,
      timestamp: best.timestamp,
      tool: best.tool,
    })
  }

  // Hook groups join the proxy representatives; keep chronological order overall.
  representatives.push(...hookSessions)
  representatives.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  logger.info('Sessions reconstructed', {
    totalCaptures: captures.length,
    sessions: sessions.length,
    hookTurns: hookCaptures.length,
    hookSessions: hookSessions.length,
    representatives: representatives.length,
    filtered: sessions.length - (representatives.length - hookSessions.length),
  })

  return representatives
}

/**
 * Strip everything except User and Assistant exchanges from a captured conversation.
 * This is provider-agnostic — works regardless of which AI tool generated the conversation.
 *
 * Instead of trying to strip specific boilerplate patterns (which differ per tool),
 * we ONLY KEEP content under ## User and ## Assistant headings. Everything else
 * (system prompts, injected memory, tool-specific tags, billing headers) is dropped.
 *
 * Returns the cleaned conversation text ready for extraction.
 */
export function cleanSessionContent(rawContent: string): string {
  // Split into sections by ## headings
  const sections = rawContent.split(/^(?=## (?:User|Assistant|System)\b)/m)

  // Keep only User and Assistant sections
  const kept: string[] = []
  for (const section of sections) {
    if (section.startsWith('## User') || section.startsWith('## Assistant')) {
      // Strip any injected tags that might appear inside user/assistant content
      let clean = section
      clean = clean.replace(/<memory_context>[\s\S]*?<\/memory_context>/g, '')
      clean = clean.replace(/<dhakira_context>[\s\S]*?<\/dhakira_context>/g, '')
      clean = clean.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')

      // Get the body after the heading
      const body = clean.replace(/^## (?:User|Assistant)\n/, '').trim()

      // Drop Claude Code autocomplete "suggestion mode" prompts. These are
      // tool-generated completions (not real user intent) that the tool injects
      // as User turns, e.g. "[SUGGESTION MODE: ...]". Extracting facts from them
      // poisons memory with content the user never actually said. Provider-
      // specific marker, but the harm (fake user facts) is delivery-agnostic.
      if (
        section.startsWith('## User') &&
        body.replace(/^[\s>*_-]+/, '').startsWith('[SUGGESTION')
      ) {
        continue
      }

      // Skip empty sections (tool call artifacts, empty user messages)
      if (body.length > 0) {
        kept.push(clean.trim())
      }
    }
    // Everything else (## System, frontmatter, unknown sections) is silently dropped
  }

  return kept.join('\n\n')
}

/**
 * Check if a cleaned session has enough real user content to be worth extracting.
 * Returns true if there are at least 2 user messages with substantive content (>20 chars).
 */
export function hasSubstantiveContent(cleanedContent: string): boolean {
  const userMessages = cleanedContent.match(/^## User\n([\s\S]*?)(?=^## |Z)/gm) ?? []
  const substantive = userMessages.filter((msg) => {
    const body = msg.replace(/^## User\n/, '').trim()
    return body.length > 20
  })
  return substantive.length >= 2
}
