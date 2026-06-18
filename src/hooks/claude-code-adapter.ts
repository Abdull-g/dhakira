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

import { readFileSync } from 'node:fs'

/** The daemon binds 127.0.0.1 (dashboard server). Overridable for tests / non-default ports. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:4101'
/** Hard fail-open ceiling for any single daemon call. Well under CC's 30s prompt-hook budget. */
const DEFAULT_TIMEOUT_MS = 1500
/** Source tool stamped on capture + sent as the project-scope signal alongside cwd. */
const TOOL = 'claude-code'

/** A user/assistant pair the adapter sends to /api/ingest. Local type — no engine import. */
export interface HookMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AdapterOptions {
  /** Daemon base URL. Defaults to DHAKIRA_DASHBOARD_URL env, then 127.0.0.1:4101. */
  baseUrl?: string
  /** Hard per-call timeout in ms. Defaults to 1500. */
  timeoutMs?: number
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable transcript reader (tests). Defaults to a safe readFileSync. */
  readTranscript?: (path: string) => string
}

/** The single turn extracted from a transcript at Stop time. */
export interface LastTurn {
  user: string
  assistant: string
}

interface ResolvedOptions {
  baseUrl: string
  timeoutMs: number
  fetchImpl: typeof fetch
  readTranscript: (path: string) => string
}

function defaultReadTranscript(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function resolveOptions(opts: AdapterOptions): ResolvedOptions {
  return {
    baseUrl: opts.baseUrl ?? process.env.DHAKIRA_DASHBOARD_URL ?? DEFAULT_BASE_URL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? fetch,
    readTranscript: opts.readTranscript ?? defaultReadTranscript,
  }
}

/** First string value among `keys` on a loosely-typed payload, else ''. */
function pickString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string') return value
  }
  return ''
}

const INJECTED_TAG = /<dhakira_context>[\s\S]*?<\/dhakira_context>/gi
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/**
 * Strip context Dhakira itself injected (recall is wrapped in <dhakira_context>, and
 * Claude Code wraps additionalContext in a <system-reminder>) so we never re-ingest
 * our own injection as if the user said it. The daemon's sanitizer also strips these,
 * so this is belt-and-suspenders against a feedback loop.
 */
function stripInjected(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').replace(INJECTED_TAG, '').trim()
}

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

/** POST JSON with a hard timeout. Returns parsed JSON on a 2xx, else null. Never hangs. */
async function postJson(
  url: string,
  payload: unknown,
  o: ResolvedOptions,
): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs)
  try {
    const res = await o.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** The JSON object Claude Code reads on stdout to inject per-prompt context. */
export interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit'
    additionalContext: string
  }
}

/**
 * UserPromptSubmit → recall. Returns the output object to print, or null to inject
 * nothing (no memory, empty query, or ANY daemon failure → prompt proceeds normally).
 */
export async function runUserPromptSubmit(
  payload: Record<string, unknown>,
  opts: AdapterOptions = {},
): Promise<UserPromptSubmitOutput | null> {
  const o = resolveOptions(opts)
  const query = pickString(payload, ['prompt', 'message', 'text']).trim()
  if (query.length === 0) return null

  const cwd = pickString(payload, ['cwd'])
  const projectId = pickString(payload, ['projectId', 'project_id'])

  let text = ''
  try {
    const body = await postJson(
      `${o.baseUrl}/api/recall`,
      {
        query,
        tool: TOOL,
        ...(cwd.length > 0 ? { cwd } : {}),
        ...(projectId.length > 0 ? { projectId } : {}),
      },
      o,
    )
    if (typeof body === 'object' && body !== null) {
      const t = (body as Record<string, unknown>).text
      if (typeof t === 'string') text = t
    }
  } catch {
    // FAIL-OPEN: daemon down / slow / aborted / unreachable → inject nothing.
    return null
  }

  if (text.length === 0) return null
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }
}

export interface StopOutcome {
  /** Whether a turn was POSTed to /api/ingest. */
  posted: boolean
  /** The messages sent (present only when posted). */
  messages?: HookMessage[]
  /** Why nothing was posted. */
  reason?: string
}

/**
 * Stop → capture. Reads the transcript, extracts the just-finished turn, and POSTs it
 * to /api/ingest with the same { cwd, projectId } project signal recall uses. Swallows
 * ALL errors (capture failure must never disrupt the session).
 */
export async function runStop(
  payload: Record<string, unknown>,
  opts: AdapterOptions = {},
): Promise<StopOutcome> {
  const o = resolveOptions(opts)
  try {
    const transcriptPath = pickString(payload, ['transcript_path', 'transcriptPath'])
    if (transcriptPath.length === 0) return { posted: false, reason: 'no_transcript_path' }

    const lastAssistant = pickString(payload, ['last_assistant_message', 'lastAssistantMessage'])
    const turn = extractLastTurn(o.readTranscript(transcriptPath), lastAssistant)
    if (turn === null) return { posted: false, reason: 'no_turn' }

    const cwd = pickString(payload, ['cwd'])
    const projectId = pickString(payload, ['projectId', 'project_id'])
    const messages: HookMessage[] = [
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant },
    ]

    await postJson(
      `${o.baseUrl}/api/ingest`,
      {
        messages,
        tool: TOOL,
        ...(cwd.length > 0 ? { cwd } : {}),
        ...(projectId.length > 0 ? { projectId } : {}),
      },
      o,
    )
    return { posted: true, messages }
  } catch {
    // FAIL-OPEN: any failure (unreadable transcript, daemon down, timeout) → skip capture.
    return { posted: false, reason: 'error' }
  }
}

/**
 * Dispatch a hook event to its handler and return the EXACT string to write to stdout
 * (empty string = write nothing). Never throws: the outer try/catch guarantees that a
 * bug here still degrades to "inject nothing, don't block".
 */
export async function handleEvent(
  event: string,
  payload: Record<string, unknown>,
  opts: AdapterOptions = {},
): Promise<string> {
  try {
    if (event === 'UserPromptSubmit') {
      const out = await runUserPromptSubmit(payload, opts)
      return out === null ? '' : JSON.stringify(out)
    }
    if (event === 'Stop') {
      await runStop(payload, opts)
      // Emit nothing: exit 0 with no `decision` lets Claude stop normally.
      return ''
    }
    return ''
  } catch {
    return ''
  }
}
