// Dhakira — ingest core (the second daemon verb, sibling to src/recall.ts)
//
// A GENERIC trace-ingest path: it takes a raw message array from ANY adapter
// (Claude Code hook, Codex, MCP, file) and runs it through the FULL capture
// hygiene chain — the SAME exported functions the proxy capture path uses:
//
//   classifyConversation → sanitizeTrace → writeConversation
//                        → extractTurnPairs → applyQualityGate → write+index
//
// This is deliberately NOT a thin wrapper over captureConversationOnce. That
// function is built around provider WIRE FORMAT (ingestAnthropicTrace /
// ingestOpenAITrace) and, on a generic {messages} array, would fall to its v1
// path and SKIP classify + sanitize (the archive's bypass trap). Here we hand-
// build a ConversationTrace and run the clean chain explicitly, so hygiene
// ALWAYS runs (and the tests assert it).
//
// writeConversation is REQUIRED, not optional: Layer-2 extraction reads the
// conversation files (reconstructSessions), and that is where cleanSessionContent
// — the SUGGESTION-mode poison filter (f1f036a) — runs. Skipping the conversation
// write would silently exclude ingested transcripts from the poison filter.

import { createHash } from 'node:crypto'
import type { QMDStore } from '@tobilu/qmd'

import { classifyConversation } from './capture/classifier.js'
import type { ContentBlock, ConversationTrace, TraceMessage } from './capture/ingest.js'
import { applyQualityGate } from './capture/quality-gate.js'
import { sanitizeTrace } from './capture/sanitizer.js'
import { extractTurnPairs, writeExtractedPairs } from './capture/turns.js'
import type { CapturedConversation } from './capture/types.js'
import { writeConversation } from './capture/writer.js'
import type { WalletConfig } from './config/schema.js'
import { maybeTriggerExtraction } from './extraction/trigger.js'
import { computeContextFingerprint } from './proxy/fingerprint.js'
import type { NormalizedMessage } from './proxy/types.js'
import { indexTurnPair } from './retrieval/indexer.js'
import { readGitIdentity } from './store/git-identity.js'
import { resolveProjectId } from './store/project.js'
import { generateId } from './utils/ids.js'
import { createLogger } from './utils/logger.js'
import { estimateMessagesTokens } from './utils/tokens.js'

const log = createLogger('ingest')

export interface IngestDeps {
  store: QMDStore
  config: WalletConfig
}

export interface IngestInput {
  /** The conversation to ingest, provider-agnostic. */
  messages: NormalizedMessage[]
  /** Source tool, e.g. "claude-code". Stamped on the conversation + turns. */
  tool: string
  /** Optional model id (used for classifier rules + frontmatter). */
  model?: string
  /** Explicit client-resolved projectId — used AS-IS (symmetric with recallOnce). */
  projectId?: string
  /** Local cwd to resolve a projectId from when none is explicit. Local read, NO network. */
  cwd?: string
  /** Capture timestamp (defaults to now). */
  timestamp?: Date
}

export interface IngestResult {
  /** Request processed without error (false only on internal failure). */
  ok: boolean
  /** Whether anything was stored in the wallet. */
  captured: boolean
  /** Number of gated turn pairs written + indexed. */
  turnPairs: number
  /** The projectId used for scoping. */
  projectId: string
  /** Why nothing was captured, when captured === false. */
  reason?: string
}

/**
 * projectId precedence mirrors recallOnce: explicit id (used as-is) → cwd sniff
 * (local git read, never network) → 'global'. An adapter sends the SAME signal to
 * both /api/ingest and /api/recall so capture and recall scope to one project.
 */
export async function resolveIngestProjectId(input: {
  projectId?: string
  cwd?: string
}): Promise<string> {
  const explicit = input.projectId?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit

  const cwd = input.cwd?.trim()
  if (cwd === undefined || cwd.length === 0) return 'global'

  const git = await readGitIdentity(cwd)
  return resolveProjectId({ cwd, gitRemote: git.gitRemote, gitRoot: git.gitRoot })
}

function hashSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.length === 0) return 'default'
  return createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12)
}

function toTraceMessages(messages: NormalizedMessage[]): TraceMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }))
}

function buildTrace(messages: NormalizedMessage[], tool: string, model: string): ConversationTrace {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  return {
    messages: toTraceMessages(messages),
    systemPromptHash: hashSystemPrompt(systemPrompt),
    systemPrompt,
    model,
    maxTokens: 0,
    streamResponse: false,
    rawRequest: { messages },
    rawResponse: null,
    sourceTool: tool,
  }
}

function traceContentToText(content: ContentBlock[]): string {
  return content
    .flatMap((block): string[] => {
      if (block.type === 'text') return [block.text]
      if (block.type === 'thinking') return [block.thinking]
      if (block.type === 'tool_use') return [`[tool_use: ${block.name}]`]
      if (block.type === 'tool_result') return [block.content]
      if (block.type === 'image') return ['[image]']
      return []
    })
    .join('\n')
}

function traceMessagesToNormalized(messages: TraceMessage[]): NormalizedMessage[] {
  return messages.flatMap((message): NormalizedMessage[] =>
    message.role === 'tool'
      ? []
      : [{ role: message.role, content: traceContentToText(message.content) }],
  )
}

export async function ingestTrace(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const { store, config } = deps
  const walletDir = config.walletDir
  const projectId = await resolveIngestProjectId(input)

  if (input.messages.length === 0) {
    return { ok: true, captured: false, turnPairs: 0, projectId, reason: 'empty_messages' }
  }

  const trace = buildTrace(input.messages, input.tool, input.model ?? '')

  // HYGIENE 1/4 — classify. Skip categories (title-gen, summaries, tool noise,
  // suggestion-mode autocomplete, errors) never reach the wallet. The archive
  // bypass skipped this; we gate BEFORE writing anything.
  const classification = classifyConversation(trace)
  if (!classification.keep) {
    return {
      ok: true,
      captured: false,
      turnPairs: 0,
      projectId,
      reason: `classified_skip:${classification.category}`,
    }
  }

  // HYGIENE 2/4 — sanitize (strip <system-reminder> etc.). Also skipped by the archive.
  const sanitized = sanitizeTrace(trace).trace

  // Conversation archive — REQUIRED so Layer-2 extraction (and cleanSessionContent,
  // the SUGGESTION poison filter) can see this ingest. Mirrors the proxy v2 path.
  const conversationMessages = traceMessagesToNormalized(sanitized.messages)
  const timestamp = input.timestamp ?? new Date()
  const conversation: CapturedConversation = {
    id: generateId('conv'),
    tool: input.tool,
    provider: 'hook',
    model: input.model ?? '',
    messages: conversationMessages,
    timestamp,
    tokenEstimate: estimateMessagesTokens(conversationMessages),
    incognito: config.incognito,
    projectId,
  }
  await writeConversation(conversation, walletDir)

  // HYGIENE 3/4 + 4/4 — extract turn pairs, then the existing quality gate (reused).
  const captureFingerprint = computeContextFingerprint(sanitized.systemPrompt)
  const pairs = extractTurnPairs(
    sanitized.messages,
    conversation.tool,
    conversation.id,
    conversation.timestamp,
    captureFingerprint,
    projectId,
  )
  const gatedPairs = applyQualityGate(pairs)

  // Write + directly index each gated pair (instant BM25 searchability; vectors
  // are filled in later by background reconciliation).
  const writes = await writeExtractedPairs(gatedPairs, walletDir)
  let stored = 0
  for (const result of writes) {
    if (!result.ok) continue
    stored++
    try {
      await indexTurnPair(store, result.value.filePath, result.value.content, walletDir)
    } catch (err) {
      log.error('Ingest index registration failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Fire-and-forget Layer-2 trigger — same as the proxy capture path. This is what
  // makes the SUGGESTION poison filter actually run on ingested Claude transcripts.
  maybeTriggerExtraction(walletDir, store, config).catch(() => {})

  return {
    ok: true,
    captured: stored > 0,
    turnPairs: stored,
    projectId,
    reason: stored > 0 ? undefined : 'no_turn_pairs',
  }
}
