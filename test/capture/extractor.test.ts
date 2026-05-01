import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceMessage } from '../../src/capture/ingest.ts'
import { ingestAnthropicTrace } from '../../src/capture/ingest.ts'
import { sanitizeTrace } from '../../src/capture/sanitizer.ts'
import { extractTurnPairs } from '../../src/capture/turns.ts'

interface CorpusRecord {
  id: string
  reqBody: unknown
  respBodyRaw: string
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v1.jsonl')
const TOOL = 'claude-code'
const SESSION_ID = 'conv_state_machine'
const TIMESTAMP = new Date('2026-05-02T00:00:00.000Z')

function text(role: 'user' | 'assistant', value: string): TraceMessage {
  return { role, content: [{ type: 'text', text: value }] }
}

async function loadCorpus(): Promise<CorpusRecord[]> {
  const raw = await readFile(CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
}

function extract(messages: TraceMessage[]) {
  return extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
}

describe('state-machine extractor', () => {
  it('emits one pair for a trivial user text then assistant text exchange', () => {
    const pairs = extract([text('user', 'How do I run tests?'), text('assistant', 'Use npm test.')])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.userContent).toBe('How do I run tests?')
    expect(pairs[0]?.assistantContent).toBe('Use npm test.')
  })

  it('stitches a single tool-use flow into one clean pair', () => {
    const pairs = extract([
      text('user', 'Read the package file and summarize it.'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to inspect the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: '{"name":"dhakira"}' }],
      },
      text('assistant', 'The package is named dhakira.'),
    ])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.assistantContent).toBe('The package is named dhakira.')
    expect(pairs[0]?.assistantContent).not.toContain('{"name"')
    expect(pairs[0]?.metadata?.toolsUsed).toEqual(['Read'])
  })

  it('stitches multi-tool flows and keeps tool results out of searchable content', () => {
    const pairs = extract([
      text('user', 'Create a file and run the test command.'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create the file first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'created a.ts' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'toolu_2', content: 'PASS test suite' }],
      },
      text('assistant', 'The file is created and the tests pass.'),
    ])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.assistantContent).toBe(
      'I will create the file first.\nThe file is created and the tests pass.',
    )
    expect(pairs[0]?.assistantContent).not.toContain('PASS test suite')
    expect(pairs[0]?.metadata?.toolsUsed).toEqual(['Write', 'Bash'])
  })

  it('does not emit empty pairs for assistant tool_use without final assistant text', () => {
    const pairs = extract([
      text('user', 'Read package.json.'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'file content' }],
      },
    ])

    expect(pairs).toHaveLength(0)
  })

  it('never emits empty pairs when replaying corpus message sequences', async () => {
    const records = await loadCorpus()

    for (const record of records) {
      const trace = ingestAnthropicTrace({
        requestBody: record.reqBody,
        responseBody: Buffer.from(record.respBodyRaw, 'utf8'),
        sourceTool: TOOL,
      })
      if (!trace.ok) continue

      const sanitized = sanitizeTrace(trace.value).trace
      const pairs = extractTurnPairs(sanitized.messages, TOOL, record.id, TIMESTAMP)

      expect(pairs.every((pair) => pair.userContent.trim().length > 0)).toBe(true)
      expect(pairs.every((pair) => pair.assistantContent.trim().length > 0)).toBe(true)
      expect(pairs.every((pair) => !pair.userContent.includes('<system-reminder>'))).toBe(true)
    }
  })
})
