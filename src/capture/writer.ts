// Write conversations to markdown files
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { formatConversation } from './formatter.js'
import type { CapturedConversation } from './types.js'

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Expand a leading ~ to the user's home directory */
function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return homedir() + p.slice(1)
  }
  return p
}

/**
 * Build the file path for a conversation.
 * Pattern: {walletDir}/conversations/{YYYY-MM-DD}/{tool}-{HHhMMm}-{shortId}.md
 * Example: ~/.dhakira/conversations/2026-03-20/cursor-01h30m-abc123.md
 */
export function buildFilePath(walletDir: string, conversation: CapturedConversation): string {
  const d = conversation.timestamp
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}h${pad2(d.getMinutes())}m`
  const shortId = conversation.id.slice(-6)
  const filename = `${conversation.tool}-${time}-${shortId}.md`
  return join(expandPath(walletDir), 'conversations', date, filename)
}

/**
 * Write a captured conversation to a markdown file on disk.
 *
 * - Auto-creates parent directories (equivalent to mkdir -p)
 * - Returns Result<filePath> — never throws
 * - Logs errors internally so the caller can fire-and-forget safely
 */
export async function writeConversation(
  conversation: CapturedConversation,
  walletDir: string,
): Promise<Result<string>> {
  const logger = createLogger('capture')
  const filePath = buildFilePath(walletDir, conversation)

  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, formatConversation(conversation), 'utf8')
    logger.info('Conversation saved', { id: conversation.id, path: filePath })
    return { ok: true, value: filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Failed to write conversation', { id: conversation.id, error: message })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
