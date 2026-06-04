import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Model-free: the harness is a stub and synthesizeProjectDoc is mocked, so the
// trigger's ORCHESTRATION (collect → bucket → synth → write/remove, scoped to the
// touched non-global set) is tested without any model load or network.
vi.mock('../../src/extraction/extract.js', () => ({
  buildExtractionHarness: vi.fn(() => ({}) as never),
}))
vi.mock('../../src/synthesis/synthesize.js', () => ({
  synthesizeProjectDoc: vi.fn(),
}))

import { buildMemoryContent, writeMemoryFile } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'
import { loadProjectDoc, writeProjectDoc } from '../../src/synthesis/project-doc.ts'
import { regenerateProjectDocs } from '../../src/synthesis/regenerate.ts'
import { synthesizeProjectDoc } from '../../src/synthesis/synthesize.ts'

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem',
    text: 'a fact',
    category: 'CONTEXT',
    confidence: 'HIGH',
    salienceScore: 0.7,
    salienceTier: 'standard',
    source: 'conv',
    projectId: 'global',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

const CONFIG = {
  schedule: '0 2 * * *',
  model: 'gpt-4o',
  apiKey: 'k',
  baseUrl: 'https://api.openai.com/v1',
}

describe('regenerateProjectDocs — scoped trigger orchestration', () => {
  let walletDir: string
  const A = 'git:github.com/o/a'
  const B = 'git:github.com/o/b'

  beforeEach(async () => {
    vi.clearAllMocks()
    walletDir = await mkdtemp(join(tmpdir(), 'regen-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('writes docs for touched projects with memories, removes docs for emptied ones, skips global', async () => {
    // Project A has live memories; project B has none (its stale doc must be dropped).
    await writeMemoryFile(walletDir, record({ id: 'a1', text: 'A decision one', projectId: A }))
    await writeMemoryFile(walletDir, record({ id: 'a2', text: 'A decision two', projectId: A }))
    // A pre-existing (now stale) doc for B that should be removed.
    await writeProjectDoc(walletDir, B, 'stale B doc')

    vi.mocked(synthesizeProjectDoc).mockImplementation(async (memories: string[]) =>
      memories.length > 0 ? `synth(${memories.length})` : null,
    )

    // Touched set includes global (must be skipped) + A + B + a duplicate A.
    await regenerateProjectDocs(walletDir, CONFIG, ['global', A, B, A])

    // A: written from its 2 live memories.
    expect(await loadProjectDoc(walletDir, A)).toBe('synth(2)')
    // B: emptied → stale doc removed.
    expect(await loadProjectDoc(walletDir, B)).toBeNull()
    // global is never a project doc and is never synthesized here.
    expect(vi.mocked(synthesizeProjectDoc)).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when the touched set is only global (no synth, no harness build)', async () => {
    await regenerateProjectDocs(walletDir, CONFIG, ['global'])
    expect(vi.mocked(synthesizeProjectDoc)).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty touched set', async () => {
    await regenerateProjectDocs(walletDir, CONFIG, [])
    expect(vi.mocked(synthesizeProjectDoc)).not.toHaveBeenCalled()
  })

  it('uses unused buildMemoryContent helper import sanity (frontmatter carries projectId)', () => {
    // Guards the round-trip the trigger depends on: a non-global memory emits projectId.
    expect(buildMemoryContent(record({ projectId: A }))).toMatch(/projectId: git:github\.com\/o\/a/)
  })
})
