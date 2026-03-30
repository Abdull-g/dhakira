// OpenAI format request/response handling
import { generateId } from '../utils/ids.js'
import { isRecord } from './detect.js'
import type { NormalizedMessage, NormalizedRequest, Result } from './types.js'

// OpenAI message content: either a plain string or an array of content parts
type TextPart = { type: 'text'; text: string }
type ImagePart = { type: 'image_url'; image_url: { url: string } }
type ContentPart = TextPart | ImagePart
type OpenAIContent = string | ContentPart[] | null

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function'
  content: OpenAIContent
  name?: string
  tool_call_id?: string
}

interface OpenAIRequestBody {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  [key: string]: unknown
}

function isOpenAIMessage(value: unknown): value is OpenAIMessage {
  if (!isRecord(value)) return false
  const role = value.role
  return (
    role === 'system' ||
    role === 'user' ||
    role === 'assistant' ||
    role === 'tool' ||
    role === 'function'
  )
}

function isOpenAIRequestBody(body: unknown): body is OpenAIRequestBody {
  if (!isRecord(body)) return false
  if (typeof body.model !== 'string') return false
  if (!Array.isArray(body.messages)) return false
  return body.messages.every(isOpenAIMessage)
}

/** Extract plain text from OpenAI's polymorphic message content field */
function extractText(content: OpenAIContent): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * Parse an OpenAI chat completions request body into a normalized form.
 * System messages are extracted out of the messages array and concatenated
 * into systemPrompt. The remaining messages are normalized to plain text.
 */
export function parseOpenAIRequest(
  body: unknown,
  rawHeaders: Record<string, string>,
  toolName: string,
): Result<NormalizedRequest> {
  if (!isOpenAIRequestBody(body)) {
    return { ok: false, error: new Error('Invalid OpenAI request body: missing model or messages') }
  }

  const messages: NormalizedMessage[] = []
  let systemPrompt: string | null = null

  for (const msg of body.messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content)
      systemPrompt = systemPrompt === null ? text : `${systemPrompt}\n${text}`
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: extractText(msg.content) })
    }
    // tool/function messages are pass-through only — not captured for memory
  }

  return {
    ok: true,
    value: {
      id: generateId('req'),
      tool: toolName,
      provider: 'openai',
      model: body.model,
      messages,
      systemPrompt,
      stream: body.stream ?? false,
      rawHeaders,
      rawBody: body,
      timestamp: new Date(),
    },
  }
}

/**
 * Rebuild an OpenAI request body with a (possibly modified) system prompt.
 * All fields from the original body are preserved; only messages is rebuilt
 * to reflect the new system prompt.
 */
export function buildOpenAIBody(
  rawBody: unknown,
  systemPrompt: string | null,
): Record<string, unknown> {
  // Safe cast: this function is only called after a successful parseOpenAIRequest
  const body = rawBody as OpenAIRequestBody

  const nonSystemMessages = body.messages.filter((msg) => msg.role !== 'system')
  const messages: OpenAIMessage[] =
    systemPrompt !== null
      ? [{ role: 'system', content: systemPrompt }, ...nonSystemMessages]
      : nonSystemMessages

  return { ...body, messages }
}
