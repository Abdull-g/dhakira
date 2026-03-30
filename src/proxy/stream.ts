// SSE streaming passthrough + capture

import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import { gunzipSync } from 'node:zlib'

/** Read the full body of an incoming request into a Buffer */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

export interface ForwardOptions {
  url: string
  method: string
  headers: Record<string, string>
  body: Buffer
}

/**
 * Make an outgoing HTTP or HTTPS request to the upstream provider.
 * Returns the provider's IncomingMessage (response stream) without buffering it.
 */
export function forwardRequest(options: ForwardOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url)
    const isHttps = target.protocol === 'https:'
    const transport = isHttps ? https : http

    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method,
        headers: options.headers,
      },
      resolve,
    )

    req.on('error', reject)

    if (options.body.length > 0) {
      req.write(options.body)
    }
    req.end()
  })
}

/**
 * Pipe a provider response to the client response, chunk by chunk.
 *
 * This is the SSE tee: each chunk is written to the client immediately
 * (preserving streaming latency) and simultaneously accumulated in a buffer.
 * When the provider closes the connection, `onComplete` is called with the
 * full accumulated body — used for async conversation capture.
 *
 * Works for both streaming (SSE) and non-streaming (JSON) responses.
 */
export async function pipeResponse(
  providerRes: IncomingMessage,
  clientRes: ServerResponse,
  onComplete: (body: Buffer) => void,
): Promise<void> {
  const statusCode = providerRes.statusCode ?? 200

  // Forward all response headers from provider to client
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(providerRes.headers)) {
    if (value !== undefined) {
      headers[key] = value
    }
  }
  clientRes.writeHead(statusCode, headers)

  const chunks: Buffer[] = []

  for await (const chunk of providerRes) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    // Write to client immediately — critical for SSE latency
    clientRes.write(buffer)
    // Accumulate a copy for post-response capture
    chunks.push(buffer)
  }

  clientRes.end()

  // Decompress the body if it's gzip-encoded before passing to capture.
  // The raw (possibly compressed) chunks were already piped to the client above.
  let body = Buffer.concat(chunks)
  const encoding = providerRes.headers['content-encoding']
  if (encoding === 'gzip' || encoding === 'deflate') {
    try {
      body = gunzipSync(body)
    } catch {
      // If decompression fails, pass raw body — parseAssistantResponse will handle the error
    }
  }
  onComplete(body)
}
