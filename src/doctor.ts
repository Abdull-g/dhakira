// `dhakira doctor` — measure one representative recall against the 1.5 s hook
// budget and say PASS or WARN in plain words (D2, v0.3.1).
//
// Why this exists: the hook adapters fail open. A slow daemon does not produce an
// error the user can see — it produces "Claude just didn't remember". This check
// makes latency a first-class, measurable thing.
//
// NO NETWORK: the only I/O is (a) loopback HTTP to the user's OWN running daemon,
// which is the most faithful measurement of what a hook experiences, or (b) when
// the daemon is not running, an in-process search over the wallet. In case (b)
// hybrid search is attempted ONLY if QMD's models are already on disk — otherwise
// QMD would start downloading ~2 GB, which a diagnostic must never do.
//
// Engine-side module: imports retrieval + config only (Standing Order #7).

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'

import type { WalletConfig } from './config/schema.js'
import { getRetrievalMetrics, type RetrievalMetrics } from './retrieval/metrics.js'
import { QMDBackend } from './retrieval/qmd-backend.js'
import { rankCandidates } from './retrieval/ranker.js'
import { HYBRID_DEADLINE_MS, searchTurns } from './retrieval/search.js'
import { createWalletStore } from './retrieval/store.js'

type Result<T> = import('./proxy/types.js').Result<T>

/** Mirrors src/hooks/shared-adapter.ts DEFAULT_TIMEOUT_MS — the product promise. */
export const HOOK_BUDGET_MS = 1500

/** A query shaped like what a hook sends: a real question about past work. */
export const REPRESENTATIVE_QUERY = 'what did we decide about the architecture of this project'

export type RecallPath =
  | 'daemon' // measured through the running daemon's /api/recall (what a hook sees)
  | 'hybrid' // in-process hybrid search answered before the deadline
  | 'bm25-deadline' // in-process hybrid missed the deadline; BM25 served
  | 'bm25-only' // in-process BM25 only — models not on disk, hybrid not attempted
  | 'error'

export interface DoctorReport {
  hookBudgetMs: number
  hybridDeadlineMs: number
  daemonRunning: boolean
  modelsPresent: boolean
  modelsResident: boolean
  recall: {
    path: RecallPath
    measuredMs: number
    turnCount: number
    error?: string
  }
  /** Daemon-side counters when the daemon answered; null otherwise. */
  daemonMetrics: Pick<
    RetrievalMetrics,
    'recallCount' | 'recallTimeouts' | 'lastRecallTimeoutAt' | 'maxRecallMs'
  > | null
  verdict: 'pass' | 'warn'
  notes: string[]
}

export interface DoctorDeps {
  config: WalletConfig
  /** Loopback fetch to the daemon. Injectable so tests never open sockets. */
  fetchImpl?: typeof fetch
  /** Whether QMD's three search models are already on disk. */
  modelsPresent?: () => boolean
  /** Store opener for the in-process path. */
  openStore?: (walletDir: string) => Promise<Result<QMDStore>>
  /** Clock, for deterministic tests. */
  now?: () => number
}

/**
 * QMD 2.0.1 caches models under ~/.cache/qmd/models (llm.js MODEL_CACHE_DIR) as
 * `hf_<owner>_<file>.gguf`; a partial download carries a `.ipull` suffix. All
 * three (query-expansion, embedding, reranker) must be complete for hybrid
 * search to run without downloading.
 */
export function defaultModelsPresent(
  cacheDir = join(homedir(), '.cache', 'qmd', 'models'),
): boolean {
  let files: string[]
  try {
    files = readdirSync(cacheDir)
  } catch {
    return false
  }
  const complete = files.filter((f) => f.endsWith('.gguf'))
  const has = (needle: string): boolean => complete.some((f) => f.includes(needle))
  return has('query-expansion') && has('embeddinggemma') && has('reranker')
}

async function daemonStatus(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/status`, {
      signal: AbortSignal.timeout(HOOK_BUDGET_MS),
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function measureViaDaemon(
  baseUrl: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<{ measuredMs: number; turnCount: number; error?: string }> {
  const started = now()
  try {
    const res = await fetchImpl(`${baseUrl}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dhakira-Client': 'cli' },
      body: JSON.stringify({ query: REPRESENTATIVE_QUERY, tool: 'doctor' }),
      // Deliberately generous: we want the TRUE latency, not the hook's abort.
      signal: AbortSignal.timeout(HOOK_BUDGET_MS * 10),
    })
    const measuredMs = now() - started
    if (!res.ok) return { measuredMs, turnCount: 0, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { turnCount?: unknown }
    return { measuredMs, turnCount: typeof body.turnCount === 'number' ? body.turnCount : 0 }
  } catch (err) {
    return {
      measuredMs: now() - started,
      turnCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function measureInProcess(
  deps: Required<Pick<DoctorDeps, 'config' | 'openStore' | 'now'>>,
  modelsPresent: boolean,
): Promise<{ path: RecallPath; measuredMs: number; turnCount: number; error?: string }> {
  const storeResult = await deps.openStore(deps.config.walletDir)
  if (!storeResult.ok) {
    return { path: 'error', measuredMs: 0, turnCount: 0, error: storeResult.error.message }
  }
  const store = storeResult.value
  const started = deps.now()
  try {
    if (!modelsPresent) {
      // Never trigger a model download from a diagnostic: BM25 only.
      const backend = new QMDBackend(store)
      const raw = await backend.searchLex(REPRESENTATIVE_QUERY, { collection: 'turns', limit: 16 })
      const ranked = rankCandidates(raw, { query: REPRESENTATIVE_QUERY, limit: 8 })
      return { path: 'bm25-only', measuredMs: deps.now() - started, turnCount: ranked.length }
    }
    const before = getRetrievalMetrics().recallTimeouts
    const result = await searchTurns(store, { query: REPRESENTATIVE_QUERY, limit: 8 })
    const measuredMs = deps.now() - started
    if (!result.ok) return { path: 'error', measuredMs, turnCount: 0, error: result.error.message }
    const deadlineHit = getRetrievalMetrics().recallTimeouts > before
    return {
      path: deadlineHit ? 'bm25-deadline' : 'hybrid',
      measuredMs,
      turnCount: result.value.length,
    }
  } finally {
    try {
      await store.close()
    } catch {
      // best effort
    }
  }
}

/**
 * Run the doctor check. Prefers the running daemon (hook's-eye view); falls back
 * to an in-process measurement. Never throws.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const modelsPresent = (deps.modelsPresent ?? defaultModelsPresent)()
  const openStore =
    deps.openStore ??
    ((walletDir: string) => createWalletStore(walletDir, { modelsResident: false }))
  const { host, port } = deps.config.dashboard
  const baseUrl = `http://${host}:${port}`
  const notes: string[] = []

  const status = await daemonStatus(baseUrl, fetchImpl)
  const daemonRunning = status !== null

  let recall: DoctorReport['recall']
  let daemonMetrics: DoctorReport['daemonMetrics'] = null
  if (daemonRunning) {
    const measured = await measureViaDaemon(baseUrl, fetchImpl, now)
    recall = { path: measured.error ? 'error' : 'daemon', ...measured }
    daemonMetrics = {
      recallCount: numberOr(status.recallCount, 0),
      recallTimeouts: numberOr(status.recallTimeouts, 0),
      lastRecallTimeoutAt:
        typeof status.lastRecallTimeoutAt === 'string' ? status.lastRecallTimeoutAt : null,
      maxRecallMs: typeof status.maxRecallMs === 'number' ? status.maxRecallMs : null,
    }
  } else {
    notes.push(
      'Daemon not running — measured in-process (a cold process; the daemon keeps models warm).',
    )
    recall = await measureInProcess({ config: deps.config, openStore, now }, modelsPresent)
  }

  const partial = {
    hookBudgetMs: HOOK_BUDGET_MS,
    hybridDeadlineMs: HYBRID_DEADLINE_MS,
    daemonRunning,
    modelsPresent,
    modelsResident: deps.config.retrieval.modelsResident,
    recall,
    daemonMetrics,
  }
  notes.push(...explain(partial))
  return { ...partial, verdict: judge(partial), notes }
}

type Findings = Omit<DoctorReport, 'verdict' | 'notes'>

/** PASS only when a healthy path answered inside the budget with models available. */
function judge(f: Findings): DoctorReport['verdict'] {
  const withinBudget = f.recall.measuredMs < HOOK_BUDGET_MS
  const healthyPath = f.recall.path === 'daemon' || f.recall.path === 'hybrid'
  return withinBudget && healthyPath && !f.recall.error && f.modelsPresent ? 'pass' : 'warn'
}

/** Human-readable reasons behind the verdict — every WARN has at least one. */
function explain(f: Findings): string[] {
  const notes: string[] = []
  if (!f.modelsPresent) {
    notes.push(
      'Search models are not downloaded — hybrid search was not measured. Run `dhakira start` once (downloads ~2 GB) to enable it.',
    )
  }
  if (f.recall.path === 'bm25-deadline') {
    notes.push(
      `Hybrid search missed the ${HYBRID_DEADLINE_MS} ms daemon deadline (cold models); BM25 was served inside the budget. With the daemon running and retrieval.modelsResident=true this is a one-time cost.`,
    )
  }
  if (f.daemonMetrics && f.daemonMetrics.recallTimeouts > 0) {
    const last = f.daemonMetrics.lastRecallTimeoutAt
    notes.push(
      `The daemon has served BM25 on ${f.daemonMetrics.recallTimeouts} of ${f.daemonMetrics.recallCount} recalls because hybrid missed the deadline${last ? ` (last: ${last})` : ''}.`,
    )
  }
  if (!f.modelsResident) {
    notes.push(
      'retrieval.modelsResident is false — models unload after 5 min idle, so the first recall after a pause will be served by BM25.',
    )
  }
  if (f.recall.error) notes.push(`Recall failed: ${f.recall.error}`)
  if (f.recall.measuredMs >= HOOK_BUDGET_MS) {
    notes.push(
      `Measured ${f.recall.measuredMs} ms exceeds the ${HOOK_BUDGET_MS} ms hook budget — hooks would have aborted (fail-open) and injected nothing.`,
    )
  }
  return notes
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}
