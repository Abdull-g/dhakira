import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyConversation } from '../../src/capture/classifier.ts'
import { ingestAnthropicTrace } from '../../src/capture/ingest.ts'
import { applyQualityGate } from '../../src/capture/quality-gate.ts'
import { sanitizeTrace } from '../../src/capture/sanitizer.ts'
import type { TurnPair } from '../../src/capture/turns.ts'
import { extractTurnPairs } from '../../src/capture/turns.ts'

interface CorpusRecord {
  id: string
  startedAt: string
  url: string
  reqBody: unknown
  respBodyText: string
  respSseEvents: unknown[] | null
}

interface ReplayOutput {
  counts: Record<string, number>
  pairs: Array<{
    id: string
    userContent: string
    assistantContent: string
    toolsUsed: string[]
  }>
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

function replayRecord(record: CorpusRecord): { category: string; pairs: TurnPair[] } {
  if (!record.url.includes('/v1/messages')) {
    return { category: 'pre_flight', pairs: [] }
  }

  const traceResult = ingestAnthropicTrace({
    requestBody: record.reqBody,
    responseBody: record.respBodyText,
    responseSseEvents: record.respSseEvents,
    sourceTool: 'claude-code',
  })
  if (!traceResult.ok) return { category: 'pre_flight', pairs: [] }

  const classification = classifyConversation(traceResult.value)
  if (!classification.keep) {
    return { category: classification.category, pairs: [] }
  }

  const sanitized = sanitizeTrace(traceResult.value).trace
  const extracted = extractTurnPairs(
    sanitized.messages,
    'claude-code',
    record.id,
    new Date(record.startedAt),
  )
  return { category: classification.category, pairs: applyQualityGate(extracted) }
}

function replayCorpus(records: CorpusRecord[]): ReplayOutput {
  const counts: Record<string, number> = {
    pre_flight: 0,
    title_generation: 0,
    tool_intermediate: 0,
    real_conversation: 0,
  }
  const pairs: TurnPair[] = []

  for (const record of records) {
    const result = replayRecord(record)
    counts[result.category] = (counts[result.category] ?? 0) + 1
    pairs.push(...result.pairs)
  }

  return {
    counts,
    pairs: pairs.map((pair) => ({
      id: pair.sessionId,
      userContent: pair.userContent,
      assistantContent: pair.assistantContent,
      toolsUsed: pair.metadata?.toolsUsed ?? [],
    })),
  }
}

describe('v2 corpus replay', () => {
  it('emits one clean pair per terminal user intent', async () => {
    const records = await loadV2Corpus()
    expect(records).toHaveLength(32)
    expect(records.filter((record) => record.url.includes('/v1/messages'))).toHaveLength(18)

    const output = replayCorpus(records)

    expect(output.counts.pre_flight).toBe(14)
    expect(output.counts.title_generation).toBe(7)
    expect(output.counts.tool_intermediate).toBe(4)
    expect(output.counts.real_conversation).toBe(7)
    expect(output.pairs).toHaveLength(7)

    expect(output.pairs.every((pair) => pair.userContent.trim().length > 0)).toBe(true)
    expect(output.pairs.every((pair) => pair.assistantContent.trim().length > 0)).toBe(true)
    expect(output.pairs.every((pair) => !pair.userContent.includes('<system-reminder>'))).toBe(true)
    expect(output.pairs.every((pair) => !pair.assistantContent.includes('{"title":'))).toBe(true)

    const toolPairs = output.pairs.filter((pair) => pair.toolsUsed.length > 0)
    expect(toolPairs).toHaveLength(3)
    expect(toolPairs.map((pair) => pair.toolsUsed)).toEqual([['Read'], ['Write', 'Bash'], ['Bash']])

    expect(output).toMatchSnapshot()
  })
})
