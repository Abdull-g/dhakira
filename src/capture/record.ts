// Engine entry point for explicit user-recorded memories.
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'

import { indexTurnPair } from '../retrieval/indexer.js'
import { createWalletStore } from '../retrieval/store.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { type TurnPair, writeTurnPairWithContent } from './turns.js'

type Result<T> = import('../proxy/types.js').Result<T>

const TOOL = 'user-recorded'
const SESSION_ID = 'user-records'
const MAX_INPUT_LENGTH = 10_000

export interface RecordTurnOptions {
  /** Existing QMD store to index into. If omitted, a wallet store is opened for this call. */
  store?: QMDStore
}

/**
 * Record a user-supplied fact as a single turn pair.
 *
 * The content is trimmed but otherwise preserved, written through the standard
 * turn-pair writer, then registered in the turns index. Indexing failures are
 * intentionally non-fatal because the markdown file is already durable on disk.
 */
export async function recordTurn(
  walletDir: string,
  userInput: string,
  opts: RecordTurnOptions = {},
): Promise<Result<TurnPair>> {
  if (userInput.trim().length === 0) {
    return { ok: false, error: new Error('recordTurn: empty input') }
  }

  if (userInput.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: new Error('recordTurn: input exceeds 10000 chars') }
  }

  const turnPair: TurnPair = {
    id: generateId('turn'),
    userContent: userInput.trim(),
    assistantContent: '',
    timestamp: new Date().toISOString(),
    tool: TOOL,
    sessionId: SESSION_ID,
    turnIndex: await nextUserRecordTurnIndex(walletDir),
    contextFingerprint: 'default',
    projectId: 'global',
    userRecorded: true,
  }

  const writeResult = await writeTurnPairWithContent(turnPair, walletDir)
  if (!writeResult.ok) return { ok: false, error: writeResult.error }

  await indexRecordedTurn(
    walletDir,
    writeResult.value.filePath,
    writeResult.value.content,
    opts.store,
  )

  return { ok: true, value: turnPair }
}

async function indexRecordedTurn(
  walletDir: string,
  filePath: string,
  content: string,
  store: QMDStore | undefined,
): Promise<void> {
  const logger = createLogger('capture:record')
  const storeResult = store
    ? { ok: true as const, value: store }
    : await createWalletStore(walletDir)

  if (!storeResult.ok) {
    logger.warn('Record indexing skipped: store initialization failed', {
      error: storeResult.error.message,
    })
    return
  }

  try {
    await indexTurnPair(storeResult.value, filePath, content, expandedWalletDir(walletDir))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('Record indexing failed after disk write', { error: message, path: filePath })
  } finally {
    if (!store) {
      try {
        await storeResult.value.close()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('Record index store close failed', { error: message })
      }
    }
  }
}

async function nextUserRecordTurnIndex(walletDir: string): Promise<number> {
  const turnsRoot = join(expandedWalletDir(walletDir), 'turns')

  try {
    const dateDirs = await readdir(turnsRoot, { withFileTypes: true })
    let count = 0

    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory()) continue

      const entries = await readdir(join(turnsRoot, dateDir.name), { withFileTypes: true })
      count += entries.filter(
        (entry) => entry.isFile() && /^user-records-\d+\.md$/.test(entry.name),
      ).length
    }

    return count
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return 0
    throw err
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

function expandedWalletDir(walletDir: string): string {
  if (walletDir === '~' || walletDir.startsWith('~/') || walletDir.startsWith('~\\')) {
    return homedir() + walletDir.slice(1)
  }
  return walletDir
}
