import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAnthropicRequest } from '../../src/proxy/anthropic.ts'
import type { NormalizedMessage } from '../../src/proxy/types.ts'

interface CorpusRecord {
  id: string
  startedAt: string
  method: string
  url: string
  reqHeaders: Record<string, string>
  reqBody: unknown
  respStatus: number
  respBodyRaw: string
  respKind: 'json' | 'sse'
}

interface BaselineRecordOutput {
  id: string
  url: string
  status: number
  pairCount: number
  pairs: Array<{
    userContent: string
    assistantContent: string
  }>
}

const CORPUS_PATH = join(process.cwd(), 'test/corpus/claude-code-baseline-v1.jsonl')

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

function parseAssistantResponse(record: CorpusRecord): string | null {
  if (record.respKind === 'sse') {
    return parseAnthropicSseText(record.respBodyRaw)
  }

  try {
    const parsed: unknown = JSON.parse(record.respBodyRaw)
    if (!isRecord(parsed) || !Array.isArray(parsed.content)) return null
    const parts = parsed.content.flatMap((block) => {
      if (!isRecord(block)) return []
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    })
    return parts.length > 0 ? parts.join('\n') : null
  } catch {
    return null
  }
}

function extractV1BaselinePairs(messages: NormalizedMessage[]): BaselineRecordOutput['pairs'] {
  const conversationMessages = messages.filter((message) => message.role !== 'system')
  const pairs: BaselineRecordOutput['pairs'] = []
  let i = 0

  while (i < conversationMessages.length) {
    const message = conversationMessages[i]
    const next = conversationMessages[i + 1]
    if (message?.role === 'user' && next?.role === 'assistant') {
      pairs.push({ userContent: message.content, assistantContent: next.content })
      i += 2
      continue
    }
    i++
  }

  return pairs
}

function parseAnthropicSseText(raw: string): string | null {
  const parts: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') break

    try {
      const chunk: unknown = JSON.parse(payload)
      if (!isRecord(chunk)) continue
      const delta = chunk.delta
      if (isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
        parts.push(delta.text)
      }
    } catch {}
  }

  const text = parts.join('')
  return text.length > 0 ? text : null
}

function replayCurrentPipeline(record: CorpusRecord): BaselineRecordOutput {
  const parsed = parseAnthropicRequest(record.reqBody, record.reqHeaders, 'claude-code')
  if (!parsed.ok) {
    return {
      id: record.id,
      url: record.url,
      status: record.respStatus,
      pairCount: 0,
      pairs: [],
    }
  }

  const messages: NormalizedMessage[] =
    parsed.value.systemPrompt !== null
      ? [{ role: 'system', content: parsed.value.systemPrompt }, ...parsed.value.messages]
      : parsed.value.messages

  const assistantContent = parseAssistantResponse(record)
  const messagesWithResponse: NormalizedMessage[] =
    assistantContent !== null
      ? [...messages, { role: 'assistant', content: assistantContent }]
      : messages

  const pairs = extractV1BaselinePairs(messagesWithResponse)

  return {
    id: record.id,
    url: record.url,
    status: record.respStatus,
    pairCount: pairs.length,
    pairs,
  }
}

describe('baseline corpus replay (current v1 pipeline)', () => {
  it('snapshots the current pipeline output for every corpus record', async () => {
    const records = await loadCorpus()
    expect(records).toHaveLength(40)

    const output = records.map(replayCurrentPipeline)

    expect(output).toMatchSnapshot()
  })
})
