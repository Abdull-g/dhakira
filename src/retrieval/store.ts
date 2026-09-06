// QMD store initialization and management
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { QMDStore } from '@tobilu/qmd'
import { createStore as qmdCreateStore } from '@tobilu/qmd'

import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'

export interface WalletStoreOptions {
  /**
   * Keep QMD's search models resident for the process lifetime (default true).
   * See WalletConfig.retrieval.modelsResident for the RAM cost and rationale.
   */
  modelsResident?: boolean
}

/**
 * The runtime shape of QMD's per-store LlamaCpp handle that model residency
 * depends on. These are plain (TypeScript-private) instance fields in QMD 2.0.1
 * — `createStore` hardcodes `inactivityTimeoutMs: 5 min` +
 * `disposeModelsOnInactivity: true` with no StoreOptions knob, so the only way to
 * keep models loaded is to flip them after construction. Guarded: if a future
 * QMD renames them, residency silently degrades to QMD's default and we log it.
 */
interface ResidencyHandle {
  inactivityTimeoutMs: number
  disposeModelsOnInactivity: boolean
}

function isResidencyHandle(value: unknown): value is ResidencyHandle {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.inactivityTimeoutMs === 'number' && typeof v.disposeModelsOnInactivity === 'boolean'
  )
}

/**
 * D2 (v0.3.1): make QMD's models resident. QMD's default disposes the
 * query-expansion / embedding / reranker models after 5 minutes idle; the first
 * recall after any pause then reloads them INSIDE the hook's 1.5 s budget, the
 * hook aborts, and the user silently gets no memory. With the timer disabled
 * (`inactivityTimeoutMs = 0` → QMD never schedules the unload) the models stay
 * warm for the daemon's lifetime at ~2 GB of RAM.
 *
 * Returns whether residency could be applied (false = QMD internals drifted).
 */
export function applyModelResidency(store: QMDStore, modelsResident: boolean): boolean {
  if (!modelsResident) return false
  const llm: unknown = (store as { internal?: { llm?: unknown } }).internal?.llm
  if (!isResidencyHandle(llm)) {
    createLogger('retrieval').warn(
      'Model residency not applied: QMD internal llm handle has an unexpected shape',
    )
    return false
  }
  llm.inactivityTimeoutMs = 0
  llm.disposeModelsOnInactivity = false
  return true
}

/**
 * Initialize the QMD store for Dhakira.
 *
 * Configures two searchable collections:
 *   - "memories" — extracted memory facts about the user
 *   - "turns"    — individual turn pair files (v2 RAG-first primary index)
 *
 * The conversations/ directory is still created as a raw audit log on disk,
 * but it is not registered as a searchable QMD collection.
 *
 * The SQLite index lives at {walletDir}/wallet.sqlite.
 * Parent directories are created automatically if they don't exist.
 */
export async function createWalletStore(
  walletDir: string,
  options: WalletStoreOptions = {},
): Promise<Result<QMDStore>> {
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

    const modelsResident = options.modelsResident ?? true
    const resident = applyModelResidency(store, modelsResident)

    logger.info('QMD store initialized', { walletDir, modelsResident: resident })
    return { ok: true, value: store }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Failed to initialize QMD store', { error: message, walletDir })
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}
