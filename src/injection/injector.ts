// Prepend injection block to system prompt

import type { InjectionBlock } from './types.js'

export function injectIntoSystemPrompt(
  originalPrompt: string | null,
  injectionBlock: InjectionBlock,
): string {
  if (!injectionBlock.text) {
    return originalPrompt ?? ''
  }

  if (!originalPrompt) {
    return injectionBlock.text
  }

  return `${injectionBlock.text}\n\n${originalPrompt}`
}
