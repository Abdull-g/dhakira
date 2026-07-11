import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  type GbnfJsonObjectSchema,
  getLlama,
  type Llama,
  LlamaChatSession,
  type LlamaGrammar,
  LlamaLogLevel,
  type LlamaModel,
  resolveModelFile,
} from 'node-llama-cpp'

import { createLogger } from '../utils/logger.js'
import type { LLMMessage, OpenAIResponse } from './extract.js'
import type { Extractor, ExtractorOptions } from './extractor.js'

type Result<T> = import('../proxy/types.js').Result<T>

const LOCAL_EXTRACTION_MODEL_URI =
  'hf:LiquidAI/LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M.gguf'
const LOCAL_EXTRACTION_MODEL_CACHE_DIR = join(homedir(), '.cache', 'dhakira', 'extraction-models')
const DEFAULT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_MAX_TOKENS = 1024

interface LocalLLMExtractorConfig {
  modelUri?: string
  modelCacheDir?: string
  inactivityTimeoutMs?: number
}

export class LocalLLMExtractor implements Extractor {
  private readonly logger = createLogger('extraction')
  private readonly modelUri: string
  private readonly modelCacheDir: string
  private readonly inactivityTimeoutMs: number

  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private modelLoadPromise: Promise<LlamaModel> | null = null
  private inactivityTimer: NodeJS.Timeout | null = null
  private activeExtractions = 0
  private disposed = false

  constructor(config: LocalLLMExtractorConfig = {}) {
    this.modelUri = config.modelUri ?? LOCAL_EXTRACTION_MODEL_URI
    this.modelCacheDir = config.modelCacheDir ?? LOCAL_EXTRACTION_MODEL_CACHE_DIR
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
  }

  async extract(
    messages: LLMMessage[],
    options: ExtractorOptions = {},
  ): Promise<Result<OpenAIResponse>> {
    if (this.disposed) {
      return { ok: false, error: new Error('LocalLLMExtractor has been disposed') }
    }

    this.activeExtractions++
    this.clearInactivityTimer()

    try {
      const model = await this.ensureModel()
      const context = await model.createContext()
      try {
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: getSystemPrompt(messages),
          autoDisposeSequence: true,
        })
        const text = await session.prompt(getUserPrompt(messages), {
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: options.temperature ?? 0,
        })

        return {
          ok: true,
          value: {
            choices: [{ message: { content: text } }],
          },
        }
      } finally {
        await context.dispose()
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
    } finally {
      this.activeExtractions--
      this.scheduleInactivityUnload()
    }
  }

  /**
   * Model-agnostic generation seam for the harness (additive; does not touch `extract()`).
   *
   * When `jsonSchema` is provided, output is grammar-constrained via
   * node-llama-cpp's `createGrammarForJsonSchema` so the model can only emit
   * JSON matching the schema. Keeps ALL node-llama-cpp + grammar code in this
   * layer — the harness core stays llama-free.
   *
   * Returns the raw generated text plus whether constraint was applied. Throws
   * on failure (the harness contract: `ModelHandle.generate` resolves text or throws).
   */
  async generate(
    prompt: string,
    opts: {
      jsonSchema?: Readonly<Record<string, unknown>>
      maxTokens?: number
      temperature?: number
    } = {},
  ): Promise<{ text: string; constrained: boolean }> {
    if (this.disposed) {
      throw new Error('LocalLLMExtractor has been disposed')
    }

    this.activeExtractions++
    this.clearInactivityTimer()

    try {
      const model = await this.ensureModel()
      const context = await model.createContext()
      try {
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          autoDisposeSequence: true,
        })

        let grammar: LlamaGrammar | undefined
        if (opts.jsonSchema) {
          const llama = await this.ensureLlama()
          grammar = await llama.createGrammarForJsonSchema(
            opts.jsonSchema as unknown as GbnfJsonObjectSchema,
          )
        }

        // node-llama-cpp guidance: when generation is grammar-constrained, cap at the
        // context size rather than a small fixed limit. The grammar already bounds the
        // OUTPUT SHAPE, so a low cap only risks truncating a valid JSON object mid-emit
        // (→ parse fail → avoidable harness retry / dropped facts). The fixed
        // DEFAULT_MAX_TOKENS floor stays for UNCONSTRAINED generation, where a cap is the
        // only thing stopping a runaway ramble. An explicit caller maxTokens always wins.
        const grammarMaxTokens = opts.maxTokens ?? context.contextSize
        const text = await session.prompt(prompt, {
          grammar,
          maxTokens: grammar ? grammarMaxTokens : (opts.maxTokens ?? DEFAULT_MAX_TOKENS),
          temperature: opts.temperature ?? 0,
        })

        return { text, constrained: grammar !== undefined }
      } finally {
        await context.dispose()
      }
    } finally {
      this.activeExtractions--
      this.scheduleInactivityUnload()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearInactivityTimer()
    await this.unloadModel()
    if (this.llama) {
      await this.llama.dispose()
      this.llama = null
    }
  }

  private async ensureModel(): Promise<LlamaModel> {
    if (this.model) return this.model
    if (this.modelLoadPromise) return this.modelLoadPromise

    this.modelLoadPromise = this.loadModel()
    try {
      this.model = await this.modelLoadPromise
      return this.model
    } finally {
      this.modelLoadPromise = null
    }
  }

  private async loadModel(): Promise<LlamaModel> {
    this.logger.info('Loading local extraction model')
    const llama = await this.ensureLlama()
    const modelPath = await this.resolveModelPath()
    return llama.loadModel({ modelPath })
  }

  private async ensureLlama(): Promise<Llama> {
    if (this.llama) return this.llama
    this.llama = await getLlama({
      build: 'autoAttempt',
      logLevel: LlamaLogLevel.error,
    })
    if (this.llama.gpu === false) {
      this.logger.warn('No GPU acceleration for local extraction model; using CPU')
    }
    return this.llama
  }

  private async resolveModelPath(): Promise<string> {
    let lastPercent = -1

    return resolveModelFile(this.modelUri, {
      directory: this.modelCacheDir,
      cli: false,
      onProgress: ({ downloadedSize, totalSize }) => {
        const percent = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : 0
        if (percent === lastPercent && percent !== 100) return

        lastPercent = percent
        const total = totalSize > 0 ? ` / ${formatBytes(totalSize)}` : ''
        process.stdout.write(
          `Downloading local extraction model... ${percent}% (${formatBytes(downloadedSize)}${total})\n`,
        )
      },
    })
  }

  private scheduleInactivityUnload(): void {
    if (this.disposed || this.inactivityTimeoutMs <= 0 || !this.model) return

    this.clearInactivityTimer()
    this.inactivityTimer = setTimeout(() => {
      if (this.activeExtractions > 0) {
        this.scheduleInactivityUnload()
        return
      }

      this.unloadModel().catch((err) => {
        this.logger.warn('Failed to unload local extraction model', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.inactivityTimeoutMs)
    this.inactivityTimer.unref()
  }

  private clearInactivityTimer(): void {
    if (!this.inactivityTimer) return
    clearTimeout(this.inactivityTimer)
    this.inactivityTimer = null
  }

  private async unloadModel(): Promise<void> {
    this.clearInactivityTimer()
    if (this.model) {
      await this.model.dispose()
      this.model = null
    }
    this.modelLoadPromise = null
  }
}

function getSystemPrompt(messages: LLMMessage[]): string | undefined {
  return messages.find((message) => message.role === 'system')?.content
}

function getUserPrompt(messages: LLMMessage[]): string {
  const nonSystemMessages = messages.filter((message) => message.role !== 'system')
  if (nonSystemMessages.length === 1) return nonSystemMessages[0].content

  // TODO(v0.2.9): If multi-message local extraction becomes real, use
  // session.setChatHistory() instead of flattening role-tagged text.
  return nonSystemMessages.map((message) => `${roleLabel(message.role)}: ${message.content}`).join('\n')
}

function roleLabel(role: LLMMessage['role']): string {
  if (role === 'user') return 'User'
  return 'Assistant'
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0MB'
  return `${Math.round(bytes / 1024 / 1024)}MB`
}
