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

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse } from 'yaml'

import { createLogger } from '../utils/logger.js'

export interface SessionFile {
  /** Path to the representative file for this session */
  filePath: string
  /** Conversation ID from frontmatter */
  id: string
  /** Number of user+assistant messages */
  messageCount: number
  /** Model used */
  model: string
  /** Timestamp from frontmatter */
  timestamp: string
  /** Tool name */
  tool: string
}

interface CaptureInfo {
  filePath: string
  id: string
  messageCount: number
  model: string
  timestamp: string
  tool: string
  incognito: boolean
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
 */
export async function reconstructSessions(walletDir: string): Promise<SessionFile[]> {
  const logger = createLogger('session-reconstructor')
  const convDir = join(walletDir, 'conversations')

  // Read all capture files
  let relPaths: string[] = []
  try {
    const entries = (await readdir(convDir, { recursive: true })) as string[]
    relPaths = entries.filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }

  // Parse metadata from each file
  const captures: CaptureInfo[] = []
  for (const rel of relPaths) {
    const filePath = join(convDir, rel)
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    const fm = parseFrontmatter(content)
    if (!fm?.id) continue

    captures.push({
      filePath,
      id: String(fm.id),
      messageCount: countMessages(content),
      model: String(fm.model ?? ''),
      timestamp: String(fm.timestamp ?? ''),
      tool: String(fm.tool ?? ''),
      incognito: Boolean(fm.incognito),
    })
  }

  // Sort by timestamp for chronological processing
  captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Walk through and group into sessions
  // A session is a sequence of files from the same tool where message count
  // is monotonically increasing (each file is the previous + more messages).
  // When message count drops, it's a new session.
  const sessions: CaptureInfo[][] = []
  let currentSession: CaptureInfo[] = []
  let prevMsgCount = -1
  let prevTool = ''

  for (const capture of captures) {
    // Skip incognito
    if (capture.incognito) continue

    // Skip internal tool calls
    if (isInternalToolCall(capture)) continue

    const isContinuation = capture.tool === prevTool && capture.messageCount > prevMsgCount

    if (isContinuation) {
      currentSession.push(capture)
    } else {
      // New session — flush the previous one
      if (currentSession.length > 0) {
        sessions.push(currentSession)
      }
      currentSession = [capture]
    }

    prevMsgCount = capture.messageCount
    prevTool = capture.tool
  }

  // Don't forget the last session
  if (currentSession.length > 0) {
    sessions.push(currentSession)
  }

  // From each session, pick the LAST file (most complete)
  const representatives: SessionFile[] = []
  for (const session of sessions) {
    const best = session[session.length - 1]

    // Skip sessions with very few messages (not enough content for extraction)
    if (best.messageCount < 3) continue

    representatives.push({
      filePath: best.filePath,
      id: best.id,
      messageCount: best.messageCount,
      model: best.model,
      timestamp: best.timestamp,
      tool: best.tool,
    })
  }

  logger.info('Sessions reconstructed', {
    totalCaptures: captures.length,
    sessions: sessions.length,
    representatives: representatives.length,
    filtered: sessions.length - representatives.length,
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
