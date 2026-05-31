// ModelHandle adapter over the existing LocalLLMExtractor.
//
// This is a THIN delegate: all node-llama-cpp + grammar code lives inside
// LocalLLMExtractor.generate(). This file imports no node-llama-cpp itself,
// so the harness layer stays backend-agnostic. The local model CAN enforce
// grammar/json-schema constraints, hence supportsConstraint() === true.

import type { LocalLLMExtractor } from '../extraction/local-extractor.js'
import type { ModelHandle } from './model-handle.js'

export class LlamaHandle implements ModelHandle {
  constructor(private readonly extractor: LocalLLMExtractor) {}

  generate(
    prompt: string,
    opts: {
      jsonSchema?: Readonly<Record<string, unknown>>
      maxTokens?: number
      temperature?: number
    },
  ): Promise<{ text: string; constrained: boolean }> {
    return this.extractor.generate(prompt, opts)
  }

  supportsConstraint(): boolean {
    return true
  }
}
