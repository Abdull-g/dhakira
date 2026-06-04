// Default configuration values

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WalletConfig } from './schema.js'

export function getDefaults(): WalletConfig {
  return {
    walletDir: join(homedir(), '.dhakira'),

    proxy: {
      port: 4100,
      host: '127.0.0.1',
    },

    dashboard: {
      port: 4101,
      host: '127.0.0.1',
    },

    tools: [],

    capture: {
      pipelineVersion: 'v2',
      debug: false,
    },

    extraction: {
      model: 'gpt-4o-mini',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      consolidate: false,
    },

    injection: {
      maxTokens: 1800,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
      // T08 per-layer soft caps within the shared 1800 ceiling. Conservative by
      // design ("injection budget is a FEATURE, not a quota to maximize"):
      // global ~250, project ~700, turns fill the remainder.
      globalMaxTokens: 250,
      projectMaxTokens: 700,
    },

    incognito: false,
  }
}
