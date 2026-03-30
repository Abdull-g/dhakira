// Proxy type definitions

/** Normalized representation of a chat request (provider-agnostic) */
export interface NormalizedRequest {
  /** Generated request ID */
  id: string
  /** Which tool sent this (matched from config) */
  tool: string
  /** API format */
  provider: 'openai' | 'anthropic'
  /** Model requested */
  model: string
  /** Normalized messages (system messages extracted to systemPrompt) */
  messages: NormalizedMessage[]
  /** System prompt (extracted from messages or top-level field) */
  systemPrompt: string | null
  /** Whether client requested streaming */
  stream: boolean
  /** Original headers, normalized to lowercase keys */
  rawHeaders: Record<string, string>
  /** Original parsed body for rebuilding the forwarded request */
  rawBody: unknown
  /** When the request was received */
  timestamp: Date
}

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** What format was detected from the incoming request */
export type DetectedFormat = 'openai' | 'anthropic' | 'unknown'

/** Result type for operations that can fail without throwing */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }
