import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyConversation, parseClassifierRulesYaml } from '../../src/capture/classifier.ts'
import { ingestAnthropicTrace } from '../../src/capture/ingest.ts'

interface CorpusRecord {
  id: string
  url: string
  reqBody: unknown
  respBodyRaw: string
  respBodyText?: string
  respSseEvents?: unknown[] | null
  respStatus: number
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v1.jsonl')
const V2_CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v2.jsonl')
const RULES_PATH = join(process.cwd(), 'src/capture/classifier-rules.yaml')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadCorpus(): Promise<CorpusRecord[]> {
  const raw = await readFile(CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
}

async function loadV2Corpus(): Promise<CorpusRecord[]> {
  const raw = await readFile(V2_CORPUS_PATH, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord)
}

function systemPrompt(body: unknown): string {
  if (!isRecord(body)) return ''
  if (typeof body.system === 'string') return body.system
  if (Array.isArray(body.system)) {
    return body.system
      .flatMap((block) => {
        if (!isRecord(block)) return []
        return typeof block.text === 'string' ? [block.text] : []
      })
      .join('\n')
  }
  return ''
}

function hasMessages(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.messages)
}

function isTitleFixture(record: CorpusRecord): boolean {
  const prompt = systemPrompt(record.reqBody)
  const model =
    isRecord(record.reqBody) && typeof record.reqBody.model === 'string' ? record.reqBody.model : ''
  return (
    prompt.includes('Generate a concise') && prompt.includes('title') && model.includes('haiku')
  )
}

function isRealConversationFixture(record: CorpusRecord): boolean {
  return (
    record.respStatus === 200 &&
    record.url.includes('/v1/messages') &&
    hasMessages(record.reqBody) &&
    !isTitleFixture(record)
  )
}

async function classifyRecord(
  record: CorpusRecord,
): Promise<ReturnType<typeof classifyConversation>> {
  const rules = parseClassifierRulesYaml(await readFile(RULES_PATH, 'utf8'))
  const trace = ingestAnthropicTrace({
    requestBody: record.reqBody,
    responseBody:
      record.respBodyText !== undefined
        ? record.respBodyText
        : Buffer.from(record.respBodyRaw, 'utf8'),
    responseSseEvents: record.respSseEvents,
    sourceTool: 'claude-code',
  })
  if (!trace.ok) throw trace.error
  return classifyConversation(trace.value, rules)
}

describe('classifyConversation', () => {
  it('classifies 8 corpus title-generation records as title_generation', async () => {
    const titleRecords = (await loadCorpus()).filter(isTitleFixture)
    expect(titleRecords).toHaveLength(8)

    const classifications = await Promise.all(titleRecords.map(classifyRecord))

    expect(classifications.every((item) => item.category === 'title_generation')).toBe(true)
    expect(classifications.every((item) => item.keep === false)).toBe(true)
  })

  it('does not classify 8 real corpus conversations as title_generation', async () => {
    const realRecords = (await loadCorpus()).filter(isRealConversationFixture).slice(0, 8)
    expect(realRecords).toHaveLength(8)

    const classifications = await Promise.all(realRecords.map(classifyRecord))

    expect(classifications.every((item) => item.category !== 'title_generation')).toBe(true)
    expect(classifications.every((item) => item.keep === true)).toBe(true)
  })

  it('has zero false positives across all real corpus conversations', async () => {
    const realRecords = (await loadCorpus()).filter(isRealConversationFixture)
    expect(realRecords).toHaveLength(12)

    const classifications = await Promise.all(realRecords.map(classifyRecord))

    expect(classifications.filter((item) => item.category === 'title_generation')).toHaveLength(0)
  })

  it('classifies every title-generation record in the corpus', async () => {
    const records = await loadCorpus()
    const classifications = await Promise.all(
      records.filter(hasMessagesRecord).map(async (record) => ({
        record,
        classification: await classifyRecord(record),
      })),
    )

    const classifiedTitleIds = classifications
      .filter((item) => item.classification.category === 'title_generation')
      .map((item) => item.record.id)
      .sort()
    const expectedTitleIds = records
      .filter(isTitleFixture)
      .map((record) => record.id)
      .sort()

    expect(classifiedTitleIds).toEqual(expectedTitleIds)
  })

  it('classifies v2 tool-use response calls as tool_intermediate', async () => {
    const records = (await loadV2Corpus()).filter(hasAssistantResponseToolUse)
    expect(records.map((record) => record.id).sort()).toEqual(
      [
        'bdad81ef-0375-4c8f-b729-566c7407960c',
        'ba034895-74c1-42e2-8abf-dcb7b0d2e4b8',
        'cad36056-1ada-4c78-bc1d-f72e896c18e9',
        'dbb0fff2-939b-4ea1-9cdb-00f71377a144',
      ].sort(),
    )

    const classifications = await Promise.all(records.map(classifyRecord))

    expect(classifications.every((item) => item.category === 'tool_intermediate')).toBe(true)
    expect(classifications.every((item) => item.keep === false)).toBe(true)
  })

  it('classifies Claude Code suggestion-mode prompts as tool_internal_autocomplete', async () => {
    const classification = await classifyRecord({
      id: 'suggestion-mode-fixture',
      url: 'https://api.anthropic.com/v1/messages',
      reqBody: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content:
              "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.] FIRST: Look at the user's recent messages and suggest a continuation.",
          },
        ],
      },
      respBodyRaw: JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'tell me about what dhakira is' }],
      }),
      respStatus: 200,
    })

    expect(classification).toMatchObject({
      category: 'tool_internal_autocomplete',
      keep: false,
      ruleId: 'claude-code-suggestion-mode',
    })
  })

  it('does not classify normal user messages as tool_internal_autocomplete', async () => {
    const classification = await classifyRecord({
      id: 'normal-user-fixture',
      url: 'https://api.anthropic.com/v1/messages',
      reqBody: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: 'Tell me about what Dhakira is and how memory capture works.',
          },
        ],
      },
      respBodyRaw: JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'Dhakira is a local-first memory wallet.' }],
      }),
      respStatus: 200,
    })

    expect(classification).toMatchObject({
      category: 'real_conversation',
      keep: true,
    })
  })
})

function hasMessagesRecord(record: CorpusRecord): boolean {
  return hasMessages(record.reqBody)
}

function hasAssistantResponseToolUse(record: CorpusRecord): boolean {
  return JSON.stringify(record.respSseEvents ?? []).includes('"type":"tool_use"')
}
