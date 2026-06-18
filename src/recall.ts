// Dhakira — recall core
//
// The pure, reusable retrieval+composition step behind every "inject" adapter
// (proxy, Claude Code hook, MCP, file). It performs NO I/O on stdout and holds
// NO personality/verbose/first-injection state: it returns a structured result
// and the caller decides what (if anything) to print or how to deliver the text.
//
// Standing Order #7: this module imports only retrieval/injection/synthesis
// (engine layers). It must NOT import proxy or dashboard. The projectId resolver
// is INJECTED (deps.resolveProjectId) precisely so recall.ts never has to reach
// into the proxy to sniff a request. `NormalizedRequest` is a type-only import.

import type { QMDStore } from '@tobilu/qmd'
import type { WalletConfig } from './config/schema.js'
import { buildInjectionBlock } from './injection/builder.js'
import { loadProfile } from './injection/profile.js'
import type { NormalizedRequest } from './proxy/types.js'
import { searchTurns } from './retrieval/search.js'
import type { TurnSearchResult } from './retrieval/types.js'
import { loadProjectDoc, projectDisplayName } from './synthesis/project-doc.js'

export interface RecallDeps {
  store: QMDStore
  config: WalletConfig
  /**
   * Resolve a projectId from a proxy request (cwd sniff → git → fingerprint).
   * Injected so recall.ts stays free of proxy imports. Optional: adapters that
   * already know their project pass `input.projectId` and omit this entirely.
   */
  resolveProjectId?: (normalized: NormalizedRequest) => Promise<string>
}

export interface RecallInput {
  /** Retrieval query. Proxy: the last user message. Adapters: the prompt text. */
  query: string
  /** Explicit, client-resolved projectId. Takes precedence over any sniff. */
  projectId?: string
  /** Proxy request — used ONLY to sniff projectId when none is passed explicitly. */
  normalized?: NormalizedRequest
}

export interface RecallResult {
  /** Composed injection text, or null when there is nothing worth injecting. */
  text: string | null
  /** Number of Layer-1 turns included in the block. */
  turnCount: number
  /** The projectId used for scoping (explicit → sniffed → 'global'). */
  projectId: string
  /** Wall-clock retrieval time in ms — for the caller's own telemetry/personality. */
  elapsedMs: number
  /**
   * The retrieved turns. Additive to the spec's four fields so the proxy can
   * render its verbose per-turn snippets WITHOUT re-searching and WITHOUT recall
   * doing any stdout. Adapters that only need `text` can ignore this.
   */
  turns: TurnSearchResult[]
}

/**
 * Resolve memory for one query and compose the injection block. Pure: same call,
 * same effects (disk reads only) — no emit, no flags, no verbose.
 *
 * projectId precedence: explicit `input.projectId` → sniffed from `input.normalized`
 * via `deps.resolveProjectId` → 'global'. This is what lets an adapter's
 * client-side project signal win over a server-side sniff (the cross-tool moat).
 */
export async function recallOnce(deps: RecallDeps, input: RecallInput): Promise<RecallResult> {
  const t0 = Date.now()

  const projectId =
    input.projectId ??
    (input.normalized && deps.resolveProjectId
      ? await deps.resolveProjectId(input.normalized)
      : 'global')

  const profileResult = await loadProfile(deps.config.walletDir)
  const profile = profileResult.ok ? profileResult.value : ''

  // T08: scoped project doc for this projectId. null when global / no doc → the
  // composition degrades to exactly the pre-T08 behavior (global + turns).
  const projectDoc = await loadProjectDoc(deps.config.walletDir, projectId)

  const searchResult = await searchTurns(deps.store, {
    query: input.query,
    limit: deps.config.injection.maxTurns,
    minScore: deps.config.injection.minRelevanceScore,
    recencyBoost: deps.config.injection.recencyBoost,
    projectId,
    scopeMode: 'boost',
  })
  const turns = searchResult.ok ? searchResult.value : []

  const injectionBlock = buildInjectionBlock(
    profile,
    projectDoc,
    turns,
    deps.config.injection,
    projectDisplayName(projectId),
  )

  return {
    text: injectionBlock.text ? injectionBlock.text : null,
    turnCount: turns.length,
    projectId,
    elapsedMs: Date.now() - t0,
    turns,
  }
}
