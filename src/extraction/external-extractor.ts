import { callLLM } from './extract.js'
import type { LLMMessage, OpenAIResponse } from './extract.js'
import type { Extractor, ExtractorOptions } from './extractor.js'

type Result<T> = import('../proxy/types.js').Result<T>

interface ExternalLLMExtractorConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export class ExternalLLMExtractor implements Extractor {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string

  constructor(config: ExternalLLMExtractorConfig) {
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
    this.model = config.model
  }

  extract(messages: LLMMessage[], _options?: ExtractorOptions): Promise<Result<OpenAIResponse>> {
    return callLLM(this.baseUrl, this.apiKey, this.model, messages)
  }
}
