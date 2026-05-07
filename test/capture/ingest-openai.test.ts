import { describe, expect, it } from 'vitest'
import { ingestOpenAITrace } from '../../src/capture/ingest.ts'

function sse(events: unknown[], includeDone = true): string {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}`)
  if (includeDone) lines.push('data: [DONE]')
  return `${lines.join('\n')}\n`
}

function ingest(requestBody: unknown, responseBody: string) {
  const result = ingestOpenAITrace({
    requestBody,
    responseBody,
    sourceTool: 'aider',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw result.error
  return result.value
}

describe('ingestOpenAITrace', () => {
  it('normalizes a non-streaming text response', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Say hello' }],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello there.' } }] }),
    )

    expect(trace.model).toBe('gpt-4.1')
    expect(trace.maxTokens).toBe(128)
    expect(trace.streamResponse).toBe(false)
    expect(trace.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello there.' }],
    })
  })

  it('coalesces streaming SSE content chunks', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        stream: true,
        messages: [{ role: 'user', content: 'Tell a tiny story' }],
      },
      sse([
        { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'Once' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' upon' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' a time.' }, finish_reason: null }] },
      ]),
    )

    expect(trace.streamResponse).toBe(true)
    expect(trace.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Once upon a time.' }],
    })
  })

  it('coalesces streaming tool_calls argument fragments across chunks', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        stream: true,
        messages: [{ role: 'user', content: 'Read the README' }],
      },
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'read_file', arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"README.md","limit":20}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ]),
    )

    expect(trace.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'read_file',
          input: { path: 'README.md', limit: 20 },
        },
      ],
    })
  })

  it('normalizes non-streaming tool_calls with parsed JSON arguments', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'List files' }],
      },
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'I will inspect the repo.',
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{"dir":"src"}' },
                },
              ],
            },
          },
        ],
      }),
    )

    expect(trace.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'I will inspect the repo.' },
      { type: 'tool_use', id: 'call_2', name: 'list_files', input: { dir: 'src' } },
    ])
  })

  it('normalizes role:tool messages into tool_result blocks', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: 'Run a tool' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_3',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_3', content: 'file contents' },
        ],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }),
    )

    expect(trace.messages).toEqual(
      expect.arrayContaining([
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_3', content: 'file contents' }] },
      ]),
    )
  })

  it('normalizes multimodal user content with image_url blocks', () => {
    const image = { url: 'https://example.test/image.png', detail: 'low' }
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              { type: 'image_url', image_url: image },
            ],
          },
        ],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It is a diagram.' } }] }),
    )

    expect(trace.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', source: image },
      ],
    })
  })

  it('extracts a single system prompt message', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'Hello' },
        ],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi.' } }] }),
    )

    expect(trace.systemPrompt).toBe('You are concise.')
    expect(trace.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'You are concise.' }],
    })
  })

  it('joins multiple system prompt messages with blank lines', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'First instruction.' },
          { role: 'system', content: [{ type: 'text', text: 'Second instruction.' }] },
          { role: 'user', content: 'Hello' },
        ],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi.' } }] }),
    )

    expect(trace.systemPrompt).toBe('First instruction.\n\nSecond instruction.')
  })

  it('handles empty content without crashing', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: '' },
          { role: 'assistant', content: null },
        ],
      },
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }),
    )

    expect(trace.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ])
  })

  it('falls back to raw strings for malformed tool argument JSON', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Call the tool' }],
      },
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'broken_tool', arguments: '{"unterminated":' },
                },
              ],
            },
          },
        ],
      }),
    )

    expect(trace.messages.at(-1)?.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_bad',
        name: 'broken_tool',
        input: '{"unterminated":',
      },
    ])
  })

  it('skips the streaming [DONE] terminator', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        stream: true,
        messages: [{ role: 'user', content: 'Say done' }],
      },
      sse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: null }] }]),
    )

    expect(trace.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('ignores final streaming chunks with empty delta', () => {
    const trace = ingest(
      {
        model: 'gpt-4.1',
        stream: true,
        messages: [{ role: 'user', content: 'Finish cleanly' }],
      },
      sse([
        { choices: [{ delta: { content: 'Final answer.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    )

    expect(trace.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Final answer.' }])
  })
})
