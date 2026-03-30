// QMD store initialization and management
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { createStore as qmdCreateStore } from '@tobilu/qmd'

import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'

/**
 * Initialize the QMD store for Dhakira.
 *
 * Configures three collections:
 *   - "conversations" — markdown conversation files from the proxy capture
 *   - "memories"      — extracted memory facts about the user
 *   - "turns"         — individual turn pair files (v2 RAG-first primary index)
 *
 * The SQLite index lives at {walletDir}/wallet.sqlite.
 * Parent directories are created automatically if they don't exist.
 */
export async function createWalletStore(walletDir: string): Promise<Result<QMDStore>> {
  const logger = createLogger('retrieval')

  try {
    // Ensure collection directories exist before QMD tries to scan them
    await mkdir(join(walletDir, 'conversations'), { recursive: true })
    await mkdir(join(walletDir, 'memories'), { recursive: true })
    await mkdir(join(walletDir, 'turns'), { recursive: true })

    const store = await qmdCreateStore({
      dbPath: join(walletDir, 'wallet.sqlite'),
      config: {
        collections: {
          conversations: {
            path: join(walletDir, 'conversations'),
            pattern: '**/*.md',
            context: {
              '/': 'AI conversation history captured from tools like Cursor and Claude Code',
            },
          },
          memories: {
            path: join(walletDir, 'memories'),
            pattern: '**/*.md',
            context: {
              '/': 'Personal memories and facts extracted from AI conversations',
            },
          },
          turns: {
            path: join(walletDir, 'turns'),
            pattern: '**/*.md',
            context: {
              '/': 'Individual conversation turn pairs — one user message and one assistant response per file',
            },
          },
        },
      },
    })

    logger.info('QMD store initialized', { walletDir })
    return { ok: true, value: store }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Failed to initialize QMD store', { error: message, walletDir })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
