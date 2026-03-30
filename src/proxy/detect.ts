// Auto-detect request format (OpenAI vs Anthropic)
import type { IncomingMessage } from 'node:http'

import type { DetectedFormat } from './types.js'

/**
 * Headers that must not be forwarded to the upstream provider.
 * These are connection-level (hop-by-hop) headers that are only meaningful
 * between adjacent nodes in the connection chain.
 */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Type guard for plain objects. Used to safely inspect unknown parsed JSON bodies.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Detect whether an incoming request is in OpenAI or Anthropic format.
 *
 * Detection order (most to least reliable):
 *   1. URL path — most tools use provider-specific paths
 *   2. Headers — Anthropic requires anthropic-version; it uses x-api-key
 *   3. Body structure — fallback for unusual configurations
 */
export function detectFormat(req: IncomingMessage, body: unknown): DetectedFormat {
  const url = req.url ?? ''

  // Anthropic: /v1/messages path
  if (url.startsWith('/v1/messages')) {
    return 'anthropic'
  }

  // OpenAI: /v1/chat/completions or other chat paths
  if (url.startsWith('/v1/chat/') || url.startsWith('/v1/completions')) {
    return 'openai'
  }

  // Header-based fallback: Anthropic always sends anthropic-version
  if (req.headers['anthropic-version'] !== undefined) {
    return 'anthropic'
  }

  // Body structure fallback: Anthropic uses x-api-key; OpenAI uses Authorization Bearer
  if (isRecord(body) && 'messages' in body) {
    if (req.headers['x-api-key'] !== undefined) {
      return 'anthropic'
    }
    if (req.headers.authorization !== undefined) {
      return 'openai'
    }
  }

  return 'unknown'
}
