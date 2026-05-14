import { describe, expect, it } from 'vitest'

import { fillTemplate, EXTRACT_PROMPT } from '../../src/extraction/prompts.ts'
import { LocalLLMExtractor } from '../../src/extraction/local-extractor.ts'

const runE2E = process.env.DHAKIRA_E2E_MODELS === '1'
const describeLocalE2E = runE2E ? describe : describe.skip

describeLocalE2E('LocalLLMExtractor E2E', () => {
  it(
    'loads LFM2.5 and returns parseable extraction JSON',
    async () => {
      const extractor = new LocalLLMExtractor()
      const prompt = fillTemplate(EXTRACT_PROMPT, {
        conversation: `## User
I am a backend engineer at Acme Corp and I prefer PostgreSQL for databases.

## Assistant
Got it.`,
        existing_profile: '(none)',
        rolling_summary: '(none)',
        conversation_date: '2026-05-14',
      })

      try {
        const result = await extractor.extract([{ role: 'user', content: prompt }])

        expect(result.ok).toBe(true)
        if (!result.ok) return
        const content = result.value.choices?.[0]?.message?.content
        expect(content).toBeTruthy()

        const parsed = JSON.parse(stripCodeFences(content ?? '')) as {
          facts?: unknown[]
          summary_update?: unknown
        }
        expect(Array.isArray(parsed.facts)).toBe(true)
        expect(typeof parsed.summary_update).toBe('string')
      } finally {
        await extractor.dispose()
      }
    },
    120_000,
  )
})

describe.skipIf(runE2E)('LocalLLMExtractor E2E disabled', () => {
  it('skips model-loading smoke test unless DHAKIRA_E2E_MODELS=1 is set', () => {
    expect(process.env.DHAKIRA_E2E_MODELS).not.toBe('1')
  })
})

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m)
  return match ? match[1].trim() : trimmed
}
