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

const CONFIG = {
  model: 'gpt-4o',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

/** A HIGH-confidence memory file; `forgottenAt` optionally stamped (T06 soft-forget). */
function memoryFile(id: string, body: string, forgottenAt?: string): string {
  const lines = [
    '---',
    `id: ${id}`,
    'category: IDENTITY',
    'confidence: HIGH',
    'salienceScore: 0.9',
    'salienceTier: standard',
    `source: conv_${id}`,
    'createdAt: 2026-01-01T00:00:00.000Z',
    'validFrom: 2026-01-01T00:00:00.000Z',
    'invalidatedAt: null',
    'expiresAt: null',
  ]
  if (forgottenAt) lines.push(`forgottenAt: ${forgottenAt}`)
  lines.push('---', '', body)
  return lines.join('\n')
}

function capturedPrompt(): string {
  const call = vi.mocked(callExtractionLLM).mock.calls[0]
  const messages = call[1] as { role: string; content: string }[]
  return messages[0].content
}

describe('regenerateProfile — soft-forgotten memories are excluded (T06 read-path)', () => {
  let walletDir: string
  let memoriesDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    walletDir = await mkdtemp(join(tmpdir(), 'profile-gen-forget-'))
    memoriesDir = join(walletDir, 'memories')
    await mkdir(memoriesDir, { recursive: true })
    vi.mocked(callExtractionLLM).mockResolvedValue({ ok: true, value: {} as never })
    vi.mocked(extractContent).mockReturnValue({ ok: true, value: 'PROFILE' })
  })

  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('a forgotten HIGH-confidence memory is invisible exactly like a superseded one', async () => {
    await writeFile(join(memoriesDir, 'active.md'), memoryFile('active', 'ACTIVE-BODY'), 'utf8')
    await writeFile(
      join(memoriesDir, 'forgotten.md'),
      memoryFile('forgotten', 'FORGOTTEN-BODY', '2026-06-03T00:00:00.000Z'),
      'utf8',
    )

    const result = await regenerateProfile(walletDir, CONFIG)
    expect(result.ok).toBe(true)

    const prompt = capturedPrompt()
    expect(prompt).toContain('ACTIVE-BODY')
    expect(prompt).not.toContain('FORGOTTEN-BODY')
  })
})
