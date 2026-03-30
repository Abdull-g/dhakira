import { describe, expect, it } from 'vitest'
import { buildInjectionBlock } from '../../src/injection/builder.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'
import type { TurnSearchResult } from '../../src/retrieval/types.ts'
import type { WalletConfig } from '../../src/config/schema.ts'

const defaultConfig: WalletConfig['injection'] = {
  maxTokens: 2000,
  minRelevanceScore: 0.3,
  recencyBoost: 0.3,
  maxTurns: 8,
}

function makeTurnResult(
  overrides: {
    userContent?: string
    assistantContent?: string
    timestamp?: string
    sessionId?: string
    turnIndex?: number
  } = {},
  score = 0.8,
): TurnSearchResult {
  return {
    turnPair: {
      id: 'turn_001',
      sessionId: overrides.sessionId ?? 'sess_001',
      tool: 'claude-code',
      timestamp: overrides.timestamp ?? '2026-03-20T10:00:00Z',
      turnIndex: overrides.turnIndex ?? 0,
      userContent: overrides.userContent ?? 'How do I implement connection pooling?',
      assistantContent:
        overrides.assistantContent ??
        'Use pgBouncer with pool_mode=transaction for best performance.',
    },
    score,
    source: '/wallet/turns/2026-03-20/sess_001-0.md',
  }
}

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — empty inputs', () => {
  it('returns empty block when profile is empty and no search results', () => {
    const block = buildInjectionBlock('', [], defaultConfig)
    expect(block.text).toBe('')
    expect(block.tokenCount).toBe(0)
    expect(block.memoryCount).toBe(0)
    expect(block.hasProfile).toBe(false)
  })

  it('returns empty block when profile is whitespace-only and no results', () => {
    const block = buildInjectionBlock('   \n  ', [], defaultConfig)
    expect(block.text).toBe('')
    expect(block.tokenCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — structure', () => {
  it('wraps output in <dhakira_context> tags', () => {
    const block = buildInjectionBlock('- TypeScript developer', [], defaultConfig)
    expect(block.text).toMatch(/^<dhakira_context>/)
    expect(block.text).toMatch(/<\/dhakira_context>$/)
  })

  it('includes ## About You section when profile is provided', () => {
    const block = buildInjectionBlock('- TypeScript developer', [], defaultConfig)
    expect(block.text).toContain('## About You')
    expect(block.text).toContain('- TypeScript developer')
    expect(block.hasProfile).toBe(true)
  })

  it('omits ## About You section when profile is empty', () => {
    const block = buildInjectionBlock('', [makeTurnResult()], defaultConfig)
    expect(block.text).not.toContain('## About You')
    expect(block.hasProfile).toBe(false)
  })

  it('always includes ## Relevant Past Conversations header', () => {
    const block = buildInjectionBlock('- TypeScript developer', [], defaultConfig)
    expect(block.text).toContain('## Relevant Past Conversations')
  })

  it('includes both profile and turns sections when both provided', () => {
    const block = buildInjectionBlock('- TypeScript developer', [makeTurnResult()], defaultConfig)
    expect(block.text).toContain('## About You')
    expect(block.text).toContain('## Relevant Past Conversations')
    expect(block.hasProfile).toBe(true)
    expect(block.memoryCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Turn entry formatting
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — turn entry format', () => {
  it('prefixes each turn with the [YYYY-MM-DD] date', () => {
    const result = makeTurnResult({ timestamp: '2026-03-20T10:00:00Z' })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain('[2026-03-20]')
  })

  it('includes the user message prefixed with "You:"', () => {
    const result = makeTurnResult({ userContent: 'How do I use pgBouncer?' })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain('You: How do I use pgBouncer?')
  })

  it('includes the assistant response prefixed with →', () => {
    const result = makeTurnResult({
      assistantContent: 'Install pgBouncer and configure pool_mode.',
    })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain('→ Install pgBouncer and configure pool_mode.')
  })

  it('collapses multi-line user messages onto one line', () => {
    const result = makeTurnResult({ userContent: 'How do I\nuse pgBouncer?' })
    const block = buildInjectionBlock('', [result], defaultConfig)
    // The newline in the user content should be collapsed to a space
    expect(block.text).toContain('You: How do I use pgBouncer?')
    // Verify no newline sits between "How do I" and "use pgBouncer"
    expect(block.text).not.toMatch(/You: How do I\nuse pgBouncer/)
  })

  it('includes short assistant response verbatim', () => {
    const shortResponse = 'Use pgBouncer.'
    const result = makeTurnResult({ assistantContent: shortResponse })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain(shortResponse)
  })
})

// ---------------------------------------------------------------------------
// Long assistant response truncation
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — assistant response truncation', () => {
  // Build a response that clearly exceeds VERBATIM_TOKEN_LIMIT (~200 tokens = ~800 chars).
  // Each sentence is ~180 chars so 6 sentences ≈ 1100 chars ≈ 275 tokens, safely above the limit.
  const longResponse = [
    'First, you need to install pgBouncer via your operating system package manager or alternatively download and compile it from source code on the official pgBouncer GitHub repository.',
    'Second, create and carefully configure the pgbouncer.ini configuration file with all of your database host, port, database name, username, password, and connection pool mode settings.',
    'Third, set pool_mode to transaction mode for the best performance characteristics with stateless web applications, REST APIs, and microservices that do not rely on advisory locks.',
    'Fourth, configure the pool_size parameter carefully to control the maximum number of server-side connections that pgBouncer will allow to your PostgreSQL database at any given time.',
    'Fifth, after saving your configuration, restart the pgBouncer service using systemctl and verify it started successfully by checking the systemd journal output for any error messages.',
    'Sixth, you should monitor and tune the pool_size, max_client_conn, and server_idle_timeout settings based on your observed workload patterns and the max_connections limit of your database.',
  ].join(' ')

  it('truncates long assistant responses to first 2-3 sentences', () => {
    const result = makeTurnResult({ assistantContent: longResponse })
    const block = buildInjectionBlock('', [result], defaultConfig)
    // The sixth sentence should be cut off by the 3-sentence limit
    expect(block.text).not.toContain('Sixth, you should monitor')
  })

  it('preserves the first sentence of a long response', () => {
    const result = makeTurnResult({ assistantContent: longResponse })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain('First, you need to install pgBouncer')
  })

  it('does not truncate responses within the verbatim token limit', () => {
    const shortResponse = 'Use pgBouncer with pool_mode=transaction.'
    const result = makeTurnResult({ assistantContent: shortResponse })
    const block = buildInjectionBlock('', [result], defaultConfig)
    expect(block.text).toContain(shortResponse)
  })
})

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — token budget', () => {
  it('reports non-zero tokenCount when content is present', () => {
    const block = buildInjectionBlock('- TypeScript developer', [makeTurnResult()], defaultConfig)
    expect(block.tokenCount).toBeGreaterThan(0)
  })

  it('tokenCount matches estimateTokens of the output text', () => {
    const block = buildInjectionBlock('- TypeScript developer', [makeTurnResult()], defaultConfig)
    expect(block.tokenCount).toBe(estimateTokens(block.text))
  })

  it('counts included turns in memoryCount', () => {
    const results = [
      makeTurnResult({ userContent: 'Question A', turnIndex: 0 }, 0.9),
      makeTurnResult({ userContent: 'Question B', turnIndex: 1 }, 0.8),
    ]
    const block = buildInjectionBlock('', results, defaultConfig)
    expect(block.memoryCount).toBe(2)
  })

  it('stays within maxTokens budget when many results are provided', () => {
    const tinyConfig: WalletConfig['injection'] = {
      maxTokens: 80,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
    }
    const results = Array.from({ length: 10 }, (_, i) =>
      makeTurnResult(
        {
          userContent: `Question number ${i} about something specific`,
          assistantContent: `Answer number ${i} with details.`,
          turnIndex: i,
        },
        1 - i * 0.05,
      ),
    )
    const block = buildInjectionBlock('', results, tinyConfig)
    // Allow a small margin for the skeleton chrome which is always included
    expect(block.tokenCount).toBeLessThanOrEqual(tinyConfig.maxTokens + 30)
  })

  it('prefers highest-score turns when budget is tight', () => {
    const tinyConfig: WalletConfig['injection'] = {
      maxTokens: 120,
      minRelevanceScore: 0.3,
      recencyBoost: 0.3,
      maxTurns: 8,
    }
    const low = makeTurnResult({ userContent: 'Low relevance question', turnIndex: 0 }, 0.1)
    const high = makeTurnResult({ userContent: 'High relevance question', turnIndex: 1 }, 0.99)
    const block = buildInjectionBlock('', [low, high], tinyConfig)
    if (block.memoryCount === 1) {
      expect(block.text).toContain('High relevance question')
      expect(block.text).not.toContain('Low relevance question')
    }
  })

  it('respects maxTurns regardless of budget', () => {
    const strictConfig: WalletConfig['injection'] = {
      maxTokens: 10000,
      minRelevanceScore: 0.0,
      recencyBoost: 0.0,
      maxTurns: 2,
    }
    const results = Array.from({ length: 6 }, (_, i) =>
      makeTurnResult({ userContent: `Question ${i}`, turnIndex: i }, 0.9),
    )
    const block = buildInjectionBlock('', results, strictConfig)
    expect(block.memoryCount).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Profile-only injection (no matching turns)
// ---------------------------------------------------------------------------

describe('buildInjectionBlock — profile only', () => {
  it('injects profile with empty turns section when no results pass', () => {
    const block = buildInjectionBlock('- TypeScript developer', [], defaultConfig)
    expect(block.text).toContain('## About You')
    expect(block.text).toContain('- TypeScript developer')
    expect(block.text).toContain('## Relevant Past Conversations')
    expect(block.memoryCount).toBe(0)
    expect(block.hasProfile).toBe(true)
  })
})
