// Phase 1: extract facts from a conversation via LLM

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { WalletConfig } from '../config/schema.js'
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'
import { EXTRACT_PROMPT, fillTemplate } from './prompts.js'
import type { ExtractedFact, ExtractionResult } from './types.js'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message: string
    type: string
  }
}

interface AnthropicResponse {
  content?: Array<{
    type: string
    text?: string
  }>
  error?: {
    type: string
    message: string
  }
}

type LLMResponse = OpenAIResponse | AnthropicResponse

function isAnthropicUrl(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com')
}

/** Normalize any LLM response to OpenAIResponse shape for downstream code */
function normalizeResponse(raw: LLMResponse, isAnthropic: boolean): OpenAIResponse {
  if (!isAnthropic) return raw as OpenAIResponse
  const ar = raw as AnthropicResponse
  if (ar.error) {
    return { error: { message: ar.error.message, type: ar.error.type } }
  }
  const text = ar.content?.find((c) => c.type === 'text')?.text ?? ''
  return { choices: [{ message: { content: text } }] }
}

interface ExtractLLMPayload {
  facts: ExtractedFact[]
  summary_update: string
}

/** Resolve "env:VAR_NAME" API key syntax to the actual value */
export function resolveApiKey(apiKey: string): string {
  if (apiKey.startsWith('env:')) {
    const varName = apiKey.slice(4)
    return process.env[varName] ?? ''
  }
  return apiKey
}

/**
 * Make a raw HTTP(S) POST to an OpenAI-compatible /chat/completions endpoint.
 * Chooses node:https or node:http based on the URL protocol.
 */
export async function callLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LLMMessage[],
): Promise<Result<OpenAIResponse>> {
  const resolvedKey = resolveApiKey(apiKey)
  const anthropic = isAnthropicUrl(baseUrl)

  // Build endpoint URL and request body based on provider
  let endpoint: string
  let body: string
  let headers: Record<string, string>

  if (anthropic) {
    endpoint = `${baseUrl.replace(/\/$/, '')}/messages`

    // Separate system message from user/assistant messages
    const systemMsg = messages.find((m) => m.role === 'system')
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

    const payload: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages: nonSystemMsgs,
      temperature: 0,
    }
    if (systemMsg) {
      payload.system = systemMsg.content
    }
    body = JSON.stringify(payload)
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': resolvedKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': String(Buffer.byteLength(body)),
    }
  } else {
    endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`
    body = JSON.stringify({
      model,
      messages,
      temperature: 0,
    })
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolvedKey}`,
      'Content-Length': String(Buffer.byteLength(body)),
    }
  }

  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      resolve({ ok: false, error: new Error(`Invalid baseUrl: ${baseUrl}`) })
      return
    }

    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest

    const req = requestFn(
      url,
      {
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8')
          try {
            const parsed = JSON.parse(rawText) as LLMResponse
            resolve({ ok: true, value: normalizeResponse(parsed, anthropic) })
          } catch {
            resolve({
              ok: false,
              error: new Error(`Invalid JSON from LLM: ${rawText.slice(0, 200)}`),
            })
          }
        })
        res.on('error', (err: Error) => resolve({ ok: false, error: err }))
      },
    )

    req.on('error', (err: Error) => resolve({ ok: false, error: err }))
    req.write(body)
    req.end()
  })
}

/** Extract the text content from an OpenAI response */
export function extractContent(response: OpenAIResponse): Result<string> {
  if (response.error) {
    return { ok: false, error: new Error(`LLM API error: ${response.error.message}`) }
  }
  const content = response.choices?.[0]?.message?.content
  if (!content) {
    return { ok: false, error: new Error('LLM returned empty content') }
  }
  return { ok: true, value: content }
}

function isValidCategory(value: string): value is ExtractedFact['category'] {
  return ['IDENTITY', 'PREFERENCE', 'CONTEXT', 'RELATIONSHIP', 'SKILL', 'EVENT'].includes(value)
}

function isValidConfidence(value: string): value is ExtractedFact['confidence'] {
  return ['HIGH', 'MEDIUM', 'LOW'].includes(value)
}

/** Strip markdown code fences (```json ... ```) if present */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m)
  return match ? match[1].trim() : trimmed
}

function parseExtractPayload(content: string): Result<ExtractLLMPayload> {
  const cleaned = stripCodeFences(content)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      error: new Error(`Failed to parse extraction JSON: ${cleaned.slice(0, 200)}`),
    }
  }

  if (!Array.isArray(parsed.facts)) {
    return { ok: false, error: new Error('Extraction response missing facts array') }
  }

  const facts: ExtractedFact[] = []
  for (const rawFact of parsed.facts as Array<Record<string, unknown>>) {
    const text = String(rawFact.text ?? '').trim()
    const category = String(rawFact.category ?? '')
    const confidence = String(rawFact.confidence ?? '')
    if (!text || !isValidCategory(category) || !isValidConfidence(confidence)) continue
    facts.push({ text, category, confidence })
  }

  return {
    ok: true,
    value: { facts, summary_update: String(parsed.summary_update ?? '').trim() },
  }
}

/**
 * Phase 1: Extract personal facts from a conversation markdown string.
 *
 * Calls the configured LLM with EXTRACT_PROMPT and parses the JSON response
 * into an ExtractionResult containing facts and a rolling summary update.
 */
export async function extractFacts(
  conversation: string,
  existingProfile: string,
  rollingSummary: string,
  config: WalletConfig['extraction'],
  conversationId: string,
  conversationDate?: string,
): Promise<Result<ExtractionResult>> {
  const logger = createLogger('extraction')

  const prompt = fillTemplate(EXTRACT_PROMPT, {
    conversation,
    existing_profile: existingProfile.trim() || '(none)',
    rolling_summary: rollingSummary.trim() || '(none)',
    conversation_date: conversationDate ?? new Date().toISOString().split('T')[0],
  })

  logger.info('Extracting facts', { conversationId })

  const llmResult = await callLLM(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])

  if (!llmResult.ok) {
    logger.error('LLM call failed during extraction', {
      conversationId,
      error: llmResult.error.message,
    })
    return llmResult
  }

  const contentResult = extractContent(llmResult.value)
  if (!contentResult.ok) {
    logger.error('Empty LLM response during extraction', {
      conversationId,
      error: contentResult.error.message,
    })
    return contentResult
  }

  const parseResult = parseExtractPayload(contentResult.value)
  if (!parseResult.ok) {
    logger.error('Failed to parse extraction response', {
      conversationId,
      error: parseResult.error.message,
    })
    return parseResult
  }

  const { facts, summary_update } = parseResult.value
  logger.info('Facts extracted', { conversationId, factCount: facts.length })

  return {
    ok: true,
    value: { facts, summaryUpdate: summary_update, conversationId },
  }
}
