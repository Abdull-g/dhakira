// Parse captured conversations into individual turn pairs and write them to disk
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedMessage, Result } from '../proxy/types.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { redactSecrets } from './secrets.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnPair {
  /** Unique ID for this turn pair */
  id: string
  /** The user's message */
  userContent: string
  /** The assistant's response */
  assistantContent: string
  /** ISO timestamp of when this exchange happened */
  timestamp: string
  /** Which tool generated this (e.g., "claude-code") */
  tool: string
  /** Session ID — groups turn pairs from the same conversation */
  sessionId: string
  /** Turn index within the session (0-based) */
  turnIndex: number
  /** SHA-256 fingerprint of the tool's system prompt (first 12 hex chars).
   *  "default" when no system prompt was present. Used to boost same-project turns. */
  contextFingerprint: string
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract turn pairs from a list of normalized messages.
 *
 * Rules:
 * - System messages are skipped (they are not conversation turns).
 * - Pairs consecutive user + assistant messages (user comes first).
 * - If a user message has no following assistant message it is dropped
 *   (partial turn — not enough context to be useful).
 * - Secrets are redacted from both sides of each pair before returning.
 */
export function extractTurnPairs(
  messages: NormalizedMessage[],
  tool: string,
  sessionId: string,
  timestamp: Date,
  contextFingerprint = 'default',
): TurnPair[] {
  const conversationMessages = messages.filter((m) => m.role !== 'system')

  const pairs: TurnPair[] = []
  let turnIndex = 0
  let i = 0

  while (i < conversationMessages.length) {
    const msg = conversationMessages[i]

    if (msg.role === 'user') {
      const next = conversationMessages[i + 1]
      if (next?.role === 'assistant') {
        const { cleaned: userContent } = redactSecrets(msg.content)
        const { cleaned: assistantContent } = redactSecrets(next.content)

        pairs.push({
          id: generateId('turn'),
          userContent,
          assistantContent,
          timestamp: timestamp.toISOString(),
          tool,
          sessionId,
          turnIndex,
          contextFingerprint,
        })

        turnIndex++
        i += 2
        continue
      }
    }

    // Skip non-user messages and orphaned user messages
    i++
  }

  return pairs
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return homedir() + p.slice(1)
  }
  return p
}

/**
 * Build the file path for a turn pair.
 * Pattern: {walletDir}/turns/{YYYY-MM-DD}/{sessionId}-{turnIndex}.md
 */
export function buildTurnFilePath(walletDir: string, pair: TurnPair): string {
  const d = new Date(pair.timestamp)
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const filename = `${pair.sessionId}-${pair.turnIndex}.md`
  return join(expandPath(walletDir), 'turns', date, filename)
}

/**
 * Render a TurnPair as a markdown string with YAML frontmatter.
 *
 * Format matches what CLAUDE.md specifies so QMD can index it correctly.
 */
export function formatTurnPair(pair: TurnPair): string {
  const frontmatter = [
    '---',
    `id: ${pair.id}`,
    `sessionId: ${pair.sessionId}`,
    `tool: ${pair.tool}`,
    `timestamp: ${pair.timestamp}`,
    `turnIndex: ${pair.turnIndex}`,
    `contextFingerprint: ${pair.contextFingerprint}`,
    '---',
  ].join('\n')

  return `${frontmatter}\n\n## User\n${pair.userContent}\n\n## Assistant\n${pair.assistantContent}\n`
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Write a single turn pair to {walletDir}/turns/{YYYY-MM-DD}/{sessionId}-{turnIndex}.md
 *
 * - Creates parent directories automatically.
 * - Returns Result<filePath> — never throws.
 */
export async function writeTurnPair(pair: TurnPair, walletDir: string): Promise<Result<string>> {
  const logger = createLogger('capture:turns')
  const filePath = buildTurnFilePath(walletDir, pair)
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, formatTurnPair(pair), 'utf8')
    logger.info('Turn pair saved', { id: pair.id, path: filePath })
    return { ok: true, value: filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Failed to write turn pair', { id: pair.id, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}

/**
 * Result from writing a turn pair that includes the file content for direct indexing.
 */
export interface StoredTurnPair {
  /** Absolute path to the written .md file */
  filePath: string
  /** Full markdown content of the file (same as what was written to disk) */
  content: string
}

/**
 * Write a single turn pair to disk and return both path and content.
 *
 * Same as writeTurnPair but also returns the generated content so callers
 * can register it directly into the search index without re-reading the file.
 */
export async function writeTurnPairWithContent(
  pair: TurnPair,
  walletDir: string,
): Promise<Result<StoredTurnPair>> {
  const logger = createLogger('capture:turns')
  const filePath = buildTurnFilePath(walletDir, pair)
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  const content = formatTurnPair(pair)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content, 'utf8')
    logger.info('Turn pair saved', { id: pair.id, path: filePath })
    return { ok: true, value: { filePath, content } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Failed to write turn pair', { id: pair.id, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}

/**
 * Extract turn pairs from a conversation and write each one to disk.
 *
 * This is the main entry point called from the capture pipeline.
 * Errors from individual writes are logged but do not abort the remaining writes.
 *
 * Returns an array of Results (one per pair) for callers that want to inspect outcomes.
 */
export async function storeTurnPairs(
  messages: NormalizedMessage[],
  tool: string,
  sessionId: string,
  timestamp: Date,
  walletDir: string,
  contextFingerprint = 'default',
): Promise<Array<Result<string>>> {
  const pairs = extractTurnPairs(messages, tool, sessionId, timestamp, contextFingerprint)
  return Promise.all(pairs.map((pair) => writeTurnPair(pair, walletDir)))
}

/**
 * Extract turn pairs from a conversation, write each to disk, and return
 * both path and content for direct index registration.
 *
 * This is the new entry point for the capture → index pipeline.
 */
export async function storeTurnPairsWithContent(
  messages: NormalizedMessage[],
  tool: string,
  sessionId: string,
  timestamp: Date,
  walletDir: string,
  contextFingerprint = 'default',
): Promise<Array<Result<StoredTurnPair>>> {
  const pairs = extractTurnPairs(messages, tool, sessionId, timestamp, contextFingerprint)
  return Promise.all(pairs.map((pair) => writeTurnPairWithContent(pair, walletDir)))
}
