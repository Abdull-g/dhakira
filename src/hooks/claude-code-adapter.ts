// Dhakira — Claude Code hook adapter (first adapter of "one daemon, two verbs").
//
// This is a THIN, dependency-free client over the daemon's two HTTP verbs. It does
// NOT import the engine: it talks to /api/recall and /api/ingest over localhost and
// lets the daemon do every bit of hygiene/retrieval. That is the whole point of the
// adapter architecture — adapters are stateless field-shapers, the daemon is the brain.
//
//   UserPromptSubmit  → POST /api/recall  → return text as `additionalContext`
//   Stop              → read transcript   → POST /api/ingest (the just-finished turn)
//
// ⚠️ FAIL-OPEN IS THE LAW. A daemon that is down / slow / 500 / timing out must NEVER
// block the user's prompt or crash Claude Code. Every daemon call has a hard 1–2s
// timeout, returns empty on ANY failure, and swallows all errors. Dhakira being down
// means the user's AI works normally — just without memory.
//
// HOOK CONTRACT — verified against live Claude Code docs (docs.claude.com hooks
// reference) + a real transcript on disk, 2026-06-19. See the field map in the report.

import { createHookAdapter, type LastTurn, stripInjected } from './shared-adapter.js'

export type {
  AdapterOptions,
  HookMessage,
  LastTurn,
  StopOutcome,
  UserPromptSubmitOutput,
} from './shared-adapter.js'

/**
 * Extract plain text from a transcript record's `content`, which is either a string
 * (typical user prompt) or an array of content blocks (assistant turns, tool I/O).
 * Only `text` blocks are kept — tool_use / tool_result / thinking / image are dropped,
 * so a tool-result-only user record yields '' and is treated as "not a real prompt".
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return stripInjected(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return stripInjected(parts.join('\n'))
}

interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

function entryFromLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let record: Record<string, unknown>
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }

  // Skip Claude Code meta/caveat records and subagent sidechains — not real turns.
  if (record.isMeta === true || record.isSidechain === true) return null

  const type = record.type
  if (type !== 'user' && type !== 'assistant') return null

  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const msg = message as Record<string, unknown>
  if (msg.role !== 'user' && msg.role !== 'assistant') return null

  const text = extractText(msg.content)
  if (text.length === 0) return null
  return { role: msg.role, text }
}

/**
 * Pull the just-finished turn out of a JSONL transcript: the LAST real user prompt
 * paired with the assistant's final reply. Sending only this one pair (not the whole
 * transcript) is what keeps capture to "once per real turn" — re-sending the full
 * transcript on every Stop would re-ingest earlier turns N times.
 *
 * The assistant side prefers `lastAssistantMessage` (the Stop payload gives it to us
 * directly, no parsing) and falls back to the last assistant text in the transcript.
 */
export function extractLastTurn(raw: string, lastAssistantMessage = ''): LastTurn | null {
  let lastUser = ''
  let lastAssistant = ''
  for (const line of raw.split('\n')) {
    const entry = entryFromLine(line)
    if (entry === null) continue
    if (entry.role === 'user') lastUser = entry.text
    else lastAssistant = entry.text
  }

  const assistant = stripInjected(lastAssistantMessage) || lastAssistant
  if (lastUser.length === 0 || assistant.length === 0) return null
  return { user: lastUser, assistant }
}

const adapter = createHookAdapter({ tool: 'claude-code', extractLastTurn })

/** UserPromptSubmit → /api/recall. Shared fail-open behavior remains byte-identical. */
export const runUserPromptSubmit = adapter.runUserPromptSubmit
/** Stop → transcript parser → /api/ingest. */
export const runStop = adapter.runStop
/** Event dispatcher used by the Claude stdin/stdout shim. */
export const handleEvent = adapter.handleEvent
