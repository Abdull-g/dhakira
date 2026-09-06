import { redactSecrets } from '../capture/secrets.js'
import { createLogger } from '../utils/logger.js'
import type { LLMMessage, OpenAIResponse } from './extract.js'
import { callLLM } from './extract.js'
import type { Extractor, ExtractorOptions } from './extractor.js'

type Result<T> = import('../proxy/types.js').Result<T>

interface ExternalLLMExtractorConfig {
  baseUrl: string
  apiKey: string
  model: string
}

const logger = createLogger('extraction:external')

/**
 * Extractor backed by an OpenAI/Anthropic-compatible HTTP API.
 *
 * PRIVACY BOUNDARY (v0.3.1, audit D4): this is the ONLY place where wallet
 * content leaves the machine, and it is opt-in (extraction.apiKey). The raw
 * archives in conversations/ are deliberately unredacted (the "mine" that future
 * re-synthesis depends on), so every message is passed through redactSecrets
 * here, immediately before the request. Nothing that matches a known secret
 * pattern is ever sent to a third party.
 */
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
    return callLLM(this.baseUrl, this.apiKey, this.model, redactMessages(messages))
  }
}

/** Redact every message body before it leaves the machine. Pure; never throws. */
export function redactMessages(messages: LLMMessage[]): LLMMessage[] {
  let redacted = 0
  const out = messages.map((message) => {
    const result = redactSecrets(message.content)
    redacted += result.redactedCount
    return result.redactedCount === 0 ? message : { ...message, content: result.cleaned }
  })
  if (redacted > 0) {
    logger.warn('Redacted secrets before external extraction call', { redacted })
  }
  return out
}
