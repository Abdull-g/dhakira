import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeMemoryFile } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'
import { loadActiveMemories } from '../../src/store/consolidate.ts'
import { runForget } from '../../src/store/forget.ts'

const DAY = 24 * 60 * 60 * 1000

function makeStore(): { store: QMDStore; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn().mockResolvedValue(undefined)
  return { store: { update } as unknown as QMDStore, update }
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem',
    text: 'a memory body',
    category: 'CONTEXT',
    confidence: 'MEDIUM',
    salienceScore: 0.5,
    salienceTier: 'standard',
    source: 'conv_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

/** Seed the canonical mixed fixture: 2 expired, 1 superseded-aged, 1 superseded-fresh, 1 durable-core, 1 active. */
async function seedMixedWallet(walletDir: string): Promise<void> {
  const now = Date.now()
  await writeMemoryFile(
    walletDir,
    record({ id: 'expired_std', salienceTier: 'standard', expiresAt: new Date(now - 10 * DAY) }),
  )
  await writeMemoryFile(
    walletDir,
    record({ id: 'expired_triv', salienceTier: 'trivia', expiresAt: new Date(now - 200 * DAY) }),
  )
  await writeMemoryFile(
    walletDir,
    record({ id: 'superseded_aged', invalidatedAt: new Date(now - 30 * DAY) }),
  )
  await writeMemoryFile(
    walletDir,
    record({ id: 'superseded_fresh', invalidatedAt: new Date(now - 2 * DAY) }),
  )
  await writeMemoryFile(
    walletDir,
    record({ id: 'durable_core', salienceTier: 'core', expiresAt: null }),
  )
  await writeMemoryFile(
    walletDir,
    record({ id: 'active_std', salienceTier: 'standard', expiresAt: new Date(now + 90 * DAY) }),
  )
}

describe('runForget — stats over a mixed wallet', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'forget-run-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('reports honest scanned / forgotten / byReason / skippedCore', async () => {
    await seedMixedWallet(walletDir)
    const { store, update } = makeStore()

    const result = await runForget(walletDir, store)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toEqual({
      scanned: 6,
      forgotten: 3,
      byReason: { expired: 2, supersededAged: 1 },
      skippedCore: 1,
    })
    // Re-indexed exactly once because something changed.
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('empty wallet → clean no-op (scanned 0), no re-index', async () => {
    const { store, update } = makeStore()
    const result = await runForget(walletDir, store)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.scanned).toBe(0)
    expect(result.value.forgotten).toBe(0)
    expect(update).not.toHaveBeenCalled()
  })

  it('is idempotent — a 2nd back-to-back run forgets 0 and does NOT re-index', async () => {
    await seedMixedWallet(walletDir)
    const first = makeStore()
    const r1 = await runForget(walletDir, first.store)
    expect(r1.ok && r1.value.forgotten).toBe(3)

    const second = makeStore()
    const r2 = await runForget(walletDir, second.store)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.value.forgotten).toBe(0)
    expect(r2.value.scanned).toBe(6)
    expect(second.update).not.toHaveBeenCalled()
  })
})

describe('runForget — read-path exclusion (loadActiveMemories skips forgotten)', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'forget-readpath-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('soft-forgotten memories drop out of the active set after a forget run', async () => {
    await seedMixedWallet(walletDir)

    // Before: active set excludes the 2 superseded (invalidatedAt) → 4 active.
    const before = await loadActiveMemories(walletDir)
    expect(before.map((m) => m.id).sort()).toEqual([
      'active_std',
      'durable_core',
      'expired_std',
      'expired_triv',
    ])

    const { store } = makeStore()
    await runForget(walletDir, store)

    // After: the 2 now-forgotten expired memories are also excluded → 2 active.
    const after = await loadActiveMemories(walletDir)
    expect(after.map((m) => m.id).sort()).toEqual(['active_std', 'durable_core'])
  })
})
