// Capture type definitions
import type { NormalizedMessage } from '../proxy/types.js'

export interface CapturedConversation {
  /** Unique conversation ID */
  id: string
  /** Which tool this came from */
  tool: string
  /** API provider used */
  provider: string
  /** Model used */
  model: string
  /** The conversation messages */
  messages: NormalizedMessage[]
  /** When the conversation happened */
  timestamp: Date
  /** Estimated token count */
  tokenEstimate: number
  /** Whether incognito was active */
  incognito: boolean
}
