// Config type definitions for Dhakira

export interface WalletConfig {
  /** Directory where all wallet data lives */
  walletDir: string

  proxy: {
    port: number
    host: string
  }

  dashboard: {
    port: number
    host: string
  }

  tools: ToolConfig[]

  capture: {
    /** Capture pipeline implementation to use */
    pipelineVersion: 'v1' | 'v2'
    /** Enable verbose capture-stage diagnostics */
    debug: boolean
  }

  extraction: {
    /** Model to use for extraction */
    model: string
    /** API key for extraction LLM (can use env: prefix) */
    apiKey: string
    /** Base URL for extraction LLM API */
    baseUrl: string
    /**
     * Run an off-line consolidation sweep after extraction (Step 5). Default
     * false — the engine + `dhakira consolidate` CLI ship now; auto-in-pipeline
     * stays DARK until it's been observed on real data.
     */
    consolidate?: boolean
  }

  injection: {
    /** Max tokens for entire injection block (profile + turns) */
    maxTokens: number
    /** Minimum relevance score to include a turn (0-1) */
    minRelevanceScore: number
    /** Recency boost factor (0 = no boost, 1 = strong boost) */
    recencyBoost: number
    /** Max turn pairs to inject */
    maxTurns: number
  }

  /** Global incognito mode */
  incognito: boolean
}

export interface ToolConfig {
  /** Display name for this tool */
  name: string
  /** API format this tool uses */
  provider: 'openai' | 'anthropic'
  /** API key (supports "env:VAR_NAME" syntax) */
  apiKey: string
  /** The real provider URL to forward to */
  baseUrl: string
}
