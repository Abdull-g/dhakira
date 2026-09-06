// v0.3.1 G1 regression lock (audit D1): hook captures MUST reach Layer 2.
//
// Before this release every hook archive (exactly one user + assistant exchange)
// was dropped by the session reconstructor's "< 3 messages" gate, so extraction,
// salience, consolidation, forget, profile and project docs never ran for a wallet
// fed only by Claude Code / Codex hooks. This test drives the REAL path end to end:
//
//   /api/ingest-shaped hook turns → ingestTrace (real hygiene chain, real QMD
//   store on disk) → runExtraction (real session reconstruction + real memory
//   write path; only the model / network boundaries are mocked).
//
// Airtight by construction: it asserts on what lands on disk (memory files and
// .extraction-state.json), not on internal call counts alone.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Model / network boundaries ONLY. Everything between the hook payload and the
// memory file on disk is the real code.
vi.mock('../../src/extraction/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extraction/extract.js')>()
  return { ...actual, extractFacts: vi.fn() }
})
vi.mock('../../src/salience/salience.js', () => ({ scoreSalience: vi.fn() }))
vi.mock('../../src/extraction/update.js', () => ({ processUpdates: vi.fn() }))
vi.mock('../../src/extraction/profile-gen.js', () => ({
  regenerateProfile: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}))
vi.mock('../../src/synthesis/regenerate.js', () => ({
  regenerateProjectDocs: vi.fn().mockResolvedValue(undefined),
}))
// ingestTrace fires the auto-trigger after every capture; keep it inert here so
// the assertions below control exactly when extraction runs. The trigger itself
// is exercised (for real) in the last describe block via vi.importActual.
vi.mock('../../src/extraction/trigger.js', () => ({
  maybeTriggerExtraction: vi.fn().mockResolvedValue(undefined),
}))

import type { WalletConfig } from '../../src/config/schema.ts'
import { extractFacts } from '../../src/extraction/extract.js'
import { runExtraction } from '../../src/extraction/runner.ts'
import { HOOK_SESSION_ID_PREFIX } from '../../src/extraction/session-reconstructor.ts'
import type { ExtractedFact, ScoredFact } from '../../src/extraction/types.ts'
import { processUpdates } from '../../src/extraction/update.js'
import { ingestTrace } from '../../src/ingest.ts'
import { createWalletStore } from '../../src/retrieval/store.ts'
import { scoreSalience } from '../../src/salience/salience.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(walletDir: string): WalletConfig {
  return {
    walletDir,
    proxy: { port: 0, host: '127.0.0.1' },
    dashboard: { port: 0, host: '127.0.0.1' },
    tools: [],
    capture: { pipelineVersion: 'v2', debug: false },
    extraction: {
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    },
    retrieval: { modelsResident: true },
    injection: {
      maxTokens: 1800,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
      globalMaxTokens: 250,
      projectMaxTokens: 600,
    },
    incognito: false,
  }
}

/** Three REAL-shaped hook turns from one Claude Code session (each = 2 messages). */
const SESSION_A = 'sess-aaaa-1111'
const TURNS_A = [
  {
    user: 'I am a senior backend engineer based in Riyadh, working mostly in TypeScript.',
    assistant: 'Understood — TypeScript backend, Riyadh. How can I help today?',
  },
  {
    user: 'For this service we decided on PostgreSQL over MySQL because of JSONB and partial indexes.',
    assistant: 'Makes sense; JSONB plus partial indexes covers your event-payload queries well.',
  },
  {
    user: 'Convention for this repo: named exports only, never default exports, errors as values.',
    assistant: 'Noted — named exports only and Result-style errors throughout.',
  },
]

const FACT_IDENTITY: ExtractedFact = {
  text: 'Senior backend engineer based in Riyadh who works mostly in TypeScript',
  category: 'IDENTITY',
  confidence: 'HIGH',
}
const FACT_DECISION: ExtractedFact = {
  text: 'Chose PostgreSQL over MySQL for JSONB and partial indexes',
  category: 'CONTEXT',
  confidence: 'HIGH',
}

const extractFactsMock = vi.mocked(extractFacts)
const scoreSalienceMock = vi.mocked(scoreSalience)
const processUpdatesMock = vi.mocked(processUpdates)

/** Reset every model-boundary mock to a "happy" extraction that ADDs whatever it is given. */
function primeHappyModels(facts: ExtractedFact[]): void {
  extractFactsMock.mockReset()
  extractFactsMock.mockResolvedValue({
    ok: true,
    value: { facts, summaryUpdate: 'Discussed stack and conventions.' },
  })
  scoreSalienceMock.mockReset()
  scoreSalienceMock.mockResolvedValue({ score: 0.8, tier: 'standard', reason: 'test' })
  processUpdatesMock.mockReset()
  processUpdatesMock.mockImplementation(async (scored: ScoredFact[]) => ({
    ok: true,
    value: scored.map((fact) => ({ action: 'ADD' as const, fact })),
  }))
}

async function readMemoryFiles(walletDir: string): Promise<string[]> {
  try {
    const entries = (await readdir(join(walletDir, 'memories'), { recursive: true })) as string[]
    const files = entries.filter((f) => f.endsWith('.md'))
    return await Promise.all(files.map((f) => readFile(join(walletDir, 'memories', f), 'utf8')))
  } catch {
    return []
  }
}

async function readState(walletDir: string): Promise<{ processedConversationIds: string[] }> {
  return JSON.parse(await readFile(join(walletDir, '.extraction-state.json'), 'utf8')) as {
    processedConversationIds: string[]
  }
}

// ---------------------------------------------------------------------------

describe('hook captures reach Layer 2 (D1 regression lock)', () => {
  let walletDir: string
  let store: QMDStore
  let config: WalletConfig

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-hook-l2-'))
    const res = await createWalletStore(walletDir)
    if (!res.ok) throw res.error
    store = res.value
    // Never load embedding models in tests: embed()/update() are the only store
    // calls runExtraction makes, and neither affects what this test asserts.
    store.embed = vi.fn().mockResolvedValue(undefined) as unknown as QMDStore['embed']
    store.update = vi.fn().mockResolvedValue(undefined) as unknown as QMDStore['update']
    config = makeConfig(walletDir)
    primeHappyModels([FACT_IDENTITY, FACT_DECISION])
  })

  afterEach(async () => {
    try {
      await store.close()
    } catch {
      // already closed
    }
    await rm(walletDir, { recursive: true, force: true })
  })

  async function ingestHookTurn(
    turn: { user: string; assistant: string },
    sessionId: string | undefined,
    opts: { tool?: string; cwd?: string; timestamp?: Date } = {},
  ): Promise<void> {
    const result = await ingestTrace(
      { store, config },
      {
        messages: [
          { role: 'user', content: turn.user },
          { role: 'assistant', content: turn.assistant },
        ],
        tool: opts.tool ?? 'claude-code',
        sessionId,
        cwd: opts.cwd,
        timestamp: opts.timestamp,
      },
    )
    expect(result.ok).toBe(true)
    expect(result.captured).toBe(true)
  }

  it('three 2-message hook turns (same tool + session_id) → extraction processes them as ONE session and writes facts', async () => {
    for (const turn of TURNS_A) await ingestHookTurn(turn, SESSION_A)

    // Sanity: three one-turn archives exist on disk, each stamped with the session id.
    const convEntries = (await readdir(join(walletDir, 'conversations'), {
      recursive: true,
    })) as string[]
    const archives = convEntries.filter((f) => f.endsWith('.md'))
    expect(archives).toHaveLength(3)
    for (const f of archives) {
      const content = await readFile(join(walletDir, 'conversations', f), 'utf8')
      expect(content).toContain('provider: hook')
      expect(content).toContain(`sessionId: ${SESSION_A}`)
    }

    const result = await runExtraction(walletDir, store, config.extraction)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // THE regression assertion: Layer 2 saw the hook session.
    expect(result.value.conversationsProcessed).toBeGreaterThanOrEqual(1)
    expect(result.value.factsExtracted).toBe(2)
    expect(result.value.memoriesCreated).toBe(2)

    // The model was handed ALL THREE turns as one cleaned session.
    expect(extractFactsMock).toHaveBeenCalledTimes(1)
    const cleaned = extractFactsMock.mock.calls[0]?.[0] as string
    for (const turn of TURNS_A) {
      expect(cleaned).toContain(turn.user)
      expect(cleaned).toContain(turn.assistant)
    }
    // Synthetic session id + the source conversation date were threaded through.
    const sourceId = extractFactsMock.mock.calls[0]?.[4] as string
    expect(sourceId.startsWith(HOOK_SESSION_ID_PREFIX)).toBe(true)

    // Extracted facts exist ON DISK as memory files with real frontmatter.
    const memories = await readMemoryFiles(walletDir)
    expect(memories).toHaveLength(2)
    const texts = memories.join('\n')
    expect(texts).toContain(FACT_IDENTITY.text)
    expect(texts).toContain(FACT_DECISION.text)
    expect(texts).toContain(`source: ${sourceId}`)
    expect(texts).toMatch(/salienceTier: standard/)

    // State: the synthetic session AND every member archive are marked processed.
    const state = await readState(walletDir)
    expect(state.processedConversationIds).toContain(sourceId)
    const archiveIds = await Promise.all(
      archives.map(async (f) => {
        const content = await readFile(join(walletDir, 'conversations', f), 'utf8')
        return content.match(/^id: (.+)$/m)?.[1] ?? ''
      }),
    )
    expect(archiveIds).toHaveLength(3)
    for (const id of archiveIds) expect(state.processedConversationIds).toContain(id)
  })

  it('is idempotent: a second run over the same turns processes 0 and writes nothing new', async () => {
    for (const turn of TURNS_A) await ingestHookTurn(turn, SESSION_A)
    const first = await runExtraction(walletDir, store, config.extraction)
    expect(first.ok && first.value.conversationsProcessed).toBe(1)

    extractFactsMock.mockClear()
    const second = await runExtraction(walletDir, store, config.extraction)
    expect(second.ok && second.value.conversationsProcessed).toBe(0)
    expect(extractFactsMock).not.toHaveBeenCalled()
    expect(await readMemoryFiles(walletDir)).toHaveLength(2)
  })

  it('extracts INCREMENTALLY: new turns in an already-processed session form a fresh group', async () => {
    for (const turn of TURNS_A) await ingestHookTurn(turn, SESSION_A)
    await runExtraction(walletDir, store, config.extraction)
    extractFactsMock.mockClear()

    // Two more turns arrive later in the same session.
    await ingestHookTurn(
      { user: 'We also agreed to keep the API versioned under /v1 for now.', assistant: 'OK.' },
      SESSION_A,
    )
    await ingestHookTurn(
      { user: 'And the team prefers squash merges on this repository.', assistant: 'Noted.' },
      SESSION_A,
    )
    const result = await runExtraction(walletDir, store, config.extraction)
    expect(result.ok && result.value.conversationsProcessed).toBe(1)

    // Only the NEW turns were sent — the first three were not re-extracted.
    const cleaned = extractFactsMock.mock.calls[0]?.[0] as string
    expect(cleaned).toContain('versioned under /v1')
    expect(cleaned).toContain('squash merges')
    expect(cleaned).not.toContain(TURNS_A[0]?.user ?? '@@')
  })

  it('a lone 2-message hook turn stays below the gate and is NOT extracted (waits for its session)', async () => {
    await ingestHookTurn(TURNS_A[0] as { user: string; assistant: string }, 'sess-lonely')
    const result = await runExtraction(walletDir, store, config.extraction)
    expect(result.ok && result.value.conversationsProcessed).toBe(0)
    expect(extractFactsMock).not.toHaveBeenCalled()
    expect(await readMemoryFiles(walletDir)).toHaveLength(0)
  })

  it('does NOT merge turns from different session_ids into one session', async () => {
    // Three sessions, one turn each → each group has 2 messages → all below the gate.
    await ingestHookTurn(TURNS_A[0] as { user: string; assistant: string }, 'sess-1')
    await ingestHookTurn(TURNS_A[1] as { user: string; assistant: string }, 'sess-2')
    await ingestHookTurn(TURNS_A[2] as { user: string; assistant: string }, 'sess-3')
    const result = await runExtraction(walletDir, store, config.extraction)
    expect(result.ok && result.value.conversationsProcessed).toBe(0)
    expect(extractFactsMock).not.toHaveBeenCalled()
  })

  it('falls back to grouping by (tool, projectId, calendar day) when the tool sent no session_id', async () => {
    const day = new Date('2026-09-01T09:00:00.000Z')
    for (const [i, turn] of TURNS_A.entries()) {
      await ingestHookTurn(turn, undefined, {
        timestamp: new Date(day.getTime() + i * 60_000),
      })
    }
    // A turn on a DIFFERENT day must not join that group.
    await ingestHookTurn(
      {
        user: 'Unrelated question from another day about a totally different thing.',
        assistant: 'Sure.',
      },
      undefined,
      { timestamp: new Date('2026-09-03T09:00:00.000Z') },
    )

    const result = await runExtraction(walletDir, store, config.extraction)
    expect(result.ok && result.value.conversationsProcessed).toBe(1)
    const cleaned = extractFactsMock.mock.calls[0]?.[0] as string
    for (const turn of TURNS_A) expect(cleaned).toContain(turn.user)
    expect(cleaned).not.toContain('another day')
  })

  it('a failed model call leaves the group unprocessed so the next run retries the SAME turns', async () => {
    for (const turn of TURNS_A) await ingestHookTurn(turn, SESSION_A)
    extractFactsMock.mockResolvedValueOnce({ ok: false, error: new Error('rate limited') })

    const first = await runExtraction(walletDir, store, config.extraction)
    expect(first.ok && first.value.conversationsProcessed).toBe(0)
    expect(await readMemoryFiles(walletDir)).toHaveLength(0)

    const second = await runExtraction(walletDir, store, config.extraction)
    expect(second.ok && second.value.conversationsProcessed).toBe(1)
    expect(await readMemoryFiles(walletDir)).toHaveLength(2)
  })
})

describe('auto-trigger → extraction → hook session (G1.4)', () => {
  let walletDir: string
  let store: QMDStore
  let config: WalletConfig

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-hook-trigger-'))
    const res = await createWalletStore(walletDir)
    if (!res.ok) throw res.error
    store = res.value
    store.embed = vi.fn().mockResolvedValue(undefined) as unknown as QMDStore['embed']
    store.update = vi.fn().mockResolvedValue(undefined) as unknown as QMDStore['update']
    config = makeConfig(walletDir)
    primeHappyModels([FACT_IDENTITY])
  })

  afterEach(async () => {
    try {
      await store.close()
    } catch {
      // already closed
    }
    await rm(walletDir, { recursive: true, force: true })
  })

  it('the REAL trigger fires extraction after the first-run threshold and real hook conversations get processed', async () => {
    const { maybeTriggerExtraction: realTrigger } = await vi.importActual<
      typeof import('../../src/extraction/trigger.js')
    >('../../src/extraction/trigger.js')

    // 10 substantive hook turns in one session (first-run threshold is 10 captures).
    for (let i = 0; i < 10; i++) {
      const result = await ingestTrace(
        { store, config },
        {
          messages: [
            {
              role: 'user',
              content: `Turn ${i}: we standardised on pnpm workspaces for this monorepo because of strict hoisting.`,
            },
            {
              role: 'assistant',
              content: `Noted for turn ${i}: pnpm workspaces, strict hoisting.`,
            },
          ],
          tool: 'claude-code',
          sessionId: 'sess-trigger',
        },
      )
      expect(result.captured).toBe(true)
    }

    // Drive the real trigger the way ingestTrace does — once per capture.
    for (let i = 0; i < 10; i++) await realTrigger(walletDir, store, config)

    expect(extractFactsMock).toHaveBeenCalledTimes(1)
    const cleaned = extractFactsMock.mock.calls[0]?.[0] as string
    expect(cleaned).toContain('Turn 0:')
    expect(cleaned).toContain('Turn 9:')
    expect(await readMemoryFiles(walletDir)).toHaveLength(1)
  })
})
