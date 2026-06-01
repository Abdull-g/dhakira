import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the model boundary so regenerateProfile runs the REAL memory-selection
// path (collectHighConfidenceMemories) without a model/network call. We inspect
// the prompt handed to the LLM to see WHICH memories were selected.
vi.mock('../../src/extraction/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extraction/extract.js')>()
  return {
    ...actual,
    callExtractionLLM: vi.fn(),
    extractContent: vi.fn(),
  }
})

import { callExtractionLLM, extractContent } from '../../src/extraction/extract.js'
import { regenerateProfile } from '../../src/extraction/profile-gen.js'
import type { SalienceTier } from '../../src/salience/types.js'

const CONFIG = {
  model: 'gpt-4o',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

function memoryFile(id: string, tier: SalienceTier, body: string): string {
  return [
    '---',
    `id: ${id}`,
    'category: IDENTITY',
    'confidence: HIGH',
    'salienceScore: 0.9',
    `salienceTier: ${tier}`,
    `source: conv_${id}`,
    'createdAt: 2026-01-01T00:00:00.000Z',
    'validFrom: 2026-01-01T00:00:00.000Z',
    'invalidatedAt: null',
    'expiresAt: null',
    '---',
    '',
    body,
  ].join('\n')
}

/** The prompt text passed to the LLM contains the numbered, selected memory bodies. */
function capturedPrompt(): string {
  const call = vi.mocked(callExtractionLLM).mock.calls[0]
  const messages = call[1] as { role: string; content: string }[]
  return messages[0].content
}

describe('regenerateProfile — salience-aware memory selection', () => {
  let walletDir: string
  let memoriesDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    walletDir = await mkdtemp(join(tmpdir(), 'profile-gen-salience-'))
    memoriesDir = join(walletDir, 'memories')
    await mkdir(memoriesDir, { recursive: true })
    vi.mocked(callExtractionLLM).mockResolvedValue({ ok: true, value: {} as never })
    vi.mocked(extractContent).mockReturnValue({ ok: true, value: 'PROFILE' })
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('small wallet (N < cap) → ALL eligible memories included (behavior unchanged)', async () => {
    await writeFile(join(memoriesDir, 'a.md'), memoryFile('a', 'core', 'CORE-BODY'), 'utf8')
    await writeFile(join(memoriesDir, 'b.md'), memoryFile('b', 'standard', 'STANDARD-BODY'), 'utf8')
    await writeFile(join(memoriesDir, 'c.md'), memoryFile('c', 'trivia', 'TRIVIA-BODY'), 'utf8')

    const result = await regenerateProfile(walletDir, CONFIG)
    expect(result.ok).toBe(true)

    const prompt = capturedPrompt()
    expect(prompt).toContain('CORE-BODY')
    expect(prompt).toContain('STANDARD-BODY')
    expect(prompt).toContain('TRIVIA-BODY')
  })

  it('large wallet (N > cap) → core preferred, capped at 40, trivia dropped first', async () => {
    // 10 core + 40 trivia = 50 eligible > 40 cap. Selection should keep all
    // 10 core, fill the rest (30) with trivia, and drop 10 trivia.
    for (let i = 0; i < 10; i++) {
      await writeFile(
        join(memoriesDir, `core-${i}.md`),
        memoryFile(`core-${i}`, 'core', `CORE-${i}`),
        'utf8',
      )
    }
    for (let i = 0; i < 40; i++) {
      await writeFile(
        join(memoriesDir, `trivia-${i}.md`),
        memoryFile(`trivia-${i}`, 'trivia', `TRIVIA-${i}`),
        'utf8',
      )
    }

    const result = await regenerateProfile(walletDir, CONFIG)
    expect(result.ok).toBe(true)

    const prompt = capturedPrompt()
    const includedCount = (prompt.match(/^\d+\. /gm) ?? []).length
    expect(includedCount).toBe(40)

    // Every core memory survives the cap.
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`CORE-${i}`)
    }
    // Exactly 30 trivia made the cut (50 − 40 dropped = 10 trivia excluded).
    const triviaIncluded = (prompt.match(/TRIVIA-\d+/g) ?? []).length
    expect(triviaIncluded).toBe(30)
  })
})
