// Dhakira — OpenAI Codex hook adapter.
//
// Codex uses the same stdin/stdout hook mechanics and output schema as Claude Code,
// so request shaping and fail-open behavior come from shared-adapter. The only runtime
// divergence here is Codex's rollout JSONL shape.

import { createHookAdapter, type LastTurn, stripInjected } from './shared-adapter.js'

export type {
  AdapterOptions,
  HookMessage,
  LastTurn,
  StopOutcome,
  UserPromptSubmitOutput,
} from './shared-adapter.js'

function textFromContent(content: unknown, blockTypes: ReadonlySet<string>): string {
  if (typeof content === 'string') return stripInjected(content)
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const value = block as Record<string, unknown>
    if (
      typeof value.type === 'string' &&
      blockTypes.has(value.type) &&
      typeof value.text === 'string'
    ) {
      parts.push(value.text)
    }
  }
  return stripInjected(parts.join('\n'))
}

const USER_BLOCK_TYPES = new Set(['input_text', 'text'])
const ASSISTANT_BLOCK_TYPES = new Set(['output_text', 'text'])

function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

interface CodexTranscriptEntry {
  kind: 'explicit-user' | 'user' | 'assistant'
  text: string
}

function entryFromRecord(record: Record<string, unknown>): CodexTranscriptEntry | null {
  if (typeof record.payload !== 'object' || record.payload === null) return null
  const payload = record.payload as Record<string, unknown>

  if (record.type === 'event_msg' && payload.type === 'user_message') {
    const text = textFromContent(payload.message, USER_BLOCK_TYPES)
    return text.length > 0 ? { kind: 'explicit-user', text } : null
  }

  if (record.type !== 'response_item' || payload.type !== 'message') return null
  if (payload.role === 'user') {
    const text = textFromContent(payload.content, USER_BLOCK_TYPES)
    return text.length > 0 ? { kind: 'user', text } : null
  }
  if (payload.role === 'assistant') {
    const text = textFromContent(payload.content, ASSISTANT_BLOCK_TYPES)
    return text.length > 0 ? { kind: 'assistant', text } : null
  }
  return null
}

/**
 * Extract the just-finished Codex turn.
 *
 * Verified against the installed Codex 0.137.0 rollout format on 2026-07-11:
 * - explicit prompts: { type:"event_msg", payload:{ type:"user_message", message } }
 * - wire messages:    { type:"response_item", payload:{ type:"message", role, content } }
 *
 * Codex documents transcript_path as convenient but unstable. Prefer the explicit
 * user_message record, fall back to the wire user message, and use the Stop payload's
 * last_assistant_message before attempting assistant transcript parsing.
 */
export function extractLastTurn(raw: string, lastAssistantMessage = ''): LastTurn | null {
  let explicitUser = ''
  let fallbackUser = ''
  let fallbackAssistant = ''

  for (const line of raw.split('\n')) {
    const record = parseRecord(line)
    if (record === null) continue
    const entry = entryFromRecord(record)
    if (entry?.kind === 'explicit-user') explicitUser = entry.text
    else if (entry?.kind === 'user') fallbackUser = entry.text
    else if (entry?.kind === 'assistant') fallbackAssistant = entry.text
  }

  const user = explicitUser || fallbackUser
  const assistant = stripInjected(lastAssistantMessage) || fallbackAssistant
  if (user.length === 0 || assistant.length === 0) return null
  return { user, assistant }
}

const adapter = createHookAdapter({
  tool: 'codex',
  extractLastTurn,
  includeTurnId: true,
  includeModel: true,
  // Codex marks subagent hook payloads explicitly. Skip sidechains to avoid duplicate
  // capture and injecting main-session memory into internal delegated prompts.
  skipSubagents: true,
})

export const runUserPromptSubmit = adapter.runUserPromptSubmit
export const runStop = adapter.runStop
export const handleEvent = adapter.handleEvent
