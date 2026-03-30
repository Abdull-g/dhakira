// HTTP proxy server — the core of Dhakira

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { CapturedConversation } from '../capture/types.js'
import { writeConversation } from '../capture/writer.js'
import type { ToolConfig, WalletConfig } from '../config/schema.js'
import { generateId } from '../utils/ids.js'
import { createLogger } from '../utils/logger.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import { parseAnthropicRequest } from './anthropic.js'
import { detectFormat, HOP_BY_HOP_HEADERS, isRecord } from './detect.js'
import { parseOpenAIRequest } from './openai.js'
import { forwardRequest, pipeResponse, readBody } from './stream.js'
import type { NormalizedRequest } from './types.js'

/**
 * Optional hooks injected at startup.
 * Both default to no-ops so the server works without them (steps 3–4 of build order).
 * Injection and capture are wired in later build steps.
 */
export interface ProxyDeps {
  /**
   * Called before forwarding. May return a replacement system prompt string
   * (the full text to use, not a delta). Return null to leave system prompt unchanged.
   */
  injectMemories?: (normalized: NormalizedRequest) => Promise<string | null>
  /**
   * Called after the response is fully streamed back to the client.
   * Must not block — fire and forget. Used for conversation capture.
   */
  captureConversation?: (normalized: NormalizedRequest, responseBody: Buffer) => void
}

/** Resolve an API key that may use the "env:VAR_NAME" indirection */
export function resolveApiKey(apiKey: string): string {
  if (apiKey.startsWith('env:')) {
    const varName = apiKey.slice(4)
    const value = process.env[varName]
    if (value === undefined) {
      throw new Error(`Environment variable "${varName}" is not set`)
    }
    return value
  }
  return apiKey
}

/**
 * Find the tool config whose resolved API key matches the incoming request.
 * OpenAI tools use `Authorization: Bearer <key>`; Anthropic tools use `x-api-key: <key>`.
 *
 * If a tool's apiKey is set to "*", it matches any request for that provider.
 * This is useful for tools like Claude Code CLI that use OAuth tokens instead
 * of a static API key.
 */
export function matchTool(
  tools: ToolConfig[],
  authHeader: string | undefined,
  xApiKeyHeader: string | undefined,
): ToolConfig | null {
  const bearerToken = authHeader?.replace(/^Bearer\s+/i, '')

  for (const tool of tools) {
    // Wildcard: match any request for this provider type (accepts any auth header)
    if (tool.apiKey === '*') {
      if (tool.provider === 'openai' && (bearerToken || xApiKeyHeader)) return tool
      if (tool.provider === 'anthropic' && (xApiKeyHeader || bearerToken)) return tool
      continue
    }

    let resolvedKey: string
    try {
      resolvedKey = resolveApiKey(tool.apiKey)
    } catch {
      continue // skip tool if env var is unset
    }

    if (tool.provider === 'openai' && bearerToken === resolvedKey) return tool
    if (tool.provider === 'anthropic' && xApiKeyHeader === resolvedKey) return tool
  }

  return null
}

/**
 * Build the upstream URL. We use the provider origin from baseUrl combined with
 * the full request path (which already includes the /v1/... prefix).
 *
 * Example: baseUrl="https://api.openai.com/v1", path="/v1/chat/completions"
 *   → "https://api.openai.com/v1/chat/completions"
 */
function buildForwardUrl(baseUrl: string, requestUrl: string): string {
  const { origin } = new URL(baseUrl)
  return origin + requestUrl
}

/** Flatten IncomingMessage headers (which may have string[] values) to Record<string, string> */
function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.join(', ')
    }
  }
  return result
}

/**
 * Build the headers to send to the upstream provider.
 * - Strips hop-by-hop headers
 * - Updates Host to the provider host
 * - Sets Content-Length to the (possibly modified) body length
 * - Replaces the API key header with the resolved key from config
 */
function buildForwardHeaders(
  req: IncomingMessage,
  tool: ToolConfig,
  bodyLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && typeof value === 'string') {
      headers[lowerKey] = value
    }
  }

  headers.host = new URL(tool.baseUrl).host
  headers['content-type'] = 'application/json'
  headers['content-length'] = String(bodyLength)

  // Wildcard tools pass through the original auth headers unchanged
  if (tool.apiKey !== '*') {
    const resolvedKey = resolveApiKey(tool.apiKey)
    if (tool.provider === 'openai') {
      headers.authorization = `Bearer ${resolvedKey}`
      delete headers['x-api-key']
    } else {
      headers['x-api-key'] = resolvedKey
      delete headers.authorization
    }
  }

  return headers
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  res.end(JSON.stringify({ error: { message, code: status } }))
}

/**
 * Forward a request whose format is unknown (e.g. GET /v1/models) or has no body.
 * Passes through untouched — no injection, no capture.
 */
async function forwardRaw(
  tool: ToolConfig,
  req: IncomingMessage,
  requestUrl: string,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const targetUrl = buildForwardUrl(tool.baseUrl, requestUrl)
  const headers: Record<string, string> = {}

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && typeof value === 'string') {
      headers[lowerKey] = value
    }
  }

  headers.host = new URL(tool.baseUrl).host

  if (body.length > 0) {
    headers['content-length'] = String(body.length)
  }

  // Wildcard tools keep original auth headers; configured tools substitute their key
  if (tool.apiKey !== '*') {
    const resolvedKey = resolveApiKey(tool.apiKey)
    if (tool.provider === 'openai') {
      headers.authorization = `Bearer ${resolvedKey}`
    } else {
      headers['x-api-key'] = resolvedKey
    }
  }

  const providerRes = await forwardRequest({
    url: targetUrl,
    method: req.method ?? 'GET',
    headers,
    body,
  })

  await pipeResponse(providerRes, res, () => {})
}

/**
 * Parse the request body, apply injection, forward to the provider, and pipe back.
 * Extracted from handleRequest to keep cognitive complexity within limits.
 */
async function forwardChatRequest(
  config: WalletConfig,
  deps: ProxyDeps,
  logger: ReturnType<typeof createLogger>,
  req: IncomingMessage,
  res: ServerResponse,
  tool: ToolConfig,
  parsedBody: Record<string, unknown>,
  rawBodyBuffer: Buffer,
  requestUrl: string,
  method: string,
): Promise<void> {
  const format = detectFormat(req, parsedBody)
  const rawHeaders = flattenHeaders(req.headers)

  const parseResult =
    format === 'openai'
      ? parseOpenAIRequest(parsedBody, rawHeaders, tool.name)
      : parseAnthropicRequest(parsedBody, rawHeaders, tool.name)

  if (!parseResult.ok) {
    logger.warn('Failed to parse request body', { error: parseResult.error.message })
    sendError(res, 400, parseResult.error.message)
    return
  }

  const normalized = parseResult.value

  // Apply memory injection unless incognito
  let injectedPrompt: string | null = null
  if (!config.incognito && deps.injectMemories !== undefined) {
    injectedPrompt = await deps.injectMemories(normalized)
  }

  // If nothing was injected, forward the original raw body byte-for-byte.
  // When injecting, we surgically modify only the system/messages field
  // in the parsed JSON to preserve all other fields (beta, metadata, etc.)
  // that our type-safe rebuild logic might not know about.
  let bodyBuffer: Buffer
  if (injectedPrompt === null) {
    bodyBuffer = rawBodyBuffer
  } else {
    // Work on the original parsed body to preserve all unknown fields
    const modified = { ...(parsedBody as Record<string, unknown>) }
    if (format === 'anthropic') {
      // Anthropic: APPEND injection to end of system field.
      // Must not prepend — Claude Code embeds billing headers at the start
      // that Anthropic's API requires to be first.
      const origSystem = modified.system
      if (origSystem === undefined) {
        modified.system = injectedPrompt
      } else if (typeof origSystem === 'string') {
        modified.system = `${origSystem}\n\n${injectedPrompt}`
      } else if (Array.isArray(origSystem)) {
        modified.system = [...origSystem, { type: 'text', text: injectedPrompt }]
      }
    } else {
      // OpenAI: append system message after existing system messages
      const messages = Array.isArray(modified.messages) ? [...modified.messages] : []
      const hasSystem = messages.some((m: Record<string, unknown>) => m.role === 'system')
      if (hasSystem) {
        // Append to last system message content
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as Record<string, unknown>
          if (m.role === 'system') {
            m.content = `${String(m.content ?? '')}\n\n${injectedPrompt}`
            break
          }
        }
      } else {
        messages.unshift({ role: 'system', content: injectedPrompt })
      }
      modified.messages = messages
    }
    bodyBuffer = Buffer.from(JSON.stringify(modified), 'utf8')
  }
  const targetUrl = buildForwardUrl(tool.baseUrl, requestUrl)

  logger.debug('Forwarding request', { tool: tool.name, model: normalized.model, targetUrl })

  let providerRes: IncomingMessage
  try {
    providerRes = await forwardRequest({
      url: targetUrl,
      method,
      headers: buildForwardHeaders(req, tool, bodyBuffer.length),
      body: bodyBuffer,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed'
    logger.error('Failed to reach provider', { error: message, targetUrl })
    sendError(res, 502, `Failed to reach provider: ${message}`)
    return
  }

  logger.debug('Streaming response', { statusCode: providerRes.statusCode })

  await pipeResponse(providerRes, res, (responseBody) => {
    if (!config.incognito && deps.captureConversation !== undefined) {
      deps.captureConversation(normalized, responseBody)
    }
  })

  logger.info('Request complete', {
    tool: tool.name,
    model: normalized.model,
    status: providerRes.statusCode,
  })
}

async function handleRequest(
  config: WalletConfig,
  deps: ProxyDeps,
  logger: ReturnType<typeof createLogger>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestUrl = req.url ?? '/'
  const method = req.method ?? 'GET'
  logger.debug('Incoming request', { method, url: requestUrl })

  const rawBodyBuffer = await readBody(req)

  let parsedBody: unknown = null
  if (rawBodyBuffer.length > 0) {
    try {
      parsedBody = JSON.parse(rawBodyBuffer.toString('utf8'))
    } catch {
      sendError(res, 400, 'Request body is not valid JSON')
      return
    }
  }

  const authHeader = req.headers.authorization as string | undefined
  const xApiKeyHeader = req.headers['x-api-key'] as string | undefined
  const tool = matchTool(config.tools, authHeader, xApiKeyHeader)

  if (tool === null) {
    logger.warn('No matching tool configuration found', { url: requestUrl })
    sendError(res, 401, 'No matching tool configuration. Check your API key.')
    return
  }

  // Non-chat requests (e.g. GET /v1/models): forward as-is without parsing
  if (parsedBody === null || !isRecord(parsedBody)) {
    await forwardRaw(tool, req, requestUrl, rawBodyBuffer, res)
    return
  }

  await forwardChatRequest(
    config,
    deps,
    logger,
    req,
    res,
    tool,
    parsedBody,
    rawBodyBuffer,
    requestUrl,
    method,
  )
}

/**
 * Build a CapturedConversation from a normalized request.
 * System prompt (if present) is prepended as a system message so the full
 * context is preserved in the conversation file.
 */
function buildCapturedConversation(
  normalized: NormalizedRequest,
  incognito: boolean,
): CapturedConversation {
  const messages =
    normalized.systemPrompt !== null
      ? [{ role: 'system' as const, content: normalized.systemPrompt }, ...normalized.messages]
      : normalized.messages

  return {
    id: generateId('conv'),
    tool: normalized.tool,
    provider: normalized.provider,
    model: normalized.model,
    messages,
    timestamp: normalized.timestamp,
    tokenEstimate: estimateMessagesTokens(messages),
    incognito,
  }
}

/** Create the proxy HTTP server. Call `.listen()` on the returned server to start it. */
export function createProxyServer(config: WalletConfig, deps: ProxyDeps = {}): Server {
  const logger = createLogger('proxy')

  // Default capture: write conversations to walletDir. Can be overridden via deps.
  const defaultCapture: ProxyDeps['captureConversation'] = (normalized) => {
    const conversation = buildCapturedConversation(normalized, config.incognito)
    // Fire and forget — writeConversation handles and logs its own errors
    writeConversation(conversation, config.walletDir).catch(() => {})
  }

  const effectiveDeps: ProxyDeps = {
    injectMemories: deps.injectMemories,
    captureConversation: deps.captureConversation ?? defaultCapture,
  }

  const server = createServer((req, res) => {
    handleRequest(config, effectiveDeps, logger, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Internal error'
      logger.error('Unhandled error in request handler', { error: message })
      sendError(res, 500, 'Internal proxy error')
    })
  })

  return server
}
