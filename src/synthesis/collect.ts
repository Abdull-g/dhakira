// Scoped memory collection for projectId-aware synthesis (T08, CP2).
//
// PURE CORE + EDGE I/O — mirrors the project.ts / tier-policy purity discipline:
//   - groupMemoriesByProject is a PURE function (memories in → buckets out),
//     exhaustively fixture-testable with no disk and no model.
//   - collectScopedMemories does the directory read at the EDGE, then delegates to
//     the pure grouping.
//
// NO-CYCLE DISCIPLINE: the memory-frontmatter parse is INLINED here, NOT imported
// from runner.ts / profile-gen.ts — the same precedent profile-gen.ts set
// (profile-gen.ts:41 "Inlined here to avoid a module cycle").
//
// STANDING ORDER #7: this module imports NOTHING from src/proxy/ or src/dashboard/.
// `Result` is declared locally — its home in proxy/types.ts is an accident of
// history, not a real dependency — so src/synthesis/ greps 100% clean.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse } from 'yaml'

import type { SalienceTier } from '../salience/types.js'

/** Local Result alias (SO#7: do NOT import from src/proxy/). */
type Result<T> = { ok: true; value: T } | { ok: false; error: Error }

/** The default scope for memories without a resolved project (mirrors loader.ts:41). */
export const GLOBAL_PROJECT_ID = 'global'

/**
 * Max memories fed to synthesis PER PROJECT BUCKET. Below this count, all eligible
 * memories in a bucket are included; above it, salience-tier preference selects the
 * most important ones. Mirrors profile-gen's PROFILE_MAX_MEMORIES, but applied per
 * bucket (the T08 scoping change) rather than to one global set.
 */
export const SYNTHESIS_MAX_MEMORIES_PER_BUCKET = 40

/** Backward-compat default tier for memory files written before salience existed. */
const DEFAULT_SALIENCE_TIER: SalienceTier = 'standard'
const SALIENCE_TIERS: readonly SalienceTier[] = ['core', 'standard', 'trivia']

/** Selection preference above the cap: core first, then standard, then trivia. */
const TIER_RANK: Record<SalienceTier, number> = {
  core: 0,
  standard: 1,
  trivia: 2,
}

/** An eligible memory ready for bucketing: real body text + its scope + tier. */
export interface EligibleMemory {
  body: string
  projectId: string
  tier: SalienceTier
}

interface MemoryFrontmatter {
  confidence: string
  invalidatedAt: string | null | undefined
  forgottenAt: string | null | undefined
  salienceTier: SalienceTier
  projectId: string
}

/**
 * Parse the eligibility-relevant fields out of a memory file's frontmatter.
 * Inlined (see no-cycle note above). Backward-compat: a missing salienceTier
 * defaults to 'standard'; a missing projectId defaults to 'global' (mirrors the
 * turns reader at loader.ts:41 — a pre-T08 memory is global, never broken).
 */
function parseMemoryFrontmatter(content: string): MemoryFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  try {
    const parsed = parse(match[1]) as Record<string, unknown>
    const rawTier = String(parsed.salienceTier ?? '')
    const salienceTier = SALIENCE_TIERS.includes(rawTier as SalienceTier)
      ? (rawTier as SalienceTier)
      : DEFAULT_SALIENCE_TIER
    return {
      confidence: String(parsed.confidence ?? ''),
      // YAML parses the "null" literal as JS null; treat empty string as not-set.
      invalidatedAt:
        parsed.invalidatedAt === null
          ? null
          : parsed.invalidatedAt
            ? String(parsed.invalidatedAt)
            : undefined,
      forgottenAt:
        parsed.forgottenAt === null
          ? null
          : parsed.forgottenAt
            ? String(parsed.forgottenAt)
            : undefined,
      salienceTier,
      projectId: parsed.projectId ? String(parsed.projectId) : GLOBAL_PROJECT_ID,
    }
  } catch {
    return null
  }
}

function extractMemoryBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/)
  return match?.[1]?.trim() ?? ''
}

/**
 * PURE: group eligible memories by projectId, preserving salience-tier ordering
 * and applying the per-bucket cap.
 *
 *   - Memories without a projectId fall into the 'global' bucket (the loader
 *     default — backward-compat).
 *   - At/under the cap, a bucket keeps its incoming (directory) order, so a small
 *     wallet behaves exactly as the pre-T08 global path did.
 *   - Over the cap, a bucket prefers high-salience memories (core → standard →
 *     trivia). Array.sort is stable, so order within a tier is preserved.
 *
 * No I/O, no model — same signals in, same buckets out.
 */
export function groupMemoriesByProject(memories: EligibleMemory[]): Map<string, string[]> {
  const buckets = new Map<string, EligibleMemory[]>()
  for (const m of memories) {
    const key = m.projectId || GLOBAL_PROJECT_ID
    const arr = buckets.get(key)
    if (arr) arr.push(m)
    else buckets.set(key, [m])
  }

  const result = new Map<string, string[]>()
  for (const [key, arr] of buckets) {
    if (arr.length <= SYNTHESIS_MAX_MEMORIES_PER_BUCKET) {
      result.set(
        key,
        arr.map((m) => m.body),
      )
      continue
    }
    const ranked = [...arr].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])
    result.set(
      key,
      ranked.slice(0, SYNTHESIS_MAX_MEMORIES_PER_BUCKET).map((m) => m.body),
    )
  }
  return result
}

/**
 * EDGE: read every eligible memory off disk, then group them by project (pure).
 *
 * Eligibility mirrors profile-gen.ts exactly: a `.md` file under memoriesDir that
 * is HIGH-confidence, NOT invalidated, and NOT forgotten, with a non-empty body.
 * Unreadable/malformed files are skipped silently (one bad file never aborts the
 * sweep). The grouping/ordering/cap is the pure groupMemoriesByProject.
 */
export async function collectScopedMemories(
  memoriesDir: string,
): Promise<Result<Map<string, string[]>>> {
  let relPaths: string[]
  try {
    const entries = (await readdir(memoriesDir, { recursive: true })) as string[]
    relPaths = entries.filter((f) => f.endsWith('.md'))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }

  const eligible: EligibleMemory[] = []
  for (const rel of relPaths) {
    try {
      const content = await readFile(join(memoriesDir, rel), 'utf8')
      const fm = parseMemoryFrontmatter(content)
      if (!fm || fm.confidence !== 'HIGH' || fm.invalidatedAt || fm.forgottenAt) continue
      const body = extractMemoryBody(content)
      if (body) eligible.push({ body, projectId: fm.projectId, tier: fm.salienceTier })
    } catch {
      // Skip unreadable files silently (mirrors profile-gen).
    }
  }

  return { ok: true, value: groupMemoriesByProject(eligible) }
}
