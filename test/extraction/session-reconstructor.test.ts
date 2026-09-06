import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  cleanSessionContent,
  HOOK_SESSION_ID_PREFIX,
  hasSubstantiveContent,
  reconstructSessions,
} from '../../src/extraction/session-reconstructor.js'

// ---------------------------------------------------------------------------
// reconstructSessions — hook archives are TURNS, grouped into sessions (D1)
// ---------------------------------------------------------------------------

interface ArchiveSpec {
  id: string
  tool: string
  provider: 'hook' | 'anthropic'
  timestamp: string
  messages: Array<[role: 'User' | 'Assistant', text: string]>
  sessionId?: string
  projectId?: string
  model?: string
  incognito?: boolean
}

function renderArchive(spec: ArchiveSpec): string {
  const fm = [
    '---',
    `id: ${spec.id}`,
    `tool: ${spec.tool}`,
    `provider: ${spec.provider}`,
    `model: ${spec.model ?? ''}`,
    `timestamp: ${spec.timestamp}`,
    'tokenEstimate: 10',
    `incognito: ${spec.incognito ?? false}`,
    ...(spec.projectId ? [`projectId: ${spec.projectId}`] : []),
    ...(spec.sessionId ? [`sessionId: ${spec.sessionId}`] : []),
    '---',
  ].join('\n')
  const body = spec.messages.map(([role, text]) => `## ${role}\n${text}`).join('\n\n')
  return `${fm}\n\n${body}\n`
}

const hookTurn = (
  id: string,
  ts: string,
  n: number,
  extra: Partial<ArchiveSpec> = {},
): ArchiveSpec => ({
  id,
  tool: 'claude-code',
  provider: 'hook',
  timestamp: ts,
  messages: [
    ['User', `Question number ${n} about the architecture of this service?`],
    ['Assistant', `Answer number ${n}.`],
  ],
  ...extra,
})

describe('reconstructSessions — hook turn grouping (D1)', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'mw-recon-'))
    await mkdir(join(walletDir, 'conversations', '2026-09-01'), { recursive: true })
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  async function seed(specs: ArchiveSpec[]): Promise<void> {
    for (const spec of specs) {
      await writeFile(
        join(walletDir, 'conversations', '2026-09-01', `${spec.id}.md`),
        renderArchive(spec),
        'utf8',
      )
    }
  }

  it('groups one-turn hook archives sharing a session_id into ONE synthetic session that passes the gate', async () => {
    await seed([
      hookTurn('conv_a1', '2026-09-01T10:00:00.000Z', 1, { sessionId: 's1' }),
      hookTurn('conv_a2', '2026-09-01T10:05:00.000Z', 2, { sessionId: 's1' }),
    ])
    const sessions = await reconstructSessions(walletDir)
    expect(sessions).toHaveLength(1)
    const [s] = sessions
    expect(s?.id.startsWith(HOOK_SESSION_ID_PREFIX)).toBe(true)
    expect(s?.messageCount).toBe(4)
    expect(s?.memberIds).toEqual(['conv_a1', 'conv_a2'])
    expect(s?.tool).toBe('claude-code')
    // Assembled content: real-looking frontmatter + both turns in order.
    expect(s?.content).toContain(`id: ${s?.id}`)
    expect(s?.content).toContain('provider: hook')
    expect(s?.content).toContain('sessionId: s1')
    expect(s?.content).toMatch(/Question number 1[\s\S]*Question number 2/)
    expect(cleanSessionContent(s?.content ?? '')).toContain('Answer number 2.')
  })

  it('a single one-turn hook archive is below the gate → no session (no more silent Layer-2 drop, just waiting)', async () => {
    await seed([hookTurn('conv_solo', '2026-09-01T10:00:00.000Z', 1, { sessionId: 's1' })])
    expect(await reconstructSessions(walletDir)).toHaveLength(0)
  })

  it('never merges different session_ids, tools, or projectIds', async () => {
    await seed([
      hookTurn('conv_1', '2026-09-01T10:00:00.000Z', 1, { sessionId: 'sA' }),
      hookTurn('conv_2', '2026-09-01T10:01:00.000Z', 2, { sessionId: 'sB' }),
      hookTurn('conv_3', '2026-09-01T10:02:00.000Z', 3, { sessionId: 'sA', tool: 'codex' }),
      hookTurn('conv_4', '2026-09-01T10:03:00.000Z', 4, {
        sessionId: 'sA',
        projectId: 'git:github.com/o/r',
      }),
    ])
    // Four distinct (tool, projectId, session) keys → four 2-message groups → all gated.
    expect(await reconstructSessions(walletDir)).toHaveLength(0)
  })

  it('falls back to the calendar day when no session_id was recorded', async () => {
    await seed([
      hookTurn('conv_d1', '2026-09-01T08:00:00.000Z', 1),
      hookTurn('conv_d2', '2026-09-01T18:00:00.000Z', 2),
      hookTurn('conv_d3', '2026-09-02T08:00:00.000Z', 3),
    ])
    const sessions = await reconstructSessions(walletDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.memberIds).toEqual(['conv_d1', 'conv_d2'])
  })

  it('excludes already-processed member turns BEFORE grouping (incremental sessions)', async () => {
    await seed([
      hookTurn('conv_p1', '2026-09-01T10:00:00.000Z', 1, { sessionId: 's1' }),
      hookTurn('conv_p2', '2026-09-01T10:01:00.000Z', 2, { sessionId: 's1' }),
      hookTurn('conv_p3', '2026-09-01T10:02:00.000Z', 3, { sessionId: 's1' }),
    ])
    const all = await reconstructSessions(walletDir)
    expect(all[0]?.memberIds).toEqual(['conv_p1', 'conv_p2', 'conv_p3'])

    const later = await reconstructSessions(walletDir, {
      processedIds: new Set(['conv_p1', 'conv_p2']),
    })
    // Only conv_p3 is left → 2 messages → gated; nothing to extract yet.
    expect(later).toHaveLength(0)

    const laterStill = await reconstructSessions(walletDir, { processedIds: new Set(['conv_p1']) })
    expect(laterStill[0]?.memberIds).toEqual(['conv_p2', 'conv_p3'])
    // Different membership → different synthetic id (deterministic per member set).
    expect(laterStill[0]?.id).not.toBe(all[0]?.id)
  })

  it('same members → same synthetic id across calls (a failed run retries the identical group)', async () => {
    await seed([
      hookTurn('conv_s1', '2026-09-01T10:00:00.000Z', 1, { sessionId: 's1' }),
      hookTurn('conv_s2', '2026-09-01T10:01:00.000Z', 2, { sessionId: 's1' }),
    ])
    const a = await reconstructSessions(walletDir)
    const b = await reconstructSessions(walletDir)
    expect(a[0]?.id).toBe(b[0]?.id)
  })

  it('skips incognito hook turns', async () => {
    await seed([
      hookTurn('conv_i1', '2026-09-01T10:00:00.000Z', 1, { sessionId: 's1', incognito: true }),
      hookTurn('conv_i2', '2026-09-01T10:01:00.000Z', 2, { sessionId: 's1' }),
    ])
    expect(await reconstructSessions(walletDir)).toHaveLength(0)
  })

  it('leaves proxy (non-hook) archives on the original cumulative-history algorithm', async () => {
    const proxy = (id: string, ts: string, count: number): ArchiveSpec => ({
      id,
      tool: 'claude-code',
      provider: 'anthropic',
      timestamp: ts,
      model: 'claude-sonnet-4',
      messages: Array.from({ length: count }, (_, i) =>
        i % 2 === 0
          ? (['User', `proxy user message ${i}`] as ['User', string])
          : (['Assistant', `proxy assistant message ${i}`] as ['Assistant', string]),
      ),
    })
    await seed([
      proxy('conv_x1', '2026-09-01T09:00:00.000Z', 2),
      proxy('conv_x2', '2026-09-01T09:01:00.000Z', 4),
      proxy('conv_x3', '2026-09-01T09:02:00.000Z', 6),
      // A hook turn in the middle of the proxy stream must NOT break the proxy session.
      hookTurn('conv_h', '2026-09-01T09:01:30.000Z', 1, { sessionId: 's1' }),
    ])
    const sessions = await reconstructSessions(walletDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe('conv_x3') // most complete file represents the proxy session
    expect(sessions[0]?.messageCount).toBe(6)
    expect(sessions[0]?.content).toBeUndefined()
  })
})

describe('cleanSessionContent', () => {
  it('keeps user and assistant sections, drops system', () => {
    const raw = [
      '## System',
      'You are a helpful assistant.',
      '',
      '## User',
      'I am Abdullah, building a payments app.',
      '',
      '## Assistant',
      'Got it — a payments app.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    expect(out).toContain('## User')
    expect(out).toContain('I am Abdullah, building a payments app.')
    expect(out).toContain('## Assistant')
    expect(out).not.toContain('You are a helpful assistant.')
    expect(out).not.toContain('## System')
  })

  it('drops [SUGGESTION MODE ...] autocomplete user turns (poison filter)', () => {
    const raw = [
      '## User',
      '[SUGGESTION MODE: complete the following code snippet]',
      '',
      '## Assistant',
      'const x = 1',
      '',
      '## User',
      'Actually, scratch Postgres — going with flat markdown files.',
      '',
      '## Assistant',
      'Understood, markdown it is.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    // Real user intent survives.
    expect(out).toContain('Actually, scratch Postgres')
    // Autocomplete poison is gone.
    expect(out).not.toContain('SUGGESTION MODE')
  })

  it('drops SUGGESTION turns even with leading markdown decoration', () => {
    const raw = ['## User', '> [SUGGESTION MODE: autocomplete]', '', '## Assistant', 'done'].join(
      '\n',
    )

    expect(cleanSessionContent(raw)).not.toContain('SUGGESTION')
  })

  it('does NOT drop a real user turn that merely mentions suggestion mode mid-sentence', () => {
    const raw = [
      '## User',
      'Can you explain what [SUGGESTION usage looks like in practice?',
      '',
      '## Assistant',
      'Sure.',
    ].join('\n')

    // Body does not START with [SUGGESTION → kept.
    expect(cleanSessionContent(raw)).toContain('Can you explain')
  })

  it('strips injected memory/context tags from kept sections', () => {
    const raw = [
      '## User',
      '<dhakira_context>prior memory</dhakira_context>',
      'What did we decide about the database?',
      '',
      '## Assistant',
      'We chose markdown.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    expect(out).not.toContain('prior memory')
    expect(out).toContain('What did we decide about the database?')
  })
})

describe('hasSubstantiveContent', () => {
  it('returns true with >=2 substantive user messages', () => {
    const cleaned = [
      '## User',
      'I am Abdullah and I am building a portable AI memory wallet.',
      '## Assistant',
      'Great — tell me more.',
      '## User',
      'My real goal is impact, not financial gain whatsoever.',
      '## Assistant',
      'Understood.',
    ].join('\n')
    expect(hasSubstantiveContent(cleaned)).toBe(true)
  })

  it('returns false with only short user messages', () => {
    const cleaned = ['## User', 'hi', '## User', 'ok'].join('\n')
    expect(hasSubstantiveContent(cleaned)).toBe(false)
  })
})
