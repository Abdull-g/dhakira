// Anthropic format request/response handling
import { generateId } from '../utils/ids.js'
import { isRecord } from './detect.js'
import type { NormalizedMessage, NormalizedRequest, Result } from './types.js'

// Anthropic content blocks (messages API)
type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; source: unknown }
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string }
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

type AnthropicContent = string | ContentBlock[]

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContent
}

type AnthropicSystemBlock = { type: 'text'; text: string; [key: string]: unknown }
type AnthropicSystem = string | AnthropicSystemBlock[]

interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  system?: AnthropicSystem
  stream?: boolean
  max_tokens: number
  [key: string]: unknown
}

function isAnthropicMessage(value: unknown): value is AnthropicMessage {
  if (!isRecord(value)) return false
  return value.role === 'user' || value.role === 'assistant'
}

function isAnthropicRequestBody(body: unknown): body is AnthropicRequestBody {
  if (!isRecord(body)) return false
  if (typeof body.model !== 'string') return false
  if (!Array.isArray(body.messages)) return false
  if (typeof body.max_tokens !== 'number') return false
  return body.messages.every(isAnthropicMessage)
}

/** Extract plain text from Anthropic's polymorphic message content field */
function extractText(content: AnthropicContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Parse an Anthropic messages API request body into a normalized form.
 * The top-level `system` field becomes systemPrompt. Messages are normalized
 * to plain text (tool_use and tool_result blocks are omitted from memory capture).
 */
export function parseAnthropicRequest(
  body: unknown,
  rawHeaders: Record<string, string>,
  toolName: string,
): Result<NormalizedRequest> {
  if (!isAnthropicRequestBody(body)) {
    return {
      ok: false,
      error: new Error('Invalid Anthropic request body: missing model, messages, or max_tokens'),
    }
  }

  const messages: NormalizedMessage[] = body.messages.map((msg) => ({
    role: msg.role,
    content: extractText(msg.content),
  }))

  // Extract system prompt as plain text for memory search/injection.
  // Anthropic API accepts system as either a string or array of content blocks.
  let systemPrompt: string | null = null
  if (typeof body.system === 'string') {
    systemPrompt = body.system
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }

  return {
    ok: true,
    value: {
      id: generateId('req'),
      tool: toolName,
      provider: 'anthropic',
      model: body.model,
      messages,
      systemPrompt: systemPrompt || null,
      stream: body.stream ?? false,
      rawHeaders,
      rawBody: body,
      timestamp: new Date(),
    },
  }
}

/**
 * Rebuild an Anthropic request body with a (possibly modified) system prompt.
 * All original fields are preserved. The injected system prompt text is prepended
 * to the original system field, preserving its format (string or array of blocks).
 *
 * When system was originally an array of content blocks (e.g. from Claude Code),
 * we prepend a new text block rather than flattening to a string — this preserves
 * any cache_control or other metadata on existing blocks.
 */
export function buildAnthropicBody(
  rawBody: unknown,
  systemPrompt: string | null,
): Record<string, unknown> {
  // Safe cast: this function is only called after a successful parseAnthropicRequest
  const body = rawBody as AnthropicRequestBody

  if (systemPrompt === null) {
    const result: Record<string, unknown> = { ...body }
    delete result.system
    return result
  }

  const original = body.system

  // No original system — set as string
  if (original === undefined) {
    return { ...body, system: systemPrompt }
  }

  // Original was a string — prepend our text
  if (typeof original === 'string') {
    return { ...body, system: `${systemPrompt}\n\n${original}` }
  }

  // Original was an array of blocks — prepend a new text block
  const injectionBlock: AnthropicSystemBlock = { type: 'text', text: systemPrompt }
  return { ...body, system: [injectionBlock, ...original] }
}
