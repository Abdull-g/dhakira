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

    extraction: {
      schedule: '0 2 * * *',
      model: 'gpt-4o-mini',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
    },

    injection: {
      maxTokens: 1800,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
    },

    incognito: false,
  }
}
