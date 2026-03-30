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

  extraction: {
    /** Cron expression for extraction schedule */
    schedule: string
    /** Model to use for extraction */
    model: string
    /** API key for extraction LLM (can use env: prefix) */
    apiKey: string
    /** Base URL for extraction LLM API */
    baseUrl: string
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
