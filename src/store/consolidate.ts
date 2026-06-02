// Off-line consolidation (Step 5). Sweeps the ACTIVE slow store, clusters
// near-duplicate/refining memories, and (in CP2+) merges each cluster into one
// denser memory — superseding the sources. CLS sleep-consolidation analog.
// Idempotent + LEAVE_AS_IS-floored + supersede-only (never deletes).

import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { parse } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import { buildExtractionHarness } from '../extraction/extract.js'
import { CONSOLIDATE_PROMPT, fillTemplate } from '../extraction/prompts.js'
import {
  invalidateMemoryFile,
  readMemoryConsolidated,
  writeMemoryFile,
} from '../extraction/runner.js'
import type { ExtractedFact, MemoryRecord } from '../extraction/types.js'
import type { ModelHarness } from '../harness/harness.js'
import type { HarnessTask } from '../harness/types.js'
import { scoreSalience } from '../salience/salience.js'
import type { SalienceTier } from '../salience/types.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { computeExpiresAt } from './tier-policy.js'

type Result<T> = import('../proxy/types.js').Result<T>

const logger = createLogger('consolidate')

const SALIENCE_TIERS: readonly SalienceTier[] = ['core', 'standard', 'trivia']
const DEFAULT_SALIENCE_TIER: SalienceTier = 'standard'
const VALID_CATEGORIES: readonly ExtractedFact['category'][] = [
  'IDENTITY',
  'PREFERENCE',
  'CONTEXT',
  'RELATIONSHIP',
  'SKILL',
  'EVENT',
]
const VALID_CONFIDENCES: readonly ExtractedFact['confidence'][] = ['HIGH', 'MEDIUM', 'LOW']

/**
 * Minimum HYBRID search score for two memories to be grouped as consolidation
 * candidates. ⚠️ UNVALIDATED — PENDING REMOTE CALIBRATION. An earlier 0.5 was
 * derived from BM25's |bm25|/(1+|bm25|) mapping, which does NOT transfer to the
 * hybrid (vector + rerank) score distribution we now query against. The hybrid
 * models can't run on the dev host (8GB Intel) — this number must be measured on
 * REMOTE compute before it's trusted. It is a cheap recall PREFILTER that MUST
 * err toward over-INCLUSION (catch candidates, let the model reject) — the MODEL
 * + LEAVE_AS_IS floor (CP2) is the real safety net. Module constant (NOT config)
 * so it's trivially tunable once a real wallet is measured.
 */
const CLUSTER_SCORE_THRESHOLD = 0.5

/** Top-N neighbors pulled per memory (same limit update.ts uses for dedup search). */
const CLUSTER_NEIGHBOR_LIMIT = 5

/**
 * Hard cap on cluster size. A near-dup cluster should be small; a component that
 * blows past this is almost certainly a lexical-hub artifact (a common term
 * linking unrelated memories transitively). We never feed an oversized cluster
 * to the model — it's skipped + LOUDLY logged (LEAVE_AS_IS by omission).
 */
const MAX_CLUSTER_SIZE = 6

/**
 * A single ACTIVE slow-store memory, loaded for consolidation. Active means
 * `invalidatedAt` is null/unset (superseded sources are excluded). `consolidated`
 * marks an output of a PRIOR consolidation run — the idempotency guard treats
 * those specially (see clusterMemories).
 */
export interface ActiveMemory {
  id: string
  body: string
  category: ExtractedFact['category']
  confidence: ExtractedFact['confidence']
  salienceTier: SalienceTier
  /** When the fact became true — earliest among a cluster seeds the merged memory's validFrom. */
  validFrom: Date
  /** True if this memory was itself produced by a previous consolidation. */
  consolidated: boolean
  filePath: string
}

interface ParsedMemory {
  id: string
  category: ExtractedFact['category']
  confidence: ExtractedFact['confidence']
  salienceTier: SalienceTier
  validFrom: Date
  invalidatedAt: string | null | undefined
  body: string
}

function coerceCategory(raw: unknown): ExtractedFact['category'] {
  const v = String(raw ?? '')
  return (VALID_CATEGORIES as readonly string[]).includes(v)
    ? (v as ExtractedFact['category'])
    : 'CONTEXT'
}

function coerceConfidence(raw: unknown): ExtractedFact['confidence'] {
  const v = String(raw ?? '')
  return (VALID_CONFIDENCES as readonly string[]).includes(v)
    ? (v as ExtractedFact['confidence'])
    : 'LOW'
}

function coerceTier(raw: unknown): SalienceTier {
  const v = String(raw ?? '')
  return SALIENCE_TIERS.includes(v as SalienceTier) ? (v as SalienceTier) : DEFAULT_SALIENCE_TIER
}

/** Parse a frontmatter date; falls back to now if absent/unparseable (all real files have validFrom). */
function coerceDate(raw: unknown): Date {
  const d = new Date(String(raw ?? ''))
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/**
 * Parse a memory file's frontmatter + body. Mirrors the profile-gen enumeration
 * pattern (we do NOT import it — avoids a module cycle and profile-gen stays
 * untouched per T05 scope). Backward-compatible: missing fields fall back to
 * neutral defaults; absent `consolidated` → false.
 */
function parseMemoryFile(content: string, fallbackId: string): ParsedMemory | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match?.[1]) return null
  try {
    const fm = parse(match[1]) as Record<string, unknown>
    const body = (match[2] ?? '').trim()
    return {
      id: String(fm.id ?? fallbackId),
      category: coerceCategory(fm.category),
      confidence: coerceConfidence(fm.confidence),
      salienceTier: coerceTier(fm.salienceTier),
      validFrom: coerceDate(fm.validFrom),
      invalidatedAt:
        fm.invalidatedAt === null ? null : fm.invalidatedAt ? String(fm.invalidatedAt) : undefined,
      body,
    }
  } catch {
    return null
  }
}

/**
 * Enumerate every ACTIVE memory in the slow store. Mechanical: readdir recursive
 * → filter .md → parse frontmatter → skip invalidated (superseded) → skip empty
 * bodies. Mirrors profile-gen's collectHighConfidenceMemories enumeration, but
 * keeps ALL confidence levels (consolidation distills the whole active store,
 * not just HIGH-confidence profile inputs).
 */
export async function loadActiveMemories(walletDir: string): Promise<ActiveMemory[]> {
  const memoriesDir = join(walletDir, 'memories')
  let relPaths: string[]
  try {
    const entries = (await readdir(memoriesDir, { recursive: true })) as string[]
    relPaths = entries.filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }

  const active: ActiveMemory[] = []
  for (const rel of relPaths) {
    const filePath = join(memoriesDir, rel)
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = parseMemoryFile(content, basename(rel, '.md'))
      if (!parsed || parsed.invalidatedAt || !parsed.body) continue
      active.push({
        id: parsed.id,
        body: parsed.body,
        category: parsed.category,
        confidence: parsed.confidence,
        salienceTier: parsed.salienceTier,
        validFrom: parsed.validFrom,
        // Idempotency-guard input: did a prior sweep produce this memory?
        consolidated: readMemoryConsolidated(content),
        filePath,
      })
    } catch {
      // Skip unreadable files silently — never abort the sweep on one bad file.
    }
  }

  return active
}

/** A single neighbor hit, normalized across hybrid (.file) and lex (.filepath) shapes. */
interface NeighborHit {
  score: number
  file?: string
  filepath?: string
}

/** Resolve the memory id from a hit's filepath (e.g. qmd://memories/mem_x.md). */
function idFromHit(hit: NeighborHit): string {
  return basename(String(hit.file ?? hit.filepath ?? ''), '.md')
}

/**
 * Tracks the search mode for a sweep: hybrid first, degrade to BM25 (searchLex)
 * ONCE if hybrid is unavailable (cold env / CI / missing models / low-RAM host)
 * — never retry hybrid per-memory after it fails. This fallback is LOAD-BEARING,
 * not merely defensive: on hosts that can't run the embedding/rerank models it
 * is the path that actually executes. The lex fallback only catches near-EXACT
 * dups (BM25 is AND-of-terms), so we log the degrade LOUDLY.
 */
class NeighborSearcher {
  private useHybrid = true

  constructor(private readonly store: QMDStore) {}

  async neighbors(body: string): Promise<NeighborHit[]> {
    if (this.useHybrid) {
      try {
        return (await this.store.search({
          query: body,
          collection: 'memories',
          limit: CLUSTER_NEIGHBOR_LIMIT,
        })) as NeighborHit[]
      } catch (err) {
        this.useHybrid = false
        logger.warn(
          'Hybrid search unavailable for consolidation, degrading to BM25 (exact-dup recall only)',
          { error: err instanceof Error ? err.message : String(err) },
        )
      }
    }
    try {
      return (await this.store.searchLex(body, {
        collection: 'memories',
        limit: CLUSTER_NEIGHBOR_LIMIT,
      })) as NeighborHit[]
    } catch (err) {
      logger.warn('searchLex failed while clustering, treating as no neighbors', {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }
}

/**
 * For each memory, pull its top neighbors via HYBRID search (BM25 + vector +
 * rerank) on the `memories` collection — the vector half is what catches
 * PARAPHRASE drift (the whole point of consolidation), which BM25-only misses.
 * Consolidation is OFF the hot path, so it can afford the embedding-model load
 * update.ts deliberately avoids. Returns neighborScore[a][b] = similarity of b
 * when a's body is the query (self + non-active hits dropped).
 */
async function buildNeighborScores(
  memories: ActiveMemory[],
  store: QMDStore,
  byId: Map<string, ActiveMemory>,
): Promise<Map<string, Map<string, number>>> {
  const searcher = new NeighborSearcher(store)
  const neighborScore = new Map<string, Map<string, number>>()
  for (const m of memories) {
    const scores = new Map<string, number>()
    const hits = await searcher.neighbors(m.body)
    for (const r of hits) {
      const id = idFromHit(r)
      if (id === m.id || !byId.has(id)) continue
      scores.set(id, r.score)
    }
    neighborScore.set(m.id, scores)
  }
  return neighborScore
}

/** Minimal Union-Find (disjoint set) with path compression, keyed by memory id. */
class UnionFind {
  private readonly parent = new Map<string, string>()

  constructor(ids: string[]) {
    for (const id of ids) this.parent.set(id, id)
  }

  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/** Bucket memories into connected components by their Union-Find root. */
function bucketByComponent(memories: ActiveMemory[], uf: UnionFind): ActiveMemory[][] {
  const components = new Map<string, ActiveMemory[]>()
  for (const m of memories) {
    const root = uf.find(m.id)
    const bucket = components.get(root)
    if (bucket) bucket.push(m)
    else components.set(root, [m])
  }
  return [...components.values()]
}

/**
 * Reduce raw connected components to the clusters we actually send to the model:
 *   - drop singletons (nothing to merge),
 *   - drop all-consolidated clusters (idempotency guard — a prior output only
 *     re-fires once a NEW original memory joins it),
 *   - drop + LOUDLY log oversized clusters (lexical-hub artifacts — never feed
 *     a huge cluster to the model; leave them as-is).
 */
function selectMergeableClusters(components: ActiveMemory[][]): ActiveMemory[][] {
  const clusters: ActiveMemory[][] = []
  for (const c of components) {
    if (c.length < 2) continue
    if (!c.some((m) => !m.consolidated)) continue
    if (c.length > MAX_CLUSTER_SIZE) {
      logger.warn('oversized cluster skipped (exceeds cap), leaving as-is', {
        size: c.length,
        cap: MAX_CLUSTER_SIZE,
        ids: c.map((m) => m.id),
      })
      continue
    }
    clusters.push(c)
  }
  return clusters
}

/**
 * Group active memories into consolidation-candidate clusters by semantic
 * similarity. For each memory we pull its top neighbors via HYBRID search
 * (store.search on the `memories` collection — vector half catches paraphrase
 * drift; degrades to BM25 searchLex if models are unavailable). An
 * EITHER-direction edge is formed when one memory appears in the other's top-N
 * neighbors above the threshold;
 * connected components become clusters (transitive grouping is intentional —
 * the model arbitrates). The threshold is a cheap recall prefilter biased toward
 * over-inclusion; the real merge/leave call is the model's (CP2).
 *
 * Idempotency guard: a cluster is sent to the model only if it contains at least
 * one ORIGINAL (non-consolidated) memory — a prior consolidation output only
 * seeds a new merge when a genuinely NEW original memory joins it. Combined with
 * supersede-only sources (invalidated → excluded by loadActiveMemories), this
 * makes a second back-to-back run find nothing. Oversized components are skipped.
 */
export async function clusterMemories(
  memories: ActiveMemory[],
  store: QMDStore,
): Promise<ActiveMemory[][]> {
  const byId = new Map(memories.map((m) => [m.id, m]))
  const neighborScore = await buildNeighborScores(memories, store, byId)

  // Union-Find over EITHER-direction edges: A and B join if EITHER appears in
  // the other's top-N neighbors with score >= threshold (BM25 is asymmetric, so
  // requiring both directions would silently drop real pairs). Connected
  // components mean A~B~C groups {A,B,C} transitively even if A and C aren't
  // directly linked — intentional; the MODEL decides if all three truly merge.
  const uf = new UnionFind(memories.map((m) => m.id))
  for (const m of memories) {
    const out = neighborScore.get(m.id)
    if (!out) continue
    for (const [other, score] of out) {
      if (score >= CLUSTER_SCORE_THRESHOLD) uf.union(m.id, other)
    }
  }

  return selectMergeableClusters(bucketByComponent(memories, uf))
}

// ===========================================================================
// The ONE model capability: the per-cluster MERGE / LEAVE_AS_IS decision.
// Mirrors salience.ts (buildSalienceTask + scoreSalience) EXACTLY: grammar-
// constrained JSON, validate → retry → floor inside the harness for a
// constrained handle; the caller catches the unconstrained hard-fail and
// degrades — here to LEAVE_AS_IS, the safe direction. NEVER throws, NEVER
// fabricates a merge.
// ===========================================================================

/**
 * The model's decision for one cluster. MERGE carries the consolidated fact +
 * its category; LEAVE_AS_IS carries a short reason. LEAVE_AS_IS is the floor —
 * the safe direction on any whiff.
 */
export type MergeDecision =
  | { action: 'MERGE'; text: string; category: ExtractedFact['category'] }
  | { action: 'LEAVE_AS_IS'; reason: string }

/** JSON-schema constraining the merge-decision shape (GBNF grammar for the local model). */
const MERGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { enum: ['MERGE', 'LEAVE_AS_IS'] },
    text: { type: 'string' },
    category: {
      enum: ['IDENTITY', 'PREFERENCE', 'CONTEXT', 'RELATIONSHIP', 'SKILL', 'EVENT'],
    },
    reason: { type: 'string' },
  },
} as const

/**
 * Local constrained path: 2 attempts then the LEAVE_AS_IS floor (a grammar-
 * constrained model that stutters is recoverable). The unconstrained (external)
 * path can't floor — consolidateCluster catches its hard-fail and degrades to
 * LEAVE_AS_IS itself, so a merge decision NEVER blocks the sweep.
 */
const CONSOLIDATE_MAX_ATTEMPTS = 2

/** The safe floor: change nothing. Used by the harness floor AND the caller's degrade. */
function leaveAsIsFloor(): MergeDecision {
  return { action: 'LEAVE_AS_IS', reason: 'harness floor' }
}

function isCategory(value: string): value is ExtractedFact['category'] {
  return (VALID_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Validate + coerce parsed merge JSON into a MergeDecision.
 *   - action: must be 'MERGE' or 'LEAVE_AS_IS', else → null (retry/floor)
 *   - MERGE: requires a non-empty text AND a valid category, else → null
 *   - LEAVE_AS_IS: reason coerced to a trimmed string (may be empty)
 * Returns null on anything unusable, which triggers the harness retry/floor.
 */
export function validateMerge(parsed: unknown): MergeDecision | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const action = String(obj.action ?? '')
  if (action === 'LEAVE_AS_IS') {
    return { action: 'LEAVE_AS_IS', reason: String(obj.reason ?? '').trim() }
  }
  if (action === 'MERGE') {
    const text = String(obj.text ?? '').trim()
    const category = String(obj.category ?? '')
    if (!text || !isCategory(category)) return null
    return { action: 'MERGE', text, category }
  }
  return null
}

/**
 * Build the per-cluster HarnessTask. `floor` returns LEAVE_AS_IS — the safe
 * direction when a constrained model whiffs after retries. `failureMessage` is
 * only surfaced on the unconstrained no-floor path (handled by consolidateCluster).
 */
export function buildMergeTask(): HarnessTask<MergeDecision> {
  return {
    name: 'consolidate',
    schema: {
      jsonSchema: MERGE_JSON_SCHEMA,
      validate: validateMerge,
    },
    floor: leaveAsIsFloor,
    failureMessage: 'Consolidate response missing or invalid action',
  }
}

/** Render a cluster as the numbered, category-tagged list the prompt expects. */
function formatClusterForPrompt(cluster: ActiveMemory[]): string {
  return cluster.map((m, i) => `${i + 1}. [${m.category}] ${m.body}`).join('\n')
}

/**
 * Decide MERGE / LEAVE_AS_IS for one cluster through the (warm) harness. ALWAYS
 * resolves to a MergeDecision: the constrained path floors to LEAVE_AS_IS inside
 * the harness; the unconstrained path hard-fails and is caught here and degraded
 * to LEAVE_AS_IS — loudly. A merge decision must never block or throw out of the
 * consolidation sweep, and the safe direction is ALWAYS "change nothing".
 */
export async function consolidateCluster(
  cluster: ActiveMemory[],
  harness: ModelHarness,
): Promise<MergeDecision> {
  const task = buildMergeTask()
  const prompt = fillTemplate(CONSOLIDATE_PROMPT, {
    memories: formatClusterForPrompt(cluster),
  })

  const result = await harness.run(task, prompt, { maxAttempts: CONSOLIDATE_MAX_ATTEMPTS })
  if (result.ok) {
    return result.value.value
  }

  // Unconstrained (external) hard-fail: degrade to LEAVE_AS_IS rather than
  // forcing a merge. LOUD — never a silent fallback, never a fabricated merge.
  logger.warn('consolidate decision failed, leaving cluster as-is', {
    clusterSize: cluster.length,
    ids: cluster.map((m) => m.id),
    error: result.error.message,
  })
  return leaveAsIsFloor()
}

// ===========================================================================
// Apply: write the consolidated memory + supersede the sources. Mechanical and
// supersede-ONLY — sources are marked invalidatedAt (reversible), NEVER deleted.
// Reuses runner's writeMemoryFile + invalidateMemoryFile (no reimplementation).
// ===========================================================================

/** Outcome of a consolidation sweep. */
export interface ConsolidationStats {
  /** Clusters the model was asked to judge. */
  clustersFound: number
  /** Clusters that produced a consolidated memory. */
  merged: number
  /** Clusters the model (or floor) left untouched. */
  leftAsIs: number
  /** Source memories marked invalidatedAt (superseded) across all merges. */
  sourcesSuperseded: number
}

/** A cluster paired with the model's decision for it — the input to apply. */
export interface ClusterDecision {
  cluster: ActiveMemory[]
  decision: MergeDecision
}

const CONFIDENCE_RANK: Record<ExtractedFact['confidence'], number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
}

/** Highest confidence among a cluster's sources (HIGH > MEDIUM > LOW). */
function highestConfidence(cluster: ActiveMemory[]): ExtractedFact['confidence'] {
  return cluster.reduce<ExtractedFact['confidence']>(
    (best, m) => (CONFIDENCE_RANK[m.confidence] < CONFIDENCE_RANK[best] ? m.confidence : best),
    'LOW',
  )
}

/** Earliest validFrom among a cluster's sources — the merged memory inherits it. */
function earliestValidFrom(cluster: ActiveMemory[]): Date {
  return cluster.reduce(
    (min, m) => (m.validFrom.getTime() < min.getTime() ? m.validFrom : min),
    cluster[0].validFrom,
  )
}

/**
 * Build the consolidated MemoryRecord for a MERGE decision — same shape as
 * runner's factToMemory, but with consolidation-specific provenance:
 *   - text/category from the model's decision,
 *   - confidence = HIGHEST among sources,
 *   - salience RE-SCORED on the merged text via the warm harness (so the denser
 *     memory earns its OWN tier/expiry, not inherited),
 *   - createdAt computed ONCE and fed to BOTH the field and computeExpiresAt
 *     (T04 no-drift discipline),
 *   - validFrom = EARLIEST source validFrom,
 *   - source = the source ids (reversible provenance audit),
 *   - consolidated: true (the idempotency marker).
 */
async function buildConsolidatedMemory(
  cluster: ActiveMemory[],
  decision: Extract<MergeDecision, { action: 'MERGE' }>,
  harness: ModelHarness,
): Promise<MemoryRecord> {
  const confidence = highestConfidence(cluster)
  const fact: ExtractedFact = { text: decision.text, category: decision.category, confidence }
  const salience = await scoreSalience(fact, harness)
  const createdAt = new Date()
  return {
    id: generateId('mem'),
    text: decision.text,
    category: decision.category,
    confidence,
    salienceScore: salience.score,
    salienceTier: salience.tier,
    source: cluster.map((m) => m.id).join('+'),
    createdAt,
    validFrom: earliestValidFrom(cluster),
    invalidatedAt: null,
    expiresAt: computeExpiresAt(salience.tier, createdAt),
    consolidated: true,
  }
}

/**
 * Apply ONE MERGE: write the consolidated memory, then supersede every source
 * (invalidateMemoryFile — marked, not deleted). Wrapped so one bad file never
 * aborts the sweep. Returns the number of sources superseded (0 on failure).
 */
async function applyMerge(
  walletDir: string,
  cluster: ActiveMemory[],
  decision: Extract<MergeDecision, { action: 'MERGE' }>,
  harness: ModelHarness,
): Promise<number> {
  try {
    const memory = await buildConsolidatedMemory(cluster, decision, harness)
    await writeMemoryFile(walletDir, memory)
    for (const source of cluster) {
      await invalidateMemoryFile(walletDir, source.id)
    }
    logger.info('Consolidated a cluster', {
      memoryId: memory.id,
      sources: cluster.map((m) => m.id),
      salienceTier: memory.salienceTier,
    })
    return cluster.length
  } catch (err) {
    logger.warn('Failed to apply consolidation for a cluster, skipping', {
      ids: cluster.map((m) => m.id),
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

/** Re-index the store after mutations (non-fatal on failure, logged — mirrors runner.ts). */
async function reindexAfterConsolidation(store: QMDStore): Promise<void> {
  try {
    await store.update()
  } catch (err) {
    logger.warn('QMD re-index after consolidation failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Apply a batch of cluster decisions: for each MERGE, write the consolidated
 * memory + supersede its sources; LEAVE_AS_IS is a no-op. After all mutations,
 * re-index the store ONCE (so the new memory is searchable and superseded
 * sources drop out of active search). Returns the run's stats.
 */
export async function applyConsolidation(
  walletDir: string,
  store: QMDStore,
  decisions: ClusterDecision[],
  harness: ModelHarness,
): Promise<ConsolidationStats> {
  const stats: ConsolidationStats = {
    clustersFound: decisions.length,
    merged: 0,
    leftAsIs: 0,
    sourcesSuperseded: 0,
  }

  for (const { cluster, decision } of decisions) {
    if (decision.action !== 'MERGE') {
      stats.leftAsIs++
      continue
    }
    const superseded = await applyMerge(walletDir, cluster, decision, harness)
    if (superseded > 0) {
      stats.merged++
      stats.sourcesSuperseded += superseded
    }
  }

  if (stats.merged > 0) await reindexAfterConsolidation(store)
  return stats
}

// ===========================================================================
// Public entry: the whole sweep, end to end.
// ===========================================================================

/**
 * Run one off-line consolidation sweep over the wallet's active slow store:
 * enumerate active memories → cluster by similarity → ask the model MERGE /
 * LEAVE_AS_IS per cluster → apply (write consolidated memory + supersede
 * sources) → re-index → stats. Reuses the WARM extraction handle via
 * buildExtractionHarness (NO second model). NEVER throws — any failure is
 * captured in the Result (mirrors runExtraction). An empty store is a clean
 * no-op: clustersFound = 0.
 *
 * OFF the hot path: invoked by `dhakira consolidate` or, when the (default-OFF)
 * extraction.consolidate flag is on, after extraction — never in the proxy path.
 */
export async function runConsolidation(
  walletDir: string,
  store: QMDStore,
  config: WalletConfig['extraction'],
): Promise<Result<ConsolidationStats>> {
  try {
    const harness = buildExtractionHarness(config)
    const memories = await loadActiveMemories(walletDir)
    const clusters = await clusterMemories(memories, store)

    const decisions: ClusterDecision[] = []
    for (const cluster of clusters) {
      const decision = await consolidateCluster(cluster, harness)
      decisions.push({ cluster, decision })
    }

    const stats = await applyConsolidation(walletDir, store, decisions, harness)
    logger.info('Consolidation sweep complete', { ...stats })
    return { ok: true, value: stats }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
