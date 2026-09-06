// Shared stateless hook-adapter plumbing for "one daemon, two verbs, N adapters".
//
// Tool adapters supply only a tool stamp and a transcript parser. This module owns
// request shaping, the 1.5s fail-open boundary, and stdout dispatch so every adapter
// degrades the same way when Dhakira is unavailable.

import { readFileSync } from 'node:fs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:4101'
const DEFAULT_TIMEOUT_MS = 1500

export interface HookMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AdapterOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  readTranscript?: (path: string) => string
}

export interface LastTurn {
  user: string
  assistant: string
}

export interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit'
    additionalContext: string
  }
}

export interface StopOutcome {
  posted: boolean
  messages?: HookMessage[]
  reason?: string
}

interface ResolvedOptions {
  baseUrl: string
  timeoutMs: number
  fetchImpl: typeof fetch
  readTranscript: (path: string) => string
}

export interface HookAdapterDefinition {
  tool: string
  extractLastTurn: (raw: string, lastAssistantMessage?: string) => LastTurn | null
  /** Codex exposes a stable per-turn id; preserve it at the daemon boundary. */
  includeTurnId?: boolean
  /** Codex identifies subagent events explicitly; sidechains are not main-session turns. */
  skipSubagents?: boolean
  /** Forward the hook's model stamp on capture when the tool provides one. */
  includeModel?: boolean
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

export function pickString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string') return value
  }
  return ''
}

const INJECTED_TAG = /<dhakira_context>[\s\S]*?<\/dhakira_context>/gi
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

export function stripInjected(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').replace(INJECTED_TAG, '').trim()
}

function isSubagent(payload: Record<string, unknown>): boolean {
  return pickString(payload, ['agent_id', 'agentId']).length > 0
}

function requestMetadata(
  payload: Record<string, unknown>,
  definition: HookAdapterDefinition,
  includeModel: boolean,
): Record<string, string> {
  const metadata: Record<string, string> = {}
  const cwd = pickString(payload, ['cwd'])
  const projectId = pickString(payload, ['projectId', 'project_id'])
  // `session_id` is a documented common field on EVERY Claude Code and Codex hook
  // payload (Codex subagent hooks carry the parent session id). The daemon uses it
  // to group one-turn hook captures into exact sessions for Layer-2 extraction.
  const sessionId = pickString(payload, ['session_id', 'sessionId'])
  const turnId = definition.includeTurnId ? pickString(payload, ['turn_id', 'turnId']) : ''
  const model = includeModel && definition.includeModel ? pickString(payload, ['model']) : ''

  if (cwd.length > 0) metadata.cwd = cwd
  if (projectId.length > 0) metadata.projectId = projectId
  if (sessionId.length > 0) metadata.sessionId = sessionId
  if (turnId.length > 0) metadata.turnId = turnId
  if (model.length > 0) metadata.model = model
  return metadata
}

function recalledText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const text = (body as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

async function postJson(
  url: string,
  payload: unknown,
  options: ResolvedOptions,
): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) return null
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export function createHookAdapter(definition: HookAdapterDefinition): {
  runUserPromptSubmit: (
    payload: Record<string, unknown>,
    opts?: AdapterOptions,
  ) => Promise<UserPromptSubmitOutput | null>
  runStop: (payload: Record<string, unknown>, opts?: AdapterOptions) => Promise<StopOutcome>
  handleEvent: (
    event: string,
    payload: Record<string, unknown>,
    opts?: AdapterOptions,
  ) => Promise<string>
} {
  async function runUserPromptSubmit(
    payload: Record<string, unknown>,
    opts: AdapterOptions = {},
  ): Promise<UserPromptSubmitOutput | null> {
    if (definition.skipSubagents && isSubagent(payload)) return null

    const options = resolveOptions(opts)
    const query = pickString(payload, ['prompt', 'message', 'text']).trim()
    if (query.length === 0) return null

    let text = ''
    try {
      const body = await postJson(
        `${options.baseUrl}/api/recall`,
        {
          query,
          tool: definition.tool,
          ...requestMetadata(payload, definition, false),
        },
        options,
      )
      text = recalledText(body)
    } catch {
      return null
    }

    if (text.length === 0) return null
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    }
  }

  async function runStop(
    payload: Record<string, unknown>,
    opts: AdapterOptions = {},
  ): Promise<StopOutcome> {
    if (definition.skipSubagents && isSubagent(payload)) {
      return { posted: false, reason: 'subagent' }
    }

    const options = resolveOptions(opts)
    try {
      const transcriptPath = pickString(payload, ['transcript_path', 'transcriptPath'])
      if (transcriptPath.length === 0) return { posted: false, reason: 'no_transcript_path' }

      const lastAssistant = pickString(payload, ['last_assistant_message', 'lastAssistantMessage'])
      const turn = definition.extractLastTurn(options.readTranscript(transcriptPath), lastAssistant)
      if (turn === null) return { posted: false, reason: 'no_turn' }

      const messages: HookMessage[] = [
        { role: 'user', content: turn.user },
        { role: 'assistant', content: turn.assistant },
      ]

      await postJson(
        `${options.baseUrl}/api/ingest`,
        {
          messages,
          tool: definition.tool,
          ...requestMetadata(payload, definition, true),
        },
        options,
      )
      return { posted: true, messages }
    } catch {
      return { posted: false, reason: 'error' }
    }
  }

  async function handleEvent(
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
        return ''
      }
      return ''
    } catch {
      return ''
    }
  }

  return { runUserPromptSubmit, runStop, handleEvent }
}
