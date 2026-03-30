import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { pipeResponse, readBody } from '../../src/proxy/stream.ts'

function makeReadable(chunks: Buffer[]): Readable {
  let index = 0
  return new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index++])
      } else {
        this.push(null)
      }
    },
  })
}

function makeIncomingMessage(
  chunks: Buffer[],
  statusCode = 200,
  headers: Record<string, string> = {},
): IncomingMessage {
  const readable = makeReadable(chunks)
  Object.assign(readable, { statusCode, headers })
  return readable as unknown as IncomingMessage
}

function makeServerResponse(): { res: ServerResponse; written: Buffer[]; ended: boolean } {
  const written: Buffer[] = []
  let ended = false
  let statusCode = 200
  const headers: Record<string, string | string[]> = {}

  const res = {
    writeHead: (code: number, hdrs: Record<string, string | string[]>) => {
      statusCode = code
      Object.assign(headers, hdrs)
    },
    write: (chunk: Buffer) => {
      written.push(chunk)
    },
    end: () => {
      ended = true
    },
    headersSent: false,
    statusCode,
  } as unknown as ServerResponse

  return { res, written, ended }
}

describe('readBody', () => {
  it('should read all chunks into a single buffer', async () => {
    const readable = makeReadable([Buffer.from('hello '), Buffer.from('world')])
    const result = await readBody(readable as unknown as IncomingMessage)
    expect(result.toString()).toBe('hello world')
  })

  it('should return empty buffer for empty stream', async () => {
    const readable = makeReadable([])
    const result = await readBody(readable as unknown as IncomingMessage)
    expect(result.length).toBe(0)
  })
})

describe('pipeResponse', () => {
  it('should stream SSE chunks without modification', async () => {
    const chunk1 = Buffer.from('data: {"id":"1"}\n\n')
    const chunk2 = Buffer.from('data: {"id":"2"}\n\n')
    const providerRes = makeIncomingMessage([chunk1, chunk2], 200, {
      'content-type': 'text/event-stream',
    })
    const { res, written } = makeServerResponse()

    let capturedBody: Buffer | null = null
    await pipeResponse(providerRes, res, (body) => {
      capturedBody = body
    })

    expect(written).toHaveLength(2)
    expect(written[0]).toEqual(chunk1)
    expect(written[1]).toEqual(chunk2)

    expect(capturedBody).not.toBeNull()
    expect(capturedBody?.toString()).toBe('data: {"id":"1"}\n\ndata: {"id":"2"}\n\n')
  })

  it('should forward the status code from the provider', async () => {
    const providerRes = makeIncomingMessage([], 201)
    const { res } = makeServerResponse()

    let headStatus = 0
    const resWithSpy = {
      ...res,
      writeHead: (code: number) => {
        headStatus = code
      },
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse

    await pipeResponse(providerRes, resWithSpy, () => {})
    expect(headStatus).toBe(201)
  })

  it('should call onComplete with empty buffer for empty response', async () => {
    const providerRes = makeIncomingMessage([], 200)
    const { res } = makeServerResponse()

    let capturedBody: Buffer | null = null
    await pipeResponse(providerRes, res, (body) => {
      capturedBody = body
    })

    expect(capturedBody?.length).toBe(0)
  })

  it('should call onComplete exactly once', async () => {
    const providerRes = makeIncomingMessage([Buffer.from('hello')], 200)
    const { res } = makeServerResponse()

    const onComplete = vi.fn()
    await pipeResponse(providerRes, res, onComplete)

    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
