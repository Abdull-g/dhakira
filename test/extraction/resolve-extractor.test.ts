import { describe, expect, it } from 'vitest'

import type { WalletConfig } from '../../src/config/schema.ts'
import { ExternalLLMExtractor } from '../../src/extraction/external-extractor.ts'
import { LocalLLMExtractor } from '../../src/extraction/local-extractor.ts'
import { resolveExtractor } from '../../src/extraction/extract.ts'

const BASE_CONFIG: WalletConfig['extraction'] = {
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

describe('resolveExtractor', () => {
  it('returns an external extractor when apiKey is non-empty', () => {
    const extractor = resolveExtractor(BASE_CONFIG)

    expect(extractor).toBeInstanceOf(ExternalLLMExtractor)
  })

  it('returns a local singleton when apiKey is empty', () => {
    const first = resolveExtractor({ ...BASE_CONFIG, apiKey: '' })
    const second = resolveExtractor({ ...BASE_CONFIG, apiKey: '' })

    expect(first).toBeInstanceOf(LocalLLMExtractor)
    expect(second).toBe(first)
  })

  it('resolves env: apiKey syntax before choosing extractor', () => {
    delete process.env.DHAKIRA_TEST_EXTRACTION_KEY
    const local = resolveExtractor({ ...BASE_CONFIG, apiKey: 'env:DHAKIRA_TEST_EXTRACTION_KEY' })

    process.env.DHAKIRA_TEST_EXTRACTION_KEY = 'real-key'
    const external = resolveExtractor({ ...BASE_CONFIG, apiKey: 'env:DHAKIRA_TEST_EXTRACTION_KEY' })
    delete process.env.DHAKIRA_TEST_EXTRACTION_KEY

    expect(local).toBeInstanceOf(LocalLLMExtractor)
    expect(external).toBeInstanceOf(ExternalLLMExtractor)
  })
})
