import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMemoryContent, writeMemoryFile } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'
import {
  collectScopedMemories,
  type EligibleMemory,
  groupMemoriesByProject,
  SYNTHESIS_MAX_MEMORIES_PER_BUCKET,
} from '../../src/synthesis/collect.ts'
import type { SalienceTier } from '../../src/salience/types.ts'

function mem(body: string, projectId: string, tier: SalienceTier = 'standard'): EligibleMemory {
  return { body, projectId, tier }
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    text: 'a fact',
    category: 'CONTEXT',
    confidence: 'HIGH',
    salienceScore: 0.7,
    salienceTier: 'standard',
    source: 'conv_1',
    projectId: 'global',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// groupMemoriesByProject — the pure core
// ───────────────────────────────────────────────────────────────────────────
describe('groupMemoriesByProject — pure bucketing', () => {
  it('buckets a mixed-project corpus by projectId', () => {
    const buckets = groupMemoriesByProject([
      mem('global fact', 'global'),
      mem('repo A fact 1', 'git:github.com/owner/a'),
      mem('repo B fact', 'git:github.com/owner/b'),
      mem('repo A fact 2', 'git:github.com/owner/a'),
    ])

    expect([...buckets.keys()].sort()).toEqual([
      'git:github.com/owner/a',
      'git:github.com/owner/b',
      'global',
    ])
    expect(buckets.get('git:github.com/owner/a')).toEqual(['repo A fact 1', 'repo A fact 2'])
    expect(buckets.get('git:github.com/owner/b')).toEqual(['repo B fact'])
    expect(buckets.get('global')).toEqual(['global fact'])
  })

  it('a global-only corpus produces a single global bucket in input order (as today)', () => {
    const buckets = groupMemoriesByProject([
      mem('first', 'global'),
      mem('second', 'global'),
      mem('third', 'global'),
    ])
    expect([...buckets.keys()]).toEqual(['global'])
    expect(buckets.get('global')).toEqual(['first', 'second', 'third'])
  })

  it('memories with an empty projectId fall into the global bucket (loader default)', () => {
    const buckets = groupMemoriesByProject([mem('orphan', '')])
    expect(buckets.get('global')).toEqual(['orphan'])
  })

  it('applies the cap PER BUCKET, preferring high salience above it', () => {
    // One huge bucket (> cap) of mixed tiers + one small bucket (untouched).
    const big: EligibleMemory[] = []
    for (let i = 0; i < SYNTHESIS_MAX_MEMORIES_PER_BUCKET; i++) {
      big.push(mem(`standard ${i}`, 'proj:big', 'standard'))
    }
    // Add 3 core memories on top of a full standard bucket → core must win.
    big.push(mem('core A', 'proj:big', 'core'))
    big.push(mem('core B', 'proj:big', 'core'))
    big.push(mem('core C', 'proj:big', 'core'))

    const small = [mem('only one', 'proj:small', 'trivia')]

    const buckets = groupMemoriesByProject([...big, ...small])

    const bigBucket = buckets.get('proj:big')
    expect(bigBucket).toHaveLength(SYNTHESIS_MAX_MEMORIES_PER_BUCKET)
    // core memories survive the cap (they sort to the front).
    expect(bigBucket).toContain('core A')
    expect(bigBucket).toContain('core B')
    expect(bigBucket).toContain('core C')
    // The small bucket is independent of the big bucket's cap.
    expect(buckets.get('proj:small')).toEqual(['only one'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// collectScopedMemories — the edge reader (real disk, NO model)
// ───────────────────────────────────────────────────────────────────────────
describe('collectScopedMemories — eligibility + scoping off disk', () => {
  let walletDir: string
  let memoriesDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'synth-collect-'))
    memoriesDir = join(walletDir, 'memories')
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('buckets eligible memories by their stamped projectId; excludes the ineligible', async () => {
    await writeMemoryFile(walletDir, record({ id: 'g1', text: 'global identity', projectId: 'global' }))
    await writeMemoryFile(
      walletDir,
      record({ id: 'p1', text: 'project decision', projectId: 'git:github.com/o/r' }),
    )
    // Ineligible: LOW confidence, invalidated, forgotten — must all be excluded.
    await writeMemoryFile(
      walletDir,
      record({ id: 'lo', text: 'weak', confidence: 'LOW', projectId: 'git:github.com/o/r' }),
    )
    await writeMemoryFile(
      walletDir,
      record({
        id: 'inv',
        text: 'superseded',
        projectId: 'git:github.com/o/r',
        invalidatedAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    )
    await writeMemoryFile(
      walletDir,
      record({
        id: 'fg',
        text: 'forgotten',
        projectId: 'git:github.com/o/r',
        forgottenAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    )

    const result = await collectScopedMemories(memoriesDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const buckets = result.value
    expect([...buckets.keys()].sort()).toEqual(['git:github.com/o/r', 'global'])
    expect(buckets.get('global')).toEqual(['global identity'])
    // Only the single eligible project memory survives.
    expect(buckets.get('git:github.com/o/r')).toEqual(['project decision'])
  })

  it('a global-only wallet yields exactly one global bucket (behaves as today)', async () => {
    await writeMemoryFile(walletDir, record({ id: 'a', text: 'fact a', projectId: 'global' }))
    await writeMemoryFile(walletDir, record({ id: 'b', text: 'fact b', projectId: 'global' }))

    const result = await collectScopedMemories(memoriesDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.value.keys()]).toEqual(['global'])
    expect(result.value.get('global')?.sort()).toEqual(['fact a', 'fact b'])
  })

  it('a pre-T08 memory file with NO projectId line reads as global', async () => {
    // Hand-build a memory WITHOUT a projectId line (the pre-T08 on-disk shape).
    const content = buildMemoryContent(record({ id: 'old', text: 'legacy fact', projectId: 'global' }))
    expect(content).not.toMatch(/projectId/)
    await writeMemoryFile(walletDir, record({ id: 'old', text: 'legacy fact', projectId: 'global' }))

    const result = await collectScopedMemories(memoriesDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.get('global')).toEqual(['legacy fact'])
  })

  it('returns an error Result when the memories dir does not exist', async () => {
    const result = await collectScopedMemories(join(walletDir, 'does-not-exist'))
    expect(result.ok).toBe(false)
  })
})
