// v0.3.1 (audit D6): the forget sweep is SCHEDULED — it runs at the end of every
// runExtraction, even one that processed nothing. Before this release runForget
// was reachable only via `dhakira forget`, so TTLs never fired on their own.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/extraction/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extraction/extract.js')>()
  return { ...actual, extractFacts: vi.fn() }
})
vi.mock('../../src/extraction/profile-gen.js', () => ({
  regenerateProfile: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}))
vi.mock('../../src/extraction/session-reconstructor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extraction/session-reconstructor.js')>()
  return { ...actual, reconstructSessions: vi.fn().mockResolvedValue([]) }
})

import { runExtraction, writeMemoryFile } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'

const DAY = 24 * 60 * 60 * 1000
const CONFIG = { model: 'm', apiKey: '', baseUrl: 'https://api.openai.com/v1' }

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem',
    text: 'body',
    category: 'CONTEXT',
    confidence: 'HIGH',
    salienceScore: 0.5,
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

describe('runExtraction schedules the forget sweep (D6)', () => {
  let walletDir: string
  const store = {
    update: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'runner-forget-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('an extraction run that processes ZERO conversations still retires expired trivia — and nothing else', async () => {
    const now = Date.now()
    await writeMemoryFile(
      walletDir,
      record({ id: 'triv_expired', salienceTier: 'trivia', expiresAt: new Date(now - 5 * DAY) }),
    )
    await writeMemoryFile(
      walletDir,
      record({ id: 'std_legacy', salienceTier: 'standard', expiresAt: new Date(now - 100 * DAY) }),
    )
    await writeMemoryFile(walletDir, record({ id: 'core_perm', salienceTier: 'core' }))

    const result = await runExtraction(walletDir, store, CONFIG)
    expect(result.ok && result.value.conversationsProcessed).toBe(0)

    const read = (id: string) => readFile(join(walletDir, 'memories', `${id}.md`), 'utf8')
    expect(await read('triv_expired')).toMatch(/^forgottenAt: /m)
    expect(await read('std_legacy')).not.toMatch(/^forgottenAt: /m) // supersession-only
    expect(await read('core_perm')).not.toMatch(/^forgottenAt: /m)
    // Something was forgotten → the store was re-indexed by the sweep.
    expect(store.update).toHaveBeenCalled()
  })

  it('a sweep failure is non-fatal to the extraction run', async () => {
    const brokenStore = {
      update: vi.fn().mockRejectedValue(new Error('index locked')),
      embed: vi.fn().mockResolvedValue(undefined),
    } as unknown as QMDStore
    await writeMemoryFile(
      walletDir,
      record({ id: 'triv_expired', salienceTier: 'trivia', expiresAt: new Date(Date.now() - DAY) }),
    )
    const result = await runExtraction(walletDir, brokenStore, CONFIG)
    expect(result.ok).toBe(true)
  })
})
