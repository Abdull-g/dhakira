// Parse captured conversations into individual turn pairs and write them to disk
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedMessage, Result } from '../proxy/types.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import type { ContentBlock, TraceMessage, TraceRole } from './ingest.js'
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
  /** Non-searchable capture metadata for tool-aware extraction. */
  metadata?: {
    toolsUsed: string[]
  }
}

type ExtractionState = 'awaiting_user' | 'awaiting_assistant' | 'awaiting_tool_result'

interface ExtractionContext {
  pairs: TurnPair[]
  turnIndex: number
  state: ExtractionState
  pendingUser: string
  assistantParts: string[]
  toolsUsed: Set<string>
  tool: string
  sessionId: string
  timestamp: Date
  contextFingerprint: string
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract turn pairs from a list of normalized messages.
 *
 * Walks the conversation with a small state machine so assistant tool-use
 * roundtrips are stitched into one searchable user → assistant pair.
 */
export function extractTurnPairs(
  messages: Array<NormalizedMessage | TraceMessage>,
  tool: string,
  sessionId: string,
  timestamp: Date,
  contextFingerprint = 'default',
): TurnPair[] {
  const context: ExtractionContext = {
    pairs: [],
    turnIndex: 0,
    state: 'awaiting_user',
    pendingUser: '',
    assistantParts: [],
    toolsUsed: new Set<string>(),
    tool,
    sessionId,
    timestamp,
    contextFingerprint,
  }

  for (const message of messages) {
    advanceExtraction(context, message)
  }

  return context.pairs
}

function advanceExtraction(
  context: ExtractionContext,
  message: NormalizedMessage | TraceMessage,
): void {
  const role = getRole(message)
  if (role === 'system') return

  if (context.state === 'awaiting_user') {
    beginUserIfPresent(context, message)
    return
  }

  if (context.state === 'awaiting_assistant') {
    handleAwaitingAssistant(context, message)
    return
  }

  handleAwaitingToolResult(context, message)
}

function beginUserIfPresent(
  context: ExtractionContext,
  message: NormalizedMessage | TraceMessage,
): void {
  if (getRole(message) === 'user' && !isToolResultMessage(message)) {
    resetForUser(context, getText(message))
  }
}

function handleAwaitingAssistant(
  context: ExtractionContext,
  message: NormalizedMessage | TraceMessage,
): void {
  if (getRole(message) === 'user' && !isToolResultMessage(message)) {
    resetForUser(context, getText(message))
    return
  }

  if (getRole(message) !== 'assistant') return
  appendAssistant(message, context.assistantParts, context.toolsUsed)
  if (hasToolUse(message)) {
    context.state = 'awaiting_tool_result'
    return
  }
  emitPair(context)
  reset(context)
}

function handleAwaitingToolResult(
  context: ExtractionContext,
  message: NormalizedMessage | TraceMessage,
): void {
  if (isToolResultMessage(message)) {
    context.state = 'awaiting_assistant'
    return
  }

  if (getRole(message) === 'assistant') {
    appendAssistant(message, context.assistantParts, context.toolsUsed)
    if (!hasToolUse(message)) {
      emitPair(context)
      reset(context)
    }
    return
  }

  beginUserIfPresent(context, message)
}

function resetForUser(context: ExtractionContext, userContent: string): void {
  context.pendingUser = userContent
  context.assistantParts = []
  context.toolsUsed = new Set<string>()
  context.state = userContent.trim().length > 0 ? 'awaiting_assistant' : 'awaiting_user'
}

function emitPair(context: ExtractionContext): void {
  const userContent = redactSecrets(context.pendingUser).cleaned
  const assistantContent = redactSecrets(context.assistantParts.join('\n')).cleaned
  if (userContent.trim().length === 0 || assistantContent.trim().length === 0) return

  context.pairs.push({
    id: generateId('turn'),
    userContent,
    assistantContent,
    timestamp: context.timestamp.toISOString(),
    tool: context.tool,
    sessionId: context.sessionId,
    turnIndex: context.turnIndex,
    contextFingerprint: context.contextFingerprint,
    metadata: { toolsUsed: [...context.toolsUsed] },
  })

  context.turnIndex++
}

function reset(context: ExtractionContext): void {
  context.pendingUser = ''
  context.assistantParts = []
  context.toolsUsed = new Set<string>()
  context.state = 'awaiting_user'
}

function getRole(message: NormalizedMessage | TraceMessage): NormalizedMessage['role'] | TraceRole {
  return message.role
}

function getText(message: NormalizedMessage | TraceMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
}

function hasToolUse(message: NormalizedMessage | TraceMessage): boolean {
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use')
  )
}

function isToolResultMessage(message: NormalizedMessage | TraceMessage): boolean {
  if (message.role === 'tool') return true
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function appendAssistant(
  message: NormalizedMessage | TraceMessage,
  assistantParts: string[],
  toolsUsed: Set<string>,
): void {
  const text = getText(message)
  if (text.trim().length > 0) assistantParts.push(text)

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      addToolName(block, toolsUsed)
    }
  }
}

function addToolName(block: ContentBlock, toolsUsed: Set<string>): void {
  if (block.type === 'tool_use' && block.name.length > 0) {
    toolsUsed.add(block.name)
  }
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
 * Write already-extracted turn pairs to disk and return path+content for indexing.
 *
 * Unlike storeTurnPairsWithContent, this does not re-run extraction. Use it when
 * earlier capture stages have already sanitized, extracted, and filtered pairs.
 */
export async function writeExtractedPairs(
  pairs: TurnPair[],
  walletDir: string,
): Promise<Array<Result<StoredTurnPair>>> {
  return Promise.all(pairs.map((pair) => writeTurnPairWithContent(pair, walletDir)))
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
