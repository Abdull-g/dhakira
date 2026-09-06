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

  retrieval: {
    /**
     * Keep QMD's search models (query-expansion ~1.1 GB, embedding ~0.3 GB,
     * reranker ~0.6 GB — roughly 2 GB of RAM while resident) loaded for the
     * daemon's lifetime instead of QMD's default "dispose after 5 min idle".
     * Default true: the first recall after any pause otherwise reloads all three
     * inside the hook's 1.5 s budget and the user silently gets no memory (D2).
     * Set false on RAM-constrained machines; the 900 ms daemon deadline still
     * guarantees a BM25 answer inside the budget.
     */
    modelsResident: boolean
  }

  injection: {
    /** Hard ceiling for the ENTIRE injection block — all three layers SHARE this. */
    maxTokens: number
    /** Minimum relevance score to include a turn (0-1) */
    minRelevanceScore: number
    /** Recency boost factor (0 = no boost, 1 = strong boost) */
    recencyBoost: number
    /** Max turn pairs to inject */
    maxTurns: number
    /**
     * T08 soft cap (tokens) for the global identity layer. ADVISORY: the builder
     * keeps global whole (it's small + byte-compat); this guides the synthesizer
     * and documents the intended ~150-250 tok budget. Hosted tiers may raise it.
     */
    globalMaxTokens: number
    /**
     * T08 soft cap (tokens) for the scoped project-doc layer (~400-700). The
     * builder trims the project doc to this (Open-threads-first) so it cannot eat
     * the whole ceiling and starve Layer-1 turns. Hosted tiers may raise it.
     */
    projectMaxTokens: number
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
