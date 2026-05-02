import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ingestAnthropicTrace } from '../../src/capture/ingest.ts'

interface CorpusRecord {
  id: string
  reqBody: unknown
  respBodyText: string
  respSseEvents: unknown[] | null
}

const V2_CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v2.jsonl')

async function loadV2Corpus(): Promise<CorpusRecord[]> {
  const raw = await readFile(V2_CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
}

describe('ingestAnthropicTrace', () => {
  it('coalesces real SSE events into structured assistant content blocks', async () => {
    const record = (await loadV2Corpus()).find(
      (item) => item.id === 'cad36056-1ada-4c78-bc1d-f72e896c18e9',
    )
    if (record === undefined) throw new Error('Expected tool-use v2 corpus record')

    const result = ingestAnthropicTrace({
      requestBody: record.reqBody,
      responseBody: record.respBodyText,
      responseSseEvents: record.respSseEvents,
      sourceTool: 'claude-code',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const assistant = result.value.messages.at(-1)
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'Reading `sample.js` now.' },
        {
          type: 'tool_use',
          id: expect.any(String),
          name: 'Read',
          input: { file_path: '/home/tester/corpus-test/sample.js' },
        },
      ]),
    )
  })
})
