import { describe, expect, it } from 'vitest'

import type { WalletConfig } from '../../src/config/schema.ts'
import { ExternalLLMExtractor } from '../../src/extraction/external-extractor.ts'
import type { Extractor } from '../../src/extraction/extractor.ts'
import { LocalLLMExtractor } from '../../src/extraction/local-extractor.ts'

const BASE_CONFIG: WalletConfig['extraction'] = {
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
}

describe('Extractor interface', () => {
  it('LocalLLMExtractor satisfies the Extractor contract', () => {
    const extractor: Extractor = new LocalLLMExtractor({ inactivityTimeoutMs: 0 })

    expect(extractor.extract).toEqual(expect.any(Function))
    expect(extractor.dispose).toEqual(expect.any(Function))
  })

  it('ExternalLLMExtractor satisfies the Extractor contract', () => {
    const extractor: Extractor = new ExternalLLMExtractor(BASE_CONFIG)

    expect(extractor.extract).toEqual(expect.any(Function))
  })
})
