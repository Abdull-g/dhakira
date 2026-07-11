import { describe, expect, it } from 'vitest'

import { dispatchHookEvent } from '../../src/hooks/hook-dispatch.ts'

function toolRecordingFetch(tools: string[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    tools.push(String(body.tool))
    return { ok: true, json: async () => ({ text: 'memory' }) } as Response
  }) as typeof fetch
}

describe('shared hook entrypoint dispatch', () => {
  it('keeps Claude payloads on the Claude adapter', async () => {
    const tools: string[] = []
    await dispatchHookEvent(
      'UserPromptSubmit',
      { prompt: 'question', cwd: '/work/repo' },
      { fetchImpl: toolRecordingFetch(tools) },
    )
    expect(tools).toEqual(['claude-code'])
  })

  it('routes required Codex turn_id payloads to the Codex adapter', async () => {
    const tools: string[] = []
    await dispatchHookEvent(
      'UserPromptSubmit',
      { prompt: 'question', cwd: '/work/repo', turn_id: 'turn-1' },
      { fetchImpl: toolRecordingFetch(tools) },
    )
    expect(tools).toEqual(['codex'])
  })
})
