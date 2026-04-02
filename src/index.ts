// Dhakira — Entry Point
// Composition root: wires all components together and starts the server.

import { access, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storeTurnPairsWithContent } from './capture/turns.js'
import type { CapturedConversation } from './capture/types.js'
import { writeConversation } from './capture/writer.js'
import { loadConfig } from './config/loader.js'
import { createDashboardServer } from './dashboard/server.js'
import { buildInjectionBlock } from './injection/builder.js'
import { injectIntoSystemPrompt } from './injection/injector.js'
import { loadProfile } from './injection/profile.js'
import { computeContextFingerprint } from './proxy/fingerprint.js'
import type { ProxyDeps } from './proxy/server.js'
import { createProxyServer } from './proxy/server.js'
import { indexTurnPair, startReconciliation, stopReconciliation } from './retrieval/indexer.js'
import { searchTurns } from './retrieval/search.js'
import { createWalletStore } from './retrieval/store.js'
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

  const storeResult = await createWalletStore(config.walletDir)
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

      const t0 = Date.now()

      const contextFingerprint = computeContextFingerprint(normalized.systemPrompt)

      const profileResult = await loadProfile(config.walletDir)
      const profile = profileResult.ok ? profileResult.value : ''

      const searchResult = await searchTurns(store, {
        query: lastUserMessage,
        limit: config.injection.maxTurns,
        minScore: config.injection.minRelevanceScore,
        recencyBoost: config.injection.recencyBoost,
        contextFingerprint,
      })
      const turns = searchResult.ok ? searchResult.value : []

      const injectionBlock = buildInjectionBlock(profile, turns, config.injection)
      if (!injectionBlock.text) return null

      const elapsedS = ((Date.now() - t0) / 1000).toFixed(2)
      const count = turns.length
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
          for (const r of turns) {
            const snippet = r.turnPair.userContent.slice(0, 60).replace(/\n/g, ' ')
            const date = new Date(r.turnPair.timestamp)
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            emit(`  \u2192 "${snippet}" (${dateStr})`)
          }
        }
      }

      return injectIntoSystemPrompt(normalized.systemPrompt, injectionBlock)
    },

    captureConversation: (normalized, responseBody) => {
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
      }

      writeConversation(conversation, config.walletDir).catch(() => {})

      // Fingerprint the original system prompt (before our injection) so turns
      // are tagged with the tool's project context at capture time.
      const captureFingerprint = computeContextFingerprint(normalized.systemPrompt)

      // Write turn pairs to disk AND register directly into QMD's SQLite index.
      // Direct registration makes turns instantly BM25-searchable via FTS5 triggers.
      // Vector embeddings are generated later by background reconciliation.
      storeTurnPairsWithContent(
        messagesWithResponse,
        conversation.tool,
        conversation.id,
        conversation.timestamp,
        config.walletDir,
        captureFingerprint,
      )
        .then(async (results) => {
          let stored = 0
          for (const result of results) {
            if (result.ok) {
              stored++
              try {
                await indexTurnPair(
                  store,
                  result.value.filePath,
                  result.value.content,
                  config.walletDir,
                )
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                log.error('Direct index registration failed', { error: message })
                // Not fatal — background reconciliation will catch it
              }
            }
          }
          if (stored > 0) {
            emit(
              `${fmtTime()} Captured ${stored} turn${stored === 1 ? '' : 's'} (${conversation.tool})`,
            )
          }
        })
        .catch(() => {})
    },
  }

  const proxyServer = createProxyServer(config, deps)
  const dashboardServer = createDashboardServer(config, store)

  const pidFile = join(config.walletDir, '.pid')

  // Start background reconciliation: runs initial scan + embed on startup
  // (warms up models and indexes any turns from previous sessions), then
  // repeats every 5 minutes as a safety net for crash recovery and manual edits.
  startReconciliation(store)

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
        process.exit(0)
      }
    }
    proxyServer.close(onClose)
    dashboardServer.close(onClose)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  log.error('Fatal error', { error: String(err) })
  process.exit(1)
})
