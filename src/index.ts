// Dhakira — Entry Point
// Composition root: wires all components together and starts the server.

import { access, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { QMDStore } from '@tobilu/qmd'
import { classifyConversation } from './capture/classifier.js'
import {
  type ContentBlock,
  ingestAnthropicTrace,
  ingestOpenAITrace,
  type TraceMessage,
} from './capture/ingest.js'
import { applyQualityGate } from './capture/quality-gate.js'
import { sanitizeTrace } from './capture/sanitizer.js'
import {
  extractTurnPairs,
  storeTurnPairsWithContent,
  writeExtractedPairs,
} from './capture/turns.js'
import type { CapturedConversation } from './capture/types.js'
import { writeConversation } from './capture/writer.js'
import { loadConfig } from './config/loader.js'
import type { WalletConfig } from './config/schema.js'
import { createDashboardServer } from './dashboard/server.js'
import { maybeTriggerExtraction } from './extraction/trigger.js'
import { injectIntoSystemPrompt } from './injection/injector.js'
import { computeContextFingerprint } from './proxy/fingerprint.js'
import type { ProxyDeps } from './proxy/server.js'
import { createProxyServer } from './proxy/server.js'
import type { NormalizedMessage, NormalizedRequest } from './proxy/types.js'
import { recallOnce } from './recall.js'
import { indexTurnPair, startReconciliation, stopReconciliation } from './retrieval/indexer.js'
import { createWalletStore } from './retrieval/store.js'
import { readGitIdentity } from './store/git-identity.js'
import { resolveProjectId, sniffCwd } from './store/project.js'
import { generateId } from './utils/ids.js'
import { createLogger } from './utils/logger.js'
import { estimateMessagesTokens } from './utils/tokens.js'

const log = createLogger('main')

// ---------------------------------------------------------------------------
// Event output helpers
// ---------------------------------------------------------------------------

/** Format current time as [4:32 PM] */
function fmtTime(d = new Date()): string {
  let h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `[${h}:${String(m).padStart(2, '0')} ${ampm}]`
}

/** Write a clean event line to stdout (visible in foreground; discarded in daemon). */
function emit(line: string): void {
  process.stdout.write(`${line}\n`)
}

// Warm up models by reaching into QMD's internal llm handle to call
// expandQuery/embed/rerank directly. QMD has no public warmup API as
// of the current version. If QMD refactors `internal.llm`, this
// warmup will silently become a no-op (guarded by optional chaining);
// the product still works, just with slow first-use.
async function warmupSearchModels(store: QMDStore): Promise<boolean> {
  const llm = store.internal?.llm
  if (llm === undefined) {
    log.warn('Model warmup skipped: QMD internal llm handle unavailable')
    return false
  }

  emit(`  Warming up search models (~2.25GB first time, one-time download)...`)

  await llm.expandQuery('warmup')
  await llm.embed('task: search result | query: warmup')
  await llm.rerank('warmup', [{ file: 'warmup', text: 'warmup document' }])

  return true
}

// ---------------------------------------------------------------------------
// Personality line helpers
// ---------------------------------------------------------------------------

/**
 * Returns the mtime of the most recently written file in turns/, or null if
 * no turns have been captured yet.
 */
async function getLastTurnDate(walletDir: string): Promise<Date | null> {
  try {
    const turnsDir = join(walletDir, 'turns')
    const dateDirs = (await readdir(turnsDir)).sort()
    if (dateDirs.length === 0) return null
    const latestDateDir = dateDirs[dateDirs.length - 1]
    if (!latestDateDir) return null
    const files = await readdir(join(turnsDir, latestDateDir))
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    if (mdFiles.length === 0) return null
    let latest: Date | null = null
    for (const f of mdFiles) {
      const s = await stat(join(turnsDir, latestDateDir, f))
      if (!latest || s.mtime > latest) latest = s.mtime
    }
    return latest
  } catch {
    return null
  }
}

/**
 * Check whether the first-injection marker exists.
 * Returns true if Dhakira has never injected context before.
 */
async function isFirstInjectionEver(walletDir: string): Promise<boolean> {
  try {
    await access(join(walletDir, '.first-injection-done'))
    return false
  } catch {
    return true
  }
}

/** Mark that the first injection has happened. */
async function markFirstInjectionDone(walletDir: string): Promise<void> {
  await writeFile(join(walletDir, '.first-injection-done'), '', 'utf8').catch(() => {})
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the assistant's text content from a provider response body.
 * Handles both non-streaming (single JSON) and streaming (SSE) formats
 * for OpenAI and Anthropic providers.
 * Returns null if the response can't be parsed or has no text content.
 */
function parseAssistantResponse(responseBody: Buffer, provider: string): string | null {
  const text = responseBody.toString('utf8')

  // --- Try non-streaming first (single JSON object) ---
  try {
    const json = JSON.parse(text) as Record<string, unknown>

    if (provider === 'anthropic') {
      // Anthropic format: { content: [{ type: "text", text: "..." }] }
      const content = json.content
      if (!Array.isArray(content)) return null
      const textParts = content
        .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
        .map((c: Record<string, unknown>) => c.text as string)
      return textParts.length > 0 ? textParts.join('\n') : null
    }

    // OpenAI format: { choices: [{ message: { content: "..." } }] }
    const choices = json.choices
    if (!Array.isArray(choices) || choices.length === 0) return null
    const msg = (choices[0] as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined
    if (!msg || typeof msg.content !== 'string') return null
    return msg.content
  } catch {
    // JSON.parse failed — likely SSE streaming data. Fall through to SSE parser.
  }

  // --- SSE streaming fallback ---
  // Streaming responses are multiple "data: {...}" lines.
  // We extract text deltas from each line and concatenate them.
  try {
    const lines = text.split('\n')
    const parts: string[] = []

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') break

      let chunk: Record<string, unknown>
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue // Skip unparseable lines
      }

      if (provider === 'anthropic') {
        // Anthropic SSE: event types include content_block_delta with text_delta
        const delta = chunk.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          parts.push(delta.text)
        }
      } else {
        // OpenAI SSE: choices[].delta.content
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined
        if (choices?.[0]) {
          const delta = choices[0].delta as Record<string, unknown> | undefined
          if (delta && typeof delta.content === 'string') {
            parts.push(delta.content)
          }
        }
      }
    }

    const result = parts.join('')
    return result.length > 0 ? result : null
  } catch {
    return null
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
  return messages.flatMap((message): NormalizedMessage[] => {
    if (message.role === 'tool') return []
    return [{ role: message.role, content: traceContentToText(message.content) }]
  })
}

async function writeAndIndexTurnPairs(
  store: QMDStore,
  resultsPromise: Promise<Awaited<ReturnType<typeof writeExtractedPairs>>>,
  walletDir: string,
  tool: string,
): Promise<void> {
  const results = await resultsPromise
  let stored = 0
  for (const result of results) {
    if (result.ok) {
      stored++
      try {
        await indexTurnPair(store, result.value.filePath, result.value.content, walletDir)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('Direct index registration failed', { error: message })
        // Not fatal — background reconciliation will catch it
      }
    }
  }
  if (stored > 0) {
    emit(`${fmtTime()} Captured ${stored} turn${stored === 1 ? '' : 's'} (${tool})`)
  }
}

/**
 * L1 gather — the ONLY I/O on the project-resolution path, run at the capture edge.
 * Assembles ProjectSignals (explicit header → sniffed cwd → LOCAL git read →
 * fingerprint fallback) and hands them to the pure resolveProjectId. Local-disk
 * only, never network. NEVER throws — any failure degrades to "global" so a capture
 * is never broken by project-stamping (additive discipline).
 */
async function gatherProjectId(normalized: NormalizedRequest): Promise<string> {
  try {
    const explicitTag = normalized.rawHeaders['x-dhakira-project']
    // Sniff cwd from the whole request text so the tool-agnostic seam catches both
    // Claude Code's system-prompt line AND a Codex <cwd> tag in a user message.
    const payloadText = [
      normalized.systemPrompt ?? '',
      ...normalized.messages.map((m) => m.content),
    ].join('\n')
    const cwd = sniffCwd(payloadText) ?? undefined
    const fingerprint = computeContextFingerprint(normalized.systemPrompt)
    const git = cwd === undefined ? {} : await readGitIdentity(cwd)
    return resolveProjectId({
      explicitTag,
      gitRemote: git.gitRemote,
      gitRoot: git.gitRoot,
      cwd,
      fingerprint,
    })
  } catch {
    return 'global'
  }
}

export async function captureConversationOnce(
  normalized: NormalizedRequest,
  responseBody: Buffer,
  config: WalletConfig,
  store: QMDStore,
): Promise<void> {
  const projectId = await gatherProjectId(normalized)

  if (config.capture.pipelineVersion === 'v2') {
    const ingest = normalized.provider === 'anthropic' ? ingestAnthropicTrace : ingestOpenAITrace
    const traceResult = ingest({
      requestBody: normalized.rawBody,
      responseBody,
      sourceTool: normalized.tool,
    })

    if (traceResult.ok) {
      const trace = traceResult.value
      const classification = classifyConversation(trace)
      if (!classification.keep) return

      const sanitized = sanitizeTrace(trace).trace
      const conversationMessages = traceMessagesToNormalized(sanitized.messages)
      const conversation: CapturedConversation = {
        id: generateId('conv'),
        tool: normalized.tool,
        provider: normalized.provider,
        model: normalized.model,
        messages: conversationMessages,
        timestamp: normalized.timestamp,
        tokenEstimate: estimateMessagesTokens(conversationMessages),
        incognito: config.incognito,
        projectId,
      }

      await writeConversation(conversation, config.walletDir)

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
      await writeAndIndexTurnPairs(
        store,
        writeExtractedPairs(gatedPairs, config.walletDir),
        config.walletDir,
        conversation.tool,
      )
      // Fire-and-forget: capture-driven Layer 2 auto-extract.
      maybeTriggerExtraction(config.walletDir, store, config).catch((err) => {
        log.warn('Auto-extract trigger failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return
    }

    log.debug('V2 ingest failed, falling back to v1 capture path', {
      error: traceResult.error.message,
    })
  }

  const messages =
    normalized.systemPrompt !== null
      ? [{ role: 'system' as const, content: normalized.systemPrompt }, ...normalized.messages]
      : normalized.messages

  // Parse the assistant's response from the response body and append it
  // so turn pair extraction can pair user→assistant messages.
  const assistantContent = parseAssistantResponse(responseBody, normalized.provider)
  const messagesWithResponse = assistantContent
    ? [...messages, { role: 'assistant' as const, content: assistantContent }]
    : messages

  const conversation: CapturedConversation = {
    id: generateId('conv'),
    tool: normalized.tool,
    provider: normalized.provider,
    model: normalized.model,
    messages: messagesWithResponse,
    timestamp: normalized.timestamp,
    tokenEstimate: estimateMessagesTokens(messagesWithResponse),
    incognito: config.incognito,
    projectId,
  }

  await writeConversation(conversation, config.walletDir)

  // Fingerprint the original system prompt (before our injection) so turns
  // are tagged with the tool's project context at capture time.
  const captureFingerprint = computeContextFingerprint(normalized.systemPrompt)

  // Write turn pairs to disk AND register directly into QMD's SQLite index.
  // Direct registration makes turns instantly BM25-searchable via FTS5 triggers.
  // Vector embeddings are generated later by background reconciliation.
  await writeAndIndexTurnPairs(
    store,
    storeTurnPairsWithContent(
      messagesWithResponse,
      conversation.tool,
      conversation.id,
      conversation.timestamp,
      config.walletDir,
      captureFingerprint,
      projectId,
    ),
    config.walletDir,
    conversation.tool,
  )
  // Fire-and-forget: capture-driven Layer 2 auto-extract.
  maybeTriggerExtraction(config.walletDir, store, config).catch((err) => {
    log.warn('Auto-extract trigger failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function createCaptureConversation(
  config: WalletConfig,
  store: QMDStore,
): NonNullable<ProxyDeps['captureConversation']> {
  return (normalized, responseBody) => {
    captureConversationOnce(normalized, responseBody, config, store).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const configResult = await loadConfig()
  if (!configResult.ok) {
    throw new Error(`Failed to load config: ${configResult.error.message}`)
  }
  const config = configResult.value

  // "Start after 7+ days idle" personality line — check before servers start.
  const lastTurn = await getLastTurnDate(config.walletDir)
  if (lastTurn !== null) {
    const daysSince = (Date.now() - lastTurn.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince >= 7) {
      emit('Back. Did you miss me?')
    }
  }

  // D2: keep search models resident (config retrieval.modelsResident, default true)
  // so the first recall after an idle period does not reload ~2 GB of models
  // inside the hook's 1.5 s budget.
  const storeResult = await createWalletStore(config.walletDir, {
    modelsResident: config.retrieval.modelsResident,
  })
  if (!storeResult.ok) {
    throw new Error(`Failed to initialize QMD store: ${storeResult.error.message}`)
  }
  const store = storeResult.value

  const verbose = process.env['DHAKIRA_VERBOSE'] === '1'
  // Track first-injection state for this process — avoids a file read on every request
  // after the marker has been confirmed present.
  let firstInjectionPending = await isFirstInjectionEver(config.walletDir)

  const deps: ProxyDeps = {
    injectMemories: async (normalized) => {
      const lastUserMessage =
        [...normalized.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

      if (!lastUserMessage) return null

      // Pure core: retrieval + composition, no stdout. The proxy passes `normalized`
      // so the same gatherProjectId sniff runs as before (T07 query-side axis).
      const result = await recallOnce(
        { store, config, resolveProjectId: gatherProjectId },
        { query: lastUserMessage, normalized },
      )
      if (result.text === null) return null

      // Personality/verbose stdout lives HERE, in the proxy adapter — never in the
      // reusable core. Driven entirely by the structured RecallResult.
      const elapsedS = (result.elapsedMs / 1000).toFixed(2)
      const count = result.turnCount
      if (count > 0) {
        // "First memory injection" personality line — fires once per wallet lifetime.
        if (firstInjectionPending) {
          firstInjectionPending = false
          emit(`${fmtTime()} First memory injection. Your AI just remembered something.`)
          markFirstInjectionDone(config.walletDir).catch(() => {})
        } else {
          emit(`${fmtTime()} ${count} turn${count === 1 ? '' : 's'} injected (${elapsedS}s)`)
        }
        if (verbose) {
          for (const r of result.turns) {
            const snippet = r.turnPair.userContent.slice(0, 60).replace(/\n/g, ' ')
            const date = new Date(r.turnPair.timestamp)
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            emit(`  \u2192 "${snippet}" (${dateStr})`)
          }
        }
      }

      return injectIntoSystemPrompt(normalized.systemPrompt, { text: result.text })
    },

    captureConversation: createCaptureConversation(config, store),
  }

  const proxyServer = createProxyServer(config, deps)
  const dashboardServer = createDashboardServer(config, store)

  const pidFile = join(config.walletDir, '.pid')

  // Start background reconciliation: runs initial scan + embed on startup
  // (warms up models and indexes any turns from previous sessions), then
  // repeats every 5 minutes as a safety net for crash recovery and manual edits.
  startReconciliation(store)
  const warmupPromise = warmupSearchModels(store).catch((err: unknown) => {
    log.warn('Model warmup failed (non-fatal)', { error: String(err) })
    return false
  })
  warmupPromise.then((warmed) => {
    if (warmed) {
      emit(`  Search models ready.`)
    }
  })

  proxyServer.listen(config.proxy.port, config.proxy.host, () => {
    emit(`\n  Proxy listening on http://${config.proxy.host}:${config.proxy.port}`)
  })

  dashboardServer.listen(config.dashboard.port, config.dashboard.host, async () => {
    await writeFile(pidFile, String(process.pid), 'utf8').catch(() => {})
    emit(`  Dashboard at http://${config.dashboard.host}:${config.dashboard.port}`)
    emit(`\n  Ready. Dhakira is remembering.\n`)
  })

  const shutdown = (): void => {
    stopReconciliation()
    unlink(pidFile).catch(() => {})
    let closed = 0
    const onClose = (): void => {
      closed++
      if (closed === 2) {
        emit(`\n  Stopped. Your AI is on its own now.\n`)
        // Force exit via SIGKILL on self to skip native GPU destructor
        // (upstream llama.cpp Metal cleanup crashes on Apple Silicon).
        // Sockets and pid file are already cleaned up above.
        setImmediate(() => process.kill(process.pid, 'SIGKILL'))
      }
    }
    proxyServer.close(onClose)
    dashboardServer.close(onClose)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    log.error('Fatal error', { error: String(err) })
    process.exit(1)
  })
}
