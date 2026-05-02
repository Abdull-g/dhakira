import { createHash } from 'node:crypto'
import type { Result } from '../proxy/types.js'

export type TraceRole = 'system' | 'user' | 'assistant' | 'tool'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'image'; source: unknown }
  | { type: 'unknown'; raw: unknown }

export interface TraceMessage {
  role: TraceRole
  content: ContentBlock[]
}

export interface ConversationTrace {
  messages: TraceMessage[]
  systemPromptHash: string
  systemPrompt: string
  model: string
  maxTokens: number
  streamResponse: boolean
  sanitizerRemovedAll?: boolean
  responseMessageIndex?: number
  rawRequest: unknown
  rawResponse: unknown
  sourceTool: string
}

export interface IngestInput {
  requestBody: unknown
  responseBody: Buffer | string | null
  responseSseEvents?: unknown[] | null
  sourceTool: string
}

interface SseContentBuilder {
  type: string
  text: string
  thinking: string
  id: string
  name: string
  inputJson: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hashSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.length === 0) return 'default'
  return createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12)
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        if (!isRecord(block)) return []
        if (block.type === 'text' && typeof block.text === 'string') return [block.text]
        return []
      })
      .join('\n')
  }
  return ''
}

function normalizeSystem(system: unknown): { prompt: string; messages: TraceMessage[] } {
  const prompt = normalizeTextContent(system)
  return {
    prompt,
    messages:
      prompt.length > 0 ? [{ role: 'system', content: [{ type: 'text', text: prompt }] }] : [],
  }
}

function normalizeBlock(block: unknown): ContentBlock {
  if (!isRecord(block)) return { type: 'unknown', raw: block }

  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return { type: 'thinking', thinking: block.thinking }
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      input: block.input,
    }
  }
  if (block.type === 'tool_result') {
    const content = normalizeTextContent(block.content)
    return {
      type: 'tool_result',
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      content,
    }
  }
  if (block.type === 'image') {
    return { type: 'image', source: block.source }
  }

  return { type: 'unknown', raw: block }
}

function normalizeContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.map(normalizeBlock)
  return []
}

function normalizeRequestMessages(messages: unknown): TraceMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.flatMap((message): TraceMessage[] => {
    if (!isRecord(message)) return []
    const blocks = normalizeContentBlocks(message.content)
    if (message.role === 'assistant') return [{ role: 'assistant', content: blocks }]
    if (message.role === 'user') {
      const role =
        blocks.length > 0 && blocks.every((block) => block.type === 'tool_result') ? 'tool' : 'user'
      return [{ role, content: blocks }]
    }
    return []
  })
}

function parseRawResponse(responseBody: Buffer | string | null): unknown {
  if (responseBody === null) return null
  const text = Buffer.isBuffer(responseBody) ? responseBody.toString('utf8') : responseBody
  if (text.trim().length === 0) return null
  const sseEvents = parseAnthropicSseText(text)
  if (sseEvents.length > 0) return coalesceAnthropicSseEvents(sseEvents)
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function parseAnthropicSseText(text: string): unknown[] {
  const events: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      events.push(JSON.parse(payload) as unknown)
    } catch {
      continue
    }
  }
  return events
}

function normalizeResponseMessage(rawResponse: unknown): TraceMessage | null {
  if (!isRecord(rawResponse)) return null
  const content = rawResponse.content
  if (!Array.isArray(content)) return null
  return { role: 'assistant', content: normalizeContentBlocks(content) }
}

export function coalesceAnthropicSseEvents(events: unknown[]): Record<string, unknown> {
  const builders = new Map<number, SseContentBuilder>()
  for (const event of events) {
    if (!isRecord(event)) continue
    if (event.type === 'content_block_start') startContentBlock(builders, event)
    if (event.type === 'content_block_delta') appendContentDelta(builders, event)
  }

  return {
    role: 'assistant',
    content: [...builders.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, builder]) => buildContentBlock(builder)),
  }
}

function startContentBlock(
  builders: Map<number, SseContentBuilder>,
  event: Record<string, unknown>,
): void {
  if (typeof event.index !== 'number' || !isRecord(event.content_block)) return
  const block = event.content_block
  builders.set(event.index, {
    type: typeof block.type === 'string' ? block.type : 'unknown',
    text: typeof block.text === 'string' ? block.text : '',
    thinking: typeof block.thinking === 'string' ? block.thinking : '',
    id: typeof block.id === 'string' ? block.id : '',
    name: typeof block.name === 'string' ? block.name : '',
    inputJson: '',
  })
}

function appendContentDelta(
  builders: Map<number, SseContentBuilder>,
  event: Record<string, unknown>,
): void {
  if (typeof event.index !== 'number' || !isRecord(event.delta)) return
  const builder = builders.get(event.index)
  if (builder === undefined) return

  const delta = event.delta
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    builder.text += delta.text
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    builder.thinking += delta.thinking
  }
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    builder.inputJson += delta.partial_json
  }
}

function buildContentBlock(builder: SseContentBuilder): ContentBlock[] {
  if (builder.type === 'text') return [{ type: 'text', text: builder.text }]
  if (builder.type === 'thinking') return [{ type: 'thinking', thinking: builder.thinking }]
  if (builder.type !== 'tool_use') return []
  return [
    {
      type: 'tool_use',
      id: builder.id,
      name: builder.name,
      input: parseToolInput(builder.inputJson),
    },
  ]
}

function parseToolInput(inputJson: string): unknown {
  if (inputJson.trim().length === 0) return {}
  try {
    return JSON.parse(inputJson) as unknown
  } catch {
    return inputJson
  }
}

export function ingestAnthropicTrace(input: IngestInput): Result<ConversationTrace> {
  const request = input.requestBody
  if (!isRecord(request)) {
    return { ok: false, error: new Error('Invalid Anthropic request: expected object body') }
  }

  if (typeof request.model !== 'string' || !Array.isArray(request.messages)) {
    return {
      ok: false,
      error: new Error('Invalid Anthropic request: missing model or messages'),
    }
  }

  const system = normalizeSystem(request.system)
  const rawResponse = Array.isArray(input.responseSseEvents)
    ? coalesceAnthropicSseEvents(input.responseSseEvents)
    : parseRawResponse(input.responseBody)
  const responseMessage = normalizeResponseMessage(rawResponse)
  const requestMessages = normalizeRequestMessages(request.messages)
  const messages =
    responseMessage === null
      ? [...system.messages, ...requestMessages]
      : [...system.messages, ...requestMessages, responseMessage]

  return {
    ok: true,
    value: {
      messages,
      systemPromptHash: hashSystemPrompt(system.prompt),
      systemPrompt: system.prompt,
      model: request.model,
      maxTokens: typeof request.max_tokens === 'number' ? request.max_tokens : 0,
      streamResponse: request.stream === true,
      responseMessageIndex: responseMessage === null ? undefined : messages.length - 1,
      rawRequest: request,
      rawResponse,
      sourceTool: input.sourceTool,
    },
  }
}
