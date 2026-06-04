// Harness-backed synthesis with the structured → flat → omit ladder (T08, CP3).
//
// THE LOAD-BEARING SAFETY PROPERTY (build for richness, fail toward silence):
// synthesis is ALWAYS-INJECTED = highest blast radius. This module guarantees, by
// construction, that "the only model-authored text is grammar-validated sections;
// everything below is real memory text or absence." A whiffing model can never
// inject fabricated narrative — worst case is a flat list of the user's own real
// memories, and worst-worst case is omission (Layer 1 still carries the moat).
//
// THE LADDER (owned EXPLICITLY here, NOT via harness.floor — a harness floor only
// fires for constrained handles and a floor returning model-shaped T could look
// like fabrication; owning it here keeps the safety property structural):
//   1. structured — harness.run ok + ≥1 validated non-empty section → render it.
//   2. flat       — harness not-ok / doc empty → DETERMINISTIC concat of the
//                   bucket's real memory bodies (no model, no invention). LOUD.
//   3. omit       — no eligible memories → null → caller omits the layer.
//
// WARM HANDLE: callers pass a ModelHarness built via buildExtractionHarness(config)
// (extract.ts:330) — the SAME cached extractor singleton salience reuses. Synthesis
// NEVER spins a second model. The harness is injected (DI) so tests drive a fake
// ModelHandle and NO real model is ever loaded.
//
// STANDING ORDER #7: imports nothing from src/proxy/ or src/dashboard/.
//
// RESERVED SEAMS (build nothing — just the shape): per-section harness
// DECOMPOSITION (N calls instead of one); evolve-via-supersession (narrative
// continuity); hosted bigger-model swap (a model change behind the harness).

import { fillTemplate, GLOBAL_PROFILE_PROMPT, PROJECT_DOC_PROMPT } from '../extraction/prompts.js'
import type { ModelHarness } from '../harness/harness.js'
import type { HarnessTask } from '../harness/types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('synthesis')

/**
 * Attempts per synthesis call before the module degrades to the flat floor. A
 * constrained model that stutters gets a second try; an unconstrained model that
 * returns the wrong shape hard-fails out of the harness and is caught here.
 */
const SYNTHESIS_MAX_ATTEMPTS = 2

// ───────────────────────────────────────────────────────────────────────────
// LOUD fallback telemetry (Bug B lesson: a silent floor repeats it). Every time
// synthesis degrades from structured to flat we log AND count, so the dashboard
// can later surface "project synthesis fell back N% this week".
// ───────────────────────────────────────────────────────────────────────────
let synthesisFallbackCount = 0

/** Total times synthesis has degraded structured → flat. */
export function getSynthesisFallbackCount(): number {
  return synthesisFallbackCount
}

/** Reset the synthesis fallback counter (test isolation). */
export function resetSynthesisFallbackCount(): void {
  synthesisFallbackCount = 0
}

// ───────────────────────────────────────────────────────────────────────────
// Validated section shapes
// ───────────────────────────────────────────────────────────────────────────

/** Global identity doc — the cross-project "About You". */
export interface GlobalProfile {
  stable?: string[]
  active?: string[]
}

/** Project doc — the scoped moat layer. Every section is independently optional. */
export interface ProjectDoc {
  whatThis?: string
  decisions?: string[]
  conventions?: string[]
  gotchas?: string[]
  openThreads?: string[]
}

const GLOBAL_PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    stable: { type: 'array', items: { type: 'string' } },
    active: { type: 'array', items: { type: 'string' } },
  },
} as const

const PROJECT_DOC_SCHEMA = {
  type: 'object',
  properties: {
    whatThis: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    conventions: { type: 'array', items: { type: 'string' } },
    gotchas: { type: 'array', items: { type: 'string' } },
    openThreads: { type: 'array', items: { type: 'string' } },
  },
} as const

// ───────────────────────────────────────────────────────────────────────────
// Validation: keep ONLY present, non-empty sections. Whitespace-only strings are
// dropped. If NOTHING survives, return null → the harness treats it as a whiff
// (retry, then hard-fail since there is no floor) → this module degrades to flat.
// This is where "partial output → only valid sections, never fabricated" lives.
// ───────────────────────────────────────────────────────────────────────────

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}

export function validateGlobalProfile(parsed: unknown): GlobalProfile | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const doc: GlobalProfile = {}

  const stable = cleanStringArray(obj.stable)
  if (stable.length > 0) doc.stable = stable
  const active = cleanStringArray(obj.active)
  if (active.length > 0) doc.active = active

  return Object.keys(doc).length > 0 ? doc : null
}

export function validateProjectDoc(parsed: unknown): ProjectDoc | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const doc: ProjectDoc = {}

  const whatThis = typeof obj.whatThis === 'string' ? obj.whatThis.trim() : ''
  if (whatThis.length > 0) doc.whatThis = whatThis

  const decisions = cleanStringArray(obj.decisions)
  if (decisions.length > 0) doc.decisions = decisions
  const conventions = cleanStringArray(obj.conventions)
  if (conventions.length > 0) doc.conventions = conventions
  const gotchas = cleanStringArray(obj.gotchas)
  if (gotchas.length > 0) doc.gotchas = gotchas
  const openThreads = cleanStringArray(obj.openThreads)
  if (openThreads.length > 0) doc.openThreads = openThreads

  return Object.keys(doc).length > 0 ? doc : null
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering: validated sections → the layer's markdown body. Sections appear in
// priority order; "Open threads" is LAST (lowest salience) so CP4 can trim it
// first under budget. Only present sections are emitted (drop empties).
// ───────────────────────────────────────────────────────────────────────────

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

export function renderGlobalProfile(doc: GlobalProfile): string {
  const blocks: string[] = []
  if (doc.stable?.length) blocks.push(`## Stable\n${bullets(doc.stable)}`)
  if (doc.active?.length) blocks.push(`## Active\n${bullets(doc.active)}`)
  return blocks.join('\n\n')
}

export function renderProjectDoc(doc: ProjectDoc): string {
  const blocks: string[] = []
  if (doc.whatThis) blocks.push(`What this is: ${doc.whatThis}`)
  if (doc.decisions?.length) blocks.push(`Key decisions:\n${bullets(doc.decisions)}`)
  if (doc.conventions?.length) blocks.push(`Conventions:\n${bullets(doc.conventions)}`)
  if (doc.gotchas?.length) blocks.push(`Gotchas:\n${bullets(doc.gotchas)}`)
  if (doc.openThreads?.length) blocks.push(`Open threads:\n${bullets(doc.openThreads)}`)
  return blocks.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// The flat floor: a deterministic bullet list of the bucket's REAL memory bodies.
// No model, no invention — this is the "concatenate top memories unsynthesized"
// floor the CRITICAL FLOOR RULE sanctions. Empty input → '' (caller omits).
// ───────────────────────────────────────────────────────────────────────────

function flatten(memories: string[]): string {
  const cleaned = memories.map((m) => m.trim()).filter((m) => m.length > 0)
  return cleaned.map((m) => `- ${m}`).join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// The ladder, shared by both synthesis flavors.
// ───────────────────────────────────────────────────────────────────────────

async function runLadder<T>(
  taskName: string,
  task: HarnessTask<T>,
  prompt: string,
  harness: ModelHarness,
  memories: string[],
  render: (doc: T) => string,
): Promise<string | null> {
  // omit: nothing to synthesize → no model call at all.
  if (memories.length === 0) return null

  const result = await harness.run(task, prompt, { maxAttempts: SYNTHESIS_MAX_ATTEMPTS })

  // structured: a validated, non-empty doc renders to real model-authored text.
  if (result.ok) {
    const rendered = render(result.value.value).trim()
    if (rendered.length > 0) return rendered
  }

  // flat: the model whiffed (hard-fail) or produced nothing renderable. Degrade
  // to the deterministic concat of REAL memory bodies — never fabricate.
  const flat = flatten(memories)
  if (flat.length === 0) return null // flat-also-empty → omit

  synthesisFallbackCount += 1
  logger.warn(
    'synthesis fell back to flat (model whiffed — emitting raw memories, never fabrication)',
    {
      task: taskName,
      memoryCount: memories.length,
      reason: result.ok ? 'empty-structured-output' : result.error.message,
      fallbackCount: synthesisFallbackCount,
    },
  )
  return flat
}

// ───────────────────────────────────────────────────────────────────────────
// Public API. `harness` is injected — production passes buildExtractionHarness(config)
// (the warm singleton); tests pass new ModelHarness(fakeHandle).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Synthesize the GLOBAL identity ("About You") from global-scoped memory bodies.
 * Returns the rendered layer body, the flat floor on a whiff, or null to omit.
 */
export function synthesizeGlobalProfile(
  memories: string[],
  harness: ModelHarness,
): Promise<string | null> {
  const task: HarnessTask<GlobalProfile> = {
    name: 'synthesize-global',
    schema: { jsonSchema: GLOBAL_PROFILE_SCHEMA, validate: validateGlobalProfile },
    // NO floor — the module owns the ladder (see header).
  }
  const prompt = fillTemplate(GLOBAL_PROFILE_PROMPT, { memories: numberedMemories(memories) })
  return runLadder('synthesize-global', task, prompt, harness, memories, renderGlobalProfile)
}

/**
 * Synthesize ONE project's doc (the moat layer) from that project's memory bodies.
 * Returns the rendered layer body, the flat floor on a whiff, or null to omit.
 */
export function synthesizeProjectDoc(
  memories: string[],
  harness: ModelHarness,
): Promise<string | null> {
  const task: HarnessTask<ProjectDoc> = {
    name: 'synthesize-project',
    schema: { jsonSchema: PROJECT_DOC_SCHEMA, validate: validateProjectDoc },
    // NO floor — the module owns the ladder (see header).
  }
  const prompt = fillTemplate(PROJECT_DOC_PROMPT, { memories: numberedMemories(memories) })
  return runLadder('synthesize-project', task, prompt, harness, memories, renderProjectDoc)
}

/** Number the memory bodies for the prompt (mirrors profile-gen's input format). */
function numberedMemories(memories: string[]): string {
  return memories.map((m, i) => `${i + 1}. ${m}`).join('\n')
}
