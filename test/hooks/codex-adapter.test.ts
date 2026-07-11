import { describe, expect, it } from 'vitest'

import {
  extractLastTurn,
  handleEvent,
  runStop,
  runUserPromptSubmit,
} from '../../src/hooks/codex-adapter.ts'

interface FetchCall {
  url: string
  body: Record<string, unknown> | undefined
}

function recordingFetch(reply: { ok: boolean; json: unknown }): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({
      url: String(input),
      body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
    })
    return { ok: reply.ok, json: async () => reply.json } as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

const downFetch = (async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:4101')
}) as typeof fetch

const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })) as typeof fetch

const CODEX_TRANSCRIPT = [
  JSON.stringify({
    type: 'session_meta',
    payload: { id: 'session-1', cwd: '/work/repo' },
  }),
  // Environment context is represented as a user wire message, but it is not the prompt.
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }],
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'How should retries be bounded?' }],
    },
  }),
  // The explicit user event is preferred over response_item user records.
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: 'How should retries be bounded?',
      images: [],
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Use capped exponential backoff.' }],
    },
  }),
].join('\n')

describe('Codex transcript parsing', () => {
  it('uses the explicit user event and Stop last_assistant_message', () => {
    expect(extractLastTurn(CODEX_TRANSCRIPT, 'Payload assistant answer.')).toEqual({
      user: 'How should retries be bounded?',
      assistant: 'Payload assistant answer.',
    })
  })

  it('falls back to Codex response_item messages when needed', () => {
    const transcript = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fallback prompt' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fallback answer' }],
        },
      }),
    ].join('\n')

    expect(extractLastTurn(transcript)).toEqual({
      user: 'Fallback prompt',
      assistant: 'Fallback answer',
    })
  })
})

describe('Codex UserPromptSubmit', () => {
  it('shapes recall with the codex stamp and turn_id', async () => {
    const { fetchImpl, calls } = recordingFetch({
      ok: true,
      json: { text: '<dhakira_context>memory</dhakira_context>' },
    })

    const output = await runUserPromptSubmit(
      {
        prompt: 'How does auth work?',
        cwd: '/work/repo',
        turn_id: 'turn-1',
        hook_event_name: 'UserPromptSubmit',
      },
      { fetchImpl },
    )

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<dhakira_context>memory</dhakira_context>',
      },
    })
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:4101/api/recall',
        body: {
          query: 'How does auth work?',
          tool: 'codex',
          cwd: '/work/repo',
          turnId: 'turn-1',
        },
      },
    ])
  })

  it('fails open when the daemon is down', async () => {
    await expect(
      runUserPromptSubmit({ prompt: 'hello', turn_id: 'turn-2' }, { fetchImpl: downFetch }),
    ).resolves.toBeNull()
  })

  it('emits empty output when the daemon times out', async () => {
    await expect(
      handleEvent(
        'UserPromptSubmit',
        { prompt: 'hello', turn_id: 'turn-3' },
        { fetchImpl: hangingFetch, timeoutMs: 20 },
      ),
    ).resolves.toBe('')
  })
})

describe('Codex Stop', () => {
  it('uses last_assistant_message and shapes ingest metadata', async () => {
    const { fetchImpl, calls } = recordingFetch({
      ok: true,
      json: { ok: true, captured: true },
    })

    const outcome = await runStop(
      {
        transcript_path: '/tmp/codex-rollout.jsonl',
        cwd: '/work/repo',
        turn_id: 'turn-4',
        model: 'gpt-5.6-sol',
        last_assistant_message: 'The answer supplied directly by Stop.',
        hook_event_name: 'Stop',
      },
      { fetchImpl, readTranscript: () => CODEX_TRANSCRIPT },
    )

    expect(outcome.posted).toBe(true)
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:4101/api/ingest',
      body: {
        messages: [
          { role: 'user', content: 'How should retries be bounded?' },
          { role: 'assistant', content: 'The answer supplied directly by Stop.' },
        ],
        tool: 'codex',
        cwd: '/work/repo',
        model: 'gpt-5.6-sol',
        turnId: 'turn-4',
      },
    })
  })

  it('fails open when ingest cannot reach the daemon', async () => {
    const outcome = await runStop(
      {
        transcript_path: '/tmp/codex-rollout.jsonl',
        last_assistant_message: 'answer',
      },
      { fetchImpl: downFetch, readTranscript: () => CODEX_TRANSCRIPT },
    )
    expect(outcome).toEqual({ posted: false, reason: 'error' })
  })
})

describe('Codex subagent policy', () => {
  it('skips recall and capture when agent_id marks a subagent sidechain', async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, json: { text: 'memory' } })
    const subagent = {
      agent_id: 'agent-1',
      agent_type: 'explore',
      turn_id: 'turn-5',
      prompt: 'internal delegated prompt',
      transcript_path: '/tmp/subagent.jsonl',
      last_assistant_message: 'internal answer',
    }

    await expect(runUserPromptSubmit(subagent, { fetchImpl })).resolves.toBeNull()
    await expect(
      runStop(subagent, { fetchImpl, readTranscript: () => CODEX_TRANSCRIPT }),
    ).resolves.toEqual({ posted: false, reason: 'subagent' })
    expect(calls).toHaveLength(0)
  })
})
