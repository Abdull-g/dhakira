// v0.3.1 — audit D4: callLLM had no request timeout, so a stalled provider could
// hang an extraction run (and, through the trigger lock, every later run) forever.
// Real loopback server that accepts the request and never answers.

import { createServer, type Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { callLLM, LLM_REQUEST_TIMEOUT_MS } from '../../src/extraction/extract.ts'

describe('callLLM request timeout (D4)', () => {
  let server: Server
  let baseUrl: string
  let sawRequest = false

  beforeEach(async () => {
    sawRequest = false
    server = createServer((_req, _res) => {
      sawRequest = true
      // Deliberately never respond.
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('no listen')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('defaults to a 60 s ceiling', () => {
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(60_000)
  })

  it('resolves ok:false with a timeout error instead of hanging when the provider never answers', async () => {
    const started = Date.now()
    const result = await callLLM(baseUrl, 'k', 'm', [{ role: 'user', content: 'hi' }], 150)
    const elapsed = Date.now() - started

    expect(sawRequest).toBe(true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/timed out after 150 ms/)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('still succeeds normally when the provider answers in time', async () => {
    server.removeAllListeners('request')
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"facts":[]}' } }] }))
    })
    const result = await callLLM(baseUrl, 'k', 'm', [{ role: 'user', content: 'hi' }], 2_000)
    expect(result.ok).toBe(true)
  })
})
