import type { LLMMessage, OpenAIResponse } from './extract.js'

type Result<T> = import('../proxy/types.js').Result<T>

export interface ExtractorOptions {
  maxTokens?: number
  temperature?: number
}

export interface Extractor {
  /**
   * Run extraction on the given chat messages and return the model's response
   * in OpenAI response shape (so the rest of the pipeline doesn't need to change).
   */
  extract(messages: LLMMessage[], options?: ExtractorOptions): Promise<Result<OpenAIResponse>>

  /**
   * Optional disposal hook for cleanup of long-lived resources (model handles,
   * inactivity timers). Safe to call multiple times.
   */
  dispose?: () => Promise<void>
}
