// Local extraction LLM adapter using QMD's in-process generator.
import type { QMDStore } from '@tobilu/qmd'

import type { LLMMessage, OpenAIResponse } from './extract.js'

type Result<T> = import('../proxy/types.js').Result<T>

interface GenerateResult {
  text: string
  model: string
  done: boolean
}

interface LocalLLM {
  generate?: (
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ) => Promise<GenerateResult | null>
}

/**
 * Call QMD's local generation model and adapt the result to OpenAI response shape.
 */
export async function callLocalLLM(
  store: QMDStore,
  messages: LLMMessage[],
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<Result<OpenAIResponse>> {
  const llm = (store.internal as { llm?: LocalLLM } | undefined)?.llm
  if (llm?.generate === undefined) {
    return { ok: false, error: new Error('callLocalLLM: QMD internal LLM unavailable') }
  }

  // TODO(v0.2.5-tune): Local 1.7B model may need a different role-label prompt format.
  const prompt = formatMessagesForLocalLLM(messages)
  const generateOptions = {
    // TODO(v0.2.5-tune): 1024 max tokens may need to grow for longer profile syntheses.
    maxTokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0,
  }

  try {
    const result = await llm.generate(prompt, generateOptions)
    if (result === null) {
      return { ok: false, error: new Error('callLocalLLM: local LLM returned null') }
    }

    return {
      ok: true,
      value: {
        choices: [{ message: { content: result.text } }],
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

function formatMessagesForLocalLLM(messages: LLMMessage[]): string {
  const lines = messages.map((message) => `${roleLabel(message.role)}: ${message.content}`)
  lines.push('Assistant:')
  return lines.join('\n')
}

function roleLabel(role: LLMMessage['role']): string {
  if (role === 'system') return 'System'
  if (role === 'user') return 'User'
  return 'Assistant'
}
