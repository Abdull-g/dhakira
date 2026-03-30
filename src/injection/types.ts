// Injection type definitions

import type { WalletConfig } from '../config/schema.js'
import type { NormalizedMessage } from '../proxy/types.js'

export interface InjectionBlock {
  /** The full text to prepend to system prompt */
  text: string
  /** Token count of the injection block */
  tokenCount: number
  /** Number of memories included */
  memoryCount: number
  /** Whether profile was included */
  hasProfile: boolean
}

export interface InjectionContext {
  /** Current conversation messages (for building search query) */
  messages: NormalizedMessage[]
  /** Current system prompt (to calculate budget) */
  currentSystemPrompt: string | null
  /** Config for injection limits */
  config: WalletConfig['injection']
}
