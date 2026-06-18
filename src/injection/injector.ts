// Prepend injection block to system prompt

import type { InjectionBlock } from './types.js'

export function injectIntoSystemPrompt(
  originalPrompt: string | null,
  // Only `.text` is read, so accept anything that carries it (a full
  // InjectionBlock from the builder, or a bare { text } from recallOnce).
  injectionBlock: Pick<InjectionBlock, 'text'>,
): string {
  if (!injectionBlock.text) {
    return originalPrompt ?? ''
  }

  if (!originalPrompt) {
    return injectionBlock.text
  }

  return `${injectionBlock.text}\n\n${originalPrompt}`
}
