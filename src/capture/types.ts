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
  /**
   * T07 context axis (T08): the projectId resolved for this capture, threaded so
   * extraction can scope each derived memory. Defaults to 'global' on the paths
   * that cannot resolve a scope. Persisted to frontmatter only when non-global
   * (byte-compat with pre-T08 conversations).
   */
  projectId: string
}
