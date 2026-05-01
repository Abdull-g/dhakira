import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConversationTrace } from '../../src/capture/ingest.ts'
import { ingestAnthropicTrace } from '../../src/capture/ingest.ts'
import { parseSanitizeRulesYaml, sanitizeTrace } from '../../src/capture/sanitizer.ts'

interface CorpusRecord {
  id: string
  reqBody: unknown
  respBodyRaw: string
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v1.jsonl')
const RULES_PATH = join(process.cwd(), 'src/capture/sanitize-rules.yaml')

async function loadCorpus(): Promise<CorpusRecord[]> {
  const raw = await readFile(CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
}

async function loadRules(): Promise<ReturnType<typeof parseSanitizeRulesYaml>> {
  return parseSanitizeRulesYaml(await readFile(RULES_PATH, 'utf8'))
}

function hasSystemReminder(record: CorpusRecord): boolean {
  return JSON.stringify(record.reqBody).includes('<system-reminder>')
}

function ingestRecord(record: CorpusRecord): ConversationTrace {
  const trace = ingestAnthropicTrace({
    requestBody: record.reqBody,
    responseBody: Buffer.from(record.respBodyRaw, 'utf8'),
    sourceTool: 'claude-code',
  })
  if (!trace.ok) throw trace.error
  return trace.value
}

function userText(trace: ConversationTrace): string {
  return trace.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

function assistantText(trace: ConversationTrace): string {
  return trace.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

describe('sanitizeTrace', () => {
  it('removes system-reminder blocks from at least 3 corpus user messages', async () => {
    const rules = await loadRules()
    const records = (await loadCorpus()).filter(hasSystemReminder).slice(0, 3)
    expect(records).toHaveLength(3)

    for (const record of records) {
      const before = ingestRecord(record)
      const after = sanitizeTrace(before, rules)

      expect(userText(before)).toContain('<system-reminder>')
      expect(userText(after.trace)).not.toContain('<system-reminder>')
      expect(userText(after.trace)).not.toContain('</system-reminder>')
      expect(after.hits[0]?.ruleId).toBe('claude-code-system-reminder')
    }
  })

  it('preserves the original raw request for audit', async () => {
    const rules = await loadRules()
    const record = (await loadCorpus()).find(hasSystemReminder)
    if (record === undefined) throw new Error('Expected a system-reminder corpus record')

    const before = ingestRecord(record)
    const after = sanitizeTrace(before, rules)

    expect(after.trace.rawRequest).toBe(before.rawRequest)
    expect(JSON.stringify(after.trace.rawRequest)).toContain('<system-reminder>')
  })

  it('does not modify assistant content', async () => {
    const rules = await loadRules()
    const trace = ingestRecord({
      id: 'assistant-marker',
      reqBody: {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Please answer plainly.' }],
      },
      respBodyRaw: JSON.stringify({
        content: [
          {
            type: 'text',
            text: 'Assistant keeps <system-reminder>literal text</system-reminder> untouched.',
          },
        ],
      }),
    })

    const after = sanitizeTrace(trace, rules)

    expect(assistantText(after.trace)).toBe(assistantText(trace))
    expect(assistantText(after.trace)).toContain('<system-reminder>')
  })

  it('leaves an empty string when a user message is only a system-reminder block', async () => {
    const rules = await loadRules()
    const trace = ingestRecord({
      id: 'empty-after-sanitize',
      reqBody: {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: '<system-reminder>\nHarness-only reminder.\n</system-reminder>',
          },
        ],
      },
      respBodyRaw: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
    })

    const after = sanitizeTrace(trace, rules)

    expect(userText(after.trace)).toBe('')
    expect(after.trace.sanitizerRemovedAll).toBe(true)
  })

  it('loads only the corpus-backed system-reminder rule', async () => {
    const rules = await loadRules()

    expect(rules.rules).toEqual([
      {
        id: 'claude-code-system-reminder',
        scope: 'user',
        action: 'remove',
        pattern: '<system-reminder>[\\s\\S]*?</system-reminder>',
      },
    ])
  })
})
