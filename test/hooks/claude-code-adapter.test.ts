// CP3 tests for the Claude Code hook adapter.
//
// Two things matter most here:
//   1. Request shaping — the adapter sends the verified payloads to /api/recall and
//      /api/ingest, and extracts the right turn from a real-shaped transcript.
//   2. FAIL-OPEN (the acceptance bar) — daemon down / slow / 500 must NEVER throw and
//      must inject nothing / skip capture. A stuck daemon cannot stall Claude Code.
//
// Every daemon call is exercised through an injected fetch (no real sockets); the
// transcript reader is injected too, so these tests are hermetic and fast.

import { describe, expect, it } from 'vitest'

import {
  extractLastTurn,
  handleEvent,
  runStop,
  runUserPromptSubmit,
} from '../../src/hooks/claude-code-adapter.ts'

interface FetchCall {
  url: string
  body: Record<string, unknown> | undefined
}

/** A fake fetch that records calls and replies with a fixed { ok, json }. No sockets. */
function recordingFetch(reply: { ok: boolean; json: unknown }): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined
    calls.push({
      url: String(input),
      body: bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : undefined,
    })
    return { ok: reply.ok, json: async () => reply.json } as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** A fake fetch that simulates the daemon being down (connection refused). */
const downFetch = (async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:4101')
}) as typeof fetch

/** A fake fetch that never resolves until aborted — simulates a hung/slow daemon. */
const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })) as typeof fetch

const TRANSCRIPT = [
  JSON.stringify({ type: 'mode', mode: 'normal' }),
  // Meta caveat record — must be skipped, never treated as the user prompt.
  JSON.stringify({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '<local-command-caveat>Caveat...</local-command-caveat>' },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'How do I configure the retry backoff?' },
  }),
  // Assistant turn with thinking + tool_use only — yields no text on its own.
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me check' },
        { type: 'tool_use', name: 'Read', input: {} },
      ],
    },
  }),
  // Tool result delivered as a user record — must be skipped (not a real prompt).
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents here' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Set client.retry.backoffMs to an exponential schedule.' }],
    },
  }),
].join('\n')

describe('extractLastTurn', () => {
  it('pairs the last real user prompt with the assistant final reply (payload wins)', () => {
    const turn = extractLastTurn(
      TRANSCRIPT,
      'Set client.retry.backoffMs to an exponential schedule.',
    )
    expect(turn).not.toBeNull()
    expect(turn?.user).toBe('How do I configure the retry backoff?')
    expect(turn?.assistant).toContain('backoffMs')
  })

  it('falls back to last assistant text in transcript when no payload message', () => {
    const turn = extractLastTurn(TRANSCRIPT, '')
    expect(turn?.assistant).toBe('Set client.retry.backoffMs to an exponential schedule.')
  })

  it('skips isMeta and isSidechain records', () => {
    const raw = [
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'subagent' },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real prompt' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'answer' } }),
    ].join('\n')
    const turn = extractLastTurn(raw, '')
    expect(turn?.user).toBe('real prompt')
  })

  it('strips injected dhakira_context / system-reminder so recall is not re-ingested', () => {
    const raw = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<system-reminder><dhakira_context>old memory</dhakira_context></system-reminder>What is the cache policy?',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'We version it.' },
      }),
    ].join('\n')
    const turn = extractLastTurn(raw, '')
    expect(turn?.user).toBe('What is the cache policy?')
    expect(turn?.user).not.toContain('old memory')
  })

  it('returns null when there is no user or no assistant turn', () => {
    expect(extractLastTurn('', '')).toBeNull()
    expect(
      extractLastTurn(
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        '',
      ),
    ).toBeNull()
  })
})

describe('runUserPromptSubmit — recall + inject', () => {
  it('injects daemon text as additionalContext and sends the verified payload', async () => {
    const { fetchImpl, calls } = recordingFetch({
      ok: true,
      json: { text: '<dhakira_context>remembered</dhakira_context>', turnCount: 2, projectId: 'p' },
    })
    const out = await runUserPromptSubmit(
      { prompt: 'how does auth work?', cwd: '/home/me/proj', hook_event_name: 'UserPromptSubmit' },
      { fetchImpl, baseUrl: 'http://127.0.0.1:4101' },
    )

    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<dhakira_context>remembered</dhakira_context>',
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:4101/api/recall')
    expect(calls[0]?.body).toMatchObject({
      query: 'how does auth work?',
      tool: 'claude-code',
      cwd: '/home/me/proj',
    })
  })

  it('returns null (inject nothing) when the daemon has no memory', async () => {
    const { fetchImpl } = recordingFetch({
      ok: true,
      json: { text: null, turnCount: 0, projectId: 'global' },
    })
    const out = await runUserPromptSubmit({ prompt: 'hi' }, { fetchImpl })
    expect(out).toBeNull()
  })

  it('returns null without calling the daemon when the prompt is empty', async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, json: { text: 'x' } })
    const out = await runUserPromptSubmit({ prompt: '   ' }, { fetchImpl })
    expect(out).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('FAIL-OPEN: daemon DOWN → returns null, does not throw', async () => {
    const out = await runUserPromptSubmit({ prompt: 'hello' }, { fetchImpl: downFetch })
    expect(out).toBeNull()
  })

  it('FAIL-OPEN: daemon SLOW (hang) → aborts on timeout and returns null', async () => {
    const out = await runUserPromptSubmit(
      { prompt: 'hello' },
      { fetchImpl: hangingFetch, timeoutMs: 20 },
    )
    expect(out).toBeNull()
  })

  it('FAIL-OPEN: daemon 500 → returns null', async () => {
    const { fetchImpl } = recordingFetch({ ok: false, json: {} })
    const out = await runUserPromptSubmit({ prompt: 'hello' }, { fetchImpl })
    expect(out).toBeNull()
  })
})

describe('runStop — transcript → ingest', () => {
  it('posts the just-finished turn with the verified ingest payload', async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, json: { ok: true, captured: true } })
    const outcome = await runStop(
      {
        transcript_path: '/tmp/session.jsonl',
        cwd: '/home/me/proj',
        last_assistant_message: 'Set client.retry.backoffMs to an exponential schedule.',
        hook_event_name: 'Stop',
      },
      { fetchImpl, readTranscript: () => TRANSCRIPT },
    )

    expect(outcome.posted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/api/ingest')
    expect(calls[0]?.body).toMatchObject({ tool: 'claude-code', cwd: '/home/me/proj' })
    const messages = calls[0]?.body?.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'How do I configure the retry backoff?',
    })
    expect(messages[1]?.role).toBe('assistant')
  })

  it('skips capture (no post) when the transcript has no extractable turn', async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, json: {} })
    const outcome = await runStop(
      { transcript_path: '/tmp/session.jsonl' },
      { fetchImpl, readTranscript: () => '' },
    )
    expect(outcome.posted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('skips capture when no transcript_path is provided', async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, json: {} })
    const outcome = await runStop({}, { fetchImpl })
    expect(outcome.posted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('FAIL-OPEN: daemon DOWN during ingest → no throw, posted false', async () => {
    const outcome = await runStop(
      { transcript_path: '/tmp/session.jsonl', last_assistant_message: 'answer' },
      { fetchImpl: downFetch, readTranscript: () => TRANSCRIPT },
    )
    expect(outcome.posted).toBe(false)
  })
})

describe('handleEvent — stdout dispatch', () => {
  it('UserPromptSubmit success → JSON string for stdout', async () => {
    const { fetchImpl } = recordingFetch({ ok: true, json: { text: 'mem' } })
    const out = await handleEvent('UserPromptSubmit', { prompt: 'q' }, { fetchImpl })
    expect(JSON.parse(out)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'mem' },
    })
  })

  it('UserPromptSubmit with daemon down → empty string (inject nothing)', async () => {
    const out = await handleEvent('UserPromptSubmit', { prompt: 'q' }, { fetchImpl: downFetch })
    expect(out).toBe('')
  })

  it('Stop always returns empty string (let Claude stop)', async () => {
    const { fetchImpl } = recordingFetch({ ok: true, json: { ok: true } })
    const out = await handleEvent(
      'Stop',
      { transcript_path: '/tmp/s.jsonl', last_assistant_message: 'a' },
      { fetchImpl, readTranscript: () => TRANSCRIPT },
    )
    expect(out).toBe('')
  })

  it('unknown event → empty string', async () => {
    const out = await handleEvent('SessionStart', {})
    expect(out).toBe('')
  })
})
