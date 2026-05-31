// Phase 1: extract facts from a conversation via LLM

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { WalletConfig } from '../config/schema.js'
import { ModelHarness } from '../harness/harness.js'
import { LlamaHandle } from '../harness/llama-handle.js'
import type { ModelHandle } from '../harness/model-handle.js'
import type { HarnessTask } from '../harness/types.js'
import { createLogger } from '../utils/logger.js'
import { ExternalLLMExtractor } from './external-extractor.js'
import type { Extractor, ExtractorOptions } from './extractor.js'
import { LocalLLMExtractor } from './local-extractor.js'
import { EXTRACT_PROMPT, fillTemplate } from './prompts.js'
import type { ExtractedFact, ExtractionResult } from './types.js'

type Result<T> = import('../proxy/types.js').Result<T>

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAIResponse {
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

export async function callExtractionLLM(
  config: WalletConfig['extraction'],
  messages: LLMMessage[],
  options?: ExtractorOptions,
): Promise<Result<OpenAIResponse>> {
  const extractor = resolveExtractor(config)
  return extractor.extract(messages, options)
}

let localExtractor: LocalLLMExtractor | null = null

export function resolveExtractor(config: WalletConfig['extraction']): Extractor {
  const resolved = resolveApiKey(config.apiKey)
  if (resolved.trim().length > 0) {
    return new ExternalLLMExtractor({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    })
  }

  localExtractor ??= new LocalLLMExtractor()
  return localExtractor
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

/**
 * Validate + coerce already-parsed extraction JSON into an ExtractLLMPayload.
 *
 * This is the post-parse half of the old `parseExtractPayload` (fence-stripping
 * + JSON.parse now live in the harness run loop). Behavior is byte-identical on
 * good input: invalid facts are filtered by category/confidence, and a missing
 * `facts` array yields null (which the harness surfaces as a hard fail for the
 * unconstrained path, or floors for the constrained path).
 */
function validateExtractPayload(parsed: unknown): ExtractLLMPayload | null {
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.facts)) return null

  const facts: ExtractedFact[] = []
  for (const rawFact of obj.facts as Array<Record<string, unknown>>) {
    const text = String(rawFact.text ?? '').trim()
    const category = String(rawFact.category ?? '')
    const confidence = String(rawFact.confidence ?? '')
    if (!text || !isValidCategory(category) || !isValidConfidence(confidence)) continue
    facts.push({ text, category, confidence })
  }

  return { facts, summary_update: String(obj.summary_update ?? '').trim() }
}

/** JSON-schema describing the extraction payload (constrains LOCAL grammar generation). */
const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: {
            enum: ['IDENTITY', 'PREFERENCE', 'CONTEXT', 'RELATIONSHIP', 'SKILL', 'EVENT'],
          },
          confidence: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
      },
    },
    summary_update: { type: 'string' },
  },
} as const

/**
 * The extraction task run through the harness.
 *
 * `floor` ({ facts: [], summary_update: '' }) only fires for a constrained
 * (local) handle whose model stuttered — the SAFE floor that writes an empty
 * wallet rather than fabricating facts (addresses old Bug A). The unconstrained
 * (external) path never floors: a wrong-shape response is a genuine error,
 * surfaced via `failureMessage` (preserving the legacy error string).
 */
const extractTask: HarnessTask<ExtractLLMPayload> = {
  name: 'extract',
  schema: {
    jsonSchema: EXTRACT_JSON_SCHEMA,
    validate: validateExtractPayload,
  },
  floor: () => ({ facts: [], summary_update: '' }),
  failureMessage: 'Extraction response missing facts array',
}

/**
 * ModelHandle over an Extractor that CANNOT enforce grammar constraints
 * (external HTTP models). Delegates to `extract()` + `extractContent()` and
 * throws on infrastructure failure (the harness treats that as terminal).
 */
class UnconstrainedExtractorHandle implements ModelHandle {
  constructor(private readonly extractor: Extractor) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number },
  ): Promise<{ text: string; constrained: boolean }> {
    const result = await this.extractor.extract([{ role: 'user', content: prompt }], {
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    })
    if (!result.ok) throw result.error

    const content = extractContent(result.value)
    if (!content.ok) throw content.error

    return { text: content.value, constrained: false }
  }

  supportsConstraint(): boolean {
    return false
  }
}

/** Build the right ModelHandle for the resolved extractor (local = grammar-capable). */
function buildHandle(extractor: Extractor): ModelHandle {
  if (extractor instanceof LocalLLMExtractor) {
    return new LlamaHandle(extractor)
  }
  return new UnconstrainedExtractorHandle(extractor)
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
  conversationDate: string | undefined,
): Promise<Result<ExtractionResult>> {
  const logger = createLogger('extraction')

  const prompt = fillTemplate(EXTRACT_PROMPT, {
    conversation,
    existing_profile: existingProfile.trim() || '(none)',
    rolling_summary: rollingSummary.trim() || '(none)',
    conversation_date: conversationDate ?? new Date().toISOString().split('T')[0],
  })

  logger.info('Extracting facts', { conversationId })

  // Wire extraction through the model-control harness: grammar-constrained +
  // retry + SAFE floor for the local model, validate-only (byte-identical to
  // the legacy path) for external HTTP models.
  const handle = buildHandle(resolveExtractor(config))
  const harness = new ModelHarness(handle)
  const runResult = await harness.run(extractTask, prompt, {
    maxAttempts: handle.supportsConstraint() ? 2 : 1,
  })

  if (!runResult.ok) {
    logger.error('Extraction failed', {
      conversationId,
      error: runResult.error.message,
    })
    return runResult
  }

  const { facts, summary_update } = runResult.value.value
  logger.info('Facts extracted', { conversationId, factCount: facts.length })

  return {
    ok: true,
    value: { facts, summaryUpdate: summary_update, conversationId },
  }
}
