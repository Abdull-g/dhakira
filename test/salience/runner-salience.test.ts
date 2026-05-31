import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the model/network + dedup boundaries so the REAL write path
// (factToMemory → buildMemoryContent → writeMemoryFile) runs against a temp
// wallet dir without spinning a model or making HTTP calls.
vi.mock('../../src/extraction/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extraction/extract.js')>()
  return { ...actual, extractFacts: vi.fn() }
})
vi.mock('../../src/salience/salience.js', () => ({ scoreSalience: vi.fn() }))
vi.mock('../../src/extraction/update.js', () => ({ processUpdates: vi.fn() }))
vi.mock('../../src/extraction/profile-gen.js', () => ({
  regenerateProfile: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}))
vi.mock('../../src/extraction/session-reconstructor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extraction/session-reconstructor.js')>()
  return { ...actual, reconstructSessions: vi.fn() }
})

import { extractFacts } from '../../src/extraction/extract.js'
import { readMemorySalience, runExtraction } from '../../src/extraction/runner.ts'
import { reconstructSessions } from '../../src/extraction/session-reconstructor.js'
import type { ExtractedFact, ScoredFact } from '../../src/extraction/types.ts'
import { processUpdates } from '../../src/extraction/update.js'
import { scoreSalience } from '../../src/salience/salience.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG = {
  schedule: '0 2 * * *',
  model: 'gpt-4o',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

const SESSION_CONTENT = `---
id: conv_test_1
incognito: false
timestamp: 2026-01-15T10:00:00.000Z
tool: cursor
model: gpt-4o
---

## User
I am a senior backend engineer based in Riyadh working mostly with TypeScript.

## Assistant
Understood, noted.

## User
I strongly prefer PostgreSQL over MySQL for all production databases.

## Assistant
Noted, PostgreSQL it is.
`

const IDENTITY_FACT: ExtractedFact = {
  text: 'Senior backend engineer based in Riyadh',
  category: 'IDENTITY',
  confidence: 'HIGH',
}

/** Minimal QMDStore stub — runExtraction only calls update()/embed() here. */
function makeStore(): QMDStore {
  return {
    update: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore
}

// ---------------------------------------------------------------------------
// Scored fact → written memory frontmatter
// ---------------------------------------------------------------------------

describe('runExtraction — salience frontmatter', () => {
  let walletDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    walletDir = await mkdtemp(join(tmpdir(), 'salience-runner-'))
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('writes salienceScore/salienceTier frontmatter for a scored fact', async () => {
    const convDir = join(walletDir, 'conversations')
    await mkdir(convDir, { recursive: true })
    const sessionPath = join(convDir, 'sess.md')
    await writeFile(sessionPath, SESSION_CONTENT, 'utf8')

    vi.mocked(reconstructSessions).mockResolvedValue([
      {
        filePath: sessionPath,
        id: 'conv_test_1',
        messageCount: 3,
        model: 'gpt-4o',
        timestamp: '2026-01-15T10:00:00.000Z',
        tool: 'cursor',
      },
    ])
    vi.mocked(extractFacts).mockResolvedValue({
      ok: true,
      value: { facts: [IDENTITY_FACT], summaryUpdate: 'summary', conversationId: 'conv_test_1' },
    })
    vi.mocked(scoreSalience).mockResolvedValue({ score: 0.92, tier: 'core', reason: 'mocked' })
    // processUpdates passes the SCORED fact through unchanged as an ADD.
    vi.mocked(processUpdates).mockImplementation(async (facts) => ({
      ok: true,
      value: (facts as ScoredFact[]).map((fact) => ({ action: 'ADD' as const, fact })),
    }))

    const result = await runExtraction(walletDir, makeStore(), CONFIG)
    expect(result.ok).toBe(true)

    // Salience scored exactly once for the single fact, on the warm handle.
    expect(vi.mocked(scoreSalience)).toHaveBeenCalledTimes(1)

    const memDir = join(walletDir, 'memories')
    const memFiles = (await readdir(memDir)).filter((f) => f.endsWith('.md'))
    expect(memFiles).toHaveLength(1)

    const content = await readFile(join(memDir, memFiles[0]), 'utf8')
    expect(content).toMatch(/^salienceScore: 0\.92$/m)
    expect(content).toMatch(/^salienceTier: core$/m)
    // And the written frontmatter reads back through the backward-compat reader.
    expect(readMemorySalience(content)).toEqual({ salienceScore: 0.92, salienceTier: 'core' })
  })
})

// ---------------------------------------------------------------------------
// readMemorySalience — backward-compatible read
// ---------------------------------------------------------------------------

describe('readMemorySalience — backward-compatible read', () => {
  it('reads salience from new-style frontmatter', () => {
    const content = [
      '---',
      'id: mem_1',
      'category: IDENTITY',
      'confidence: HIGH',
      'salienceScore: 0.92',
      'salienceTier: core',
      'source: conv_1',
      'invalidatedAt: null',
      '---',
      '',
      'Senior backend engineer',
    ].join('\n')
    expect(readMemorySalience(content)).toEqual({ salienceScore: 0.92, salienceTier: 'core' })
  })

  it('OLD memory file with no salience lines still parses to neutral defaults', () => {
    const oldContent = [
      '---',
      'id: mem_old',
      'category: PREFERENCE',
      'confidence: MEDIUM',
      'source: conv_old',
      'createdAt: 2025-01-01T00:00:00.000Z',
      'validFrom: 2025-01-01T00:00:00.000Z',
      'invalidatedAt: null',
      '---',
      '',
      'Prefers tea over coffee',
    ].join('\n')
    expect(readMemorySalience(oldContent)).toEqual({
      salienceScore: 0.5,
      salienceTier: 'standard',
    })
  })

  it('invalid tier falls back to standard; out-of-range score is clamped', () => {
    const content = ['---', 'salienceScore: 5', 'salienceTier: legendary', '---', '', 'body'].join(
      '\n',
    )
    expect(readMemorySalience(content)).toEqual({ salienceScore: 1, salienceTier: 'standard' })
  })

  it('missing/empty frontmatter → defaults', () => {
    expect(readMemorySalience('no frontmatter at all')).toEqual({
      salienceScore: 0.5,
      salienceTier: 'standard',
    })
  })
})
