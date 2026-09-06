// v0.3.1 G4.1 — reasoning over code: the STORED turn keeps the why, not the file.
// Deterministic, model-free; asserted against inline fixtures AND the proxy corpus.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CODE_BLOCK_MAX_LINES,
  collapseCodeBlocks,
  collapsedBlockMarker,
  collapseForStorage,
  collapseRepeatedLines,
  REPEAT_RUN_MIN,
} from '../../src/capture/code-collapse.ts'
import { extractTurnPairs } from '../../src/capture/turns.ts'

function fence(lang: string, lines: number, char = '```'): string {
  const body = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')
  return `${char}${lang}\n${body}\n${char}`
}

describe('collapseCodeBlocks', () => {
  it('replaces a fenced block longer than the limit with a one-line marker', () => {
    const text = `Here is the module:\n${fence('ts', 25)}\nThat fixes the retry bug.`
    expect(collapseCodeBlocks(text)).toBe(
      `Here is the module:\n${collapsedBlockMarker('ts', 25)}\nThat fixes the retry bug.`,
    )
  })

  it('keeps short blocks (≤ N lines) verbatim — a 3-line example is often the convention itself', () => {
    const short = `Use this shape:\n${fence('ts', 3)}\nNever default exports.`
    expect(collapseCodeBlocks(short)).toBe(short)
    const atLimit = fence('py', CODE_BLOCK_MAX_LINES)
    expect(collapseCodeBlocks(atLimit)).toBe(atLimit)
    expect(collapseCodeBlocks(fence('py', CODE_BLOCK_MAX_LINES + 1))).toBe(
      collapsedBlockMarker('py', CODE_BLOCK_MAX_LINES + 1),
    )
  })

  it('labels an un-languaged fence as "code" and lower-cases language tags', () => {
    expect(collapseCodeBlocks(fence('', 12))).toBe('[code block: code, 12 lines]')
    expect(collapseCodeBlocks(fence('TypeScript', 12))).toBe('[code block: typescript, 12 lines]')
  })

  it('handles ~~~ fences, longer fences, and info strings with extra tokens', () => {
    expect(collapseCodeBlocks(fence('sh', 15, '~~~'))).toBe('[code block: sh, 15 lines]')
    expect(collapseCodeBlocks(fence('json', 15, '````'))).toBe('[code block: json, 15 lines]')
    const info = `\`\`\`ts title="a.ts" {1,3}\n${'x\n'.repeat(14)}\`\`\``
    expect(collapseCodeBlocks(info)).toBe('[code block: ts, 14 lines]')
  })

  it('does not close a ``` fence with a shorter or different-character fence line', () => {
    // Inner ``` cannot close an outer ```` fence; ~~~ cannot close ``` either.
    const nested = [
      '````md',
      'text',
      '```js',
      'inner',
      '```',
      'more',
      ...Array(8).fill('x'),
      '````',
    ].join('\n')
    expect(collapseCodeBlocks(nested)).toBe('[code block: md, 13 lines]')
  })

  it('treats an unterminated fence as running to the end of the text', () => {
    const text = `Explanation first.\n\`\`\`go\n${'fmt.Println()\n'.repeat(20)}`
    const out = collapseCodeBlocks(text)
    expect(out.startsWith('Explanation first.\n[code block: go, ')).toBe(true)
    expect(out).not.toContain('fmt.Println()')
  })

  it('collapses several blocks independently and preserves surrounding prose byte-for-byte', () => {
    const prose1 = 'We tried JWT refresh tokens first — broke on mobile.'
    const prose2 = 'So the decision was server sessions.'
    const text = `${prose1}\n${fence('ts', 30)}\n${prose2}\n${fence('sql', 4)}\nDone.`
    expect(collapseCodeBlocks(text)).toBe(
      `${prose1}\n${collapsedBlockMarker('ts', 30)}\n${prose2}\n${fence('sql', 4)}\nDone.`,
    )
  })

  it('returns text without fences unchanged (fast path)', () => {
    const plain = 'No code here, just reasoning about why we chose PostgreSQL.'
    expect(collapseCodeBlocks(plain)).toBe(plain)
  })
})

describe('collapseRepeatedLines', () => {
  it('collapses a run of identical lines (≥ REPEAT_RUN_MIN) to the first + a marker', () => {
    const run = Array(7).fill('warn: retrying connection').join('\n')
    expect(collapseRepeatedLines(`start\n${run}\nend`)).toBe(
      'start\nwarn: retrying connection\n[… repeated 6 more times]\nend',
    )
  })

  it('leaves short runs and blank lines alone', () => {
    const two = 'a\na\nb'
    expect(collapseRepeatedLines(two)).toBe(two)
    const blanks = 'a\n\n\n\n\nb'
    expect(collapseRepeatedLines(blanks)).toBe(blanks)
    expect(REPEAT_RUN_MIN).toBe(3)
  })

  it('is exact-match only (a differing character breaks the run)', () => {
    const text = 'x\nx\nx \nx'
    expect(collapseRepeatedLines(text)).toBe(text)
  })
})

describe('collapseForStorage → extractTurnPairs (the wired path)', () => {
  it('stores the marker, not the code, on BOTH sides of the pair', () => {
    const userPaste = `Why does this leak connections?\n${fence('ts', 40)}`
    const assistantReply = `Because the pool is created per request. Move it to module scope:\n${fence(
      'ts',
      12,
    )}\nThe 3-line rule: one pool, one process.\n${fence('ts', 3)}`
    const [pair] = extractTurnPairs(
      [
        { role: 'user', content: userPaste },
        { role: 'assistant', content: assistantReply },
      ],
      'claude-code',
      'sess',
      new Date('2026-09-01T00:00:00Z'),
    )
    expect(pair?.userContent).toBe(`Why does this leak connections?\n[code block: ts, 40 lines]`)
    expect(pair?.assistantContent).toContain('Because the pool is created per request.')
    expect(pair?.assistantContent).toContain('[code block: ts, 12 lines]')
    // The short convention snippet survives.
    expect(pair?.assistantContent).toContain(fence('ts', 3))
    expect(pair?.assistantContent).not.toContain('line 12')
  })

  it('redaction runs BEFORE collapse, so a kept short snippet never carries a secret', () => {
    const [pair] = extractTurnPairs(
      [
        { role: 'user', content: 'Config?' },
        {
          role: 'assistant',
          content: '```env\nOPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa\nDEBUG=false\n```',
        },
      ],
      'claude-code',
      'sess',
      new Date(),
    )
    expect(pair?.assistantContent).toContain('[REDACTED]')
    expect(pair?.assistantContent).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('corpus regression: every kept v2 corpus pair is free of code blocks longer than the limit', async () => {
    const raw = await readFile(
      join(process.cwd(), 'test/corpus/claude-code-baseline-v2.jsonl'),
      'utf8',
    )
    const { ingestAnthropicTrace } = await import('../../src/capture/ingest.ts')
    const { classifyConversation } = await import('../../src/capture/classifier.ts')
    const { sanitizeTrace } = await import('../../src/capture/sanitizer.ts')
    let pairsChecked = 0
    for (const line of raw.trim().split('\n')) {
      const record = JSON.parse(line) as {
        id: string
        url: string
        startedAt: string
        reqBody: unknown
        respBodyText: string
        respSseEvents: unknown
      }
      if (!record.url.includes('/v1/messages')) continue
      const trace = ingestAnthropicTrace({
        requestBody: record.reqBody,
        responseBody: record.respBodyText,
        responseSseEvents: record.respSseEvents as never,
        sourceTool: 'claude-code',
      })
      if (!trace.ok || !classifyConversation(trace.value).keep) continue
      const pairs = extractTurnPairs(
        sanitizeTrace(trace.value).trace.messages,
        'claude-code',
        record.id,
        new Date(record.startedAt),
      )
      for (const pair of pairs) {
        pairsChecked++
        for (const side of [pair.userContent, pair.assistantContent]) {
          // Idempotent: collapsing an already-collapsed side changes nothing.
          expect(collapseForStorage(side)).toBe(side)
        }
      }
    }
    expect(pairsChecked).toBeGreaterThan(0)
  })
})
