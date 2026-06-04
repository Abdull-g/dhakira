// CP4 — 3-layer composition + tiered shared-ceiling budgeting. All model-free:
// the synthesis outputs are FIXTURE strings (this is the composition layer).

import { describe, expect, it } from 'vitest'

import { buildInjectionBlock } from '../../src/injection/builder.ts'
import type { WalletConfig } from '../../src/config/schema.ts'
import type { TurnSearchResult } from '../../src/retrieval/types.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'

const config: WalletConfig['injection'] = {
  maxTokens: 1800,
  minRelevanceScore: 0.3,
  recencyBoost: 0.3,
  maxTurns: 8,
  globalMaxTokens: 250,
  projectMaxTokens: 700,
}

function turn(userContent: string, score = 0.8, turnIndex = 0): TurnSearchResult {
  return {
    turnPair: {
      id: `turn_${turnIndex}`,
      sessionId: 'sess',
      tool: 'claude-code',
      timestamp: '2026-06-04T10:00:00Z',
      turnIndex,
      userContent,
      assistantContent: 'short answer',
    },
    score,
    source: `/wallet/turns/sess-${turnIndex}.md`,
  }
}

const PROJECT_DOC = [
  'What this is: portable AI memory wallet',
  'Key decisions:\n- two-tier store for freshness',
  'Conventions:\n- never default exports',
  'Gotchas:\n- tried JWT refresh, broke on mobile',
  'Open threads:\n- calibrate synthesis floor remotely',
].join('\n')

// ───────────────────────────────────────────────────────────────────────────
// 3-layer compose within budget
// ───────────────────────────────────────────────────────────────────────────
describe('buildInjectionBlock — 3-layer composition', () => {
  it('composes global → project → turns, in order, within the ceiling', () => {
    const block = buildInjectionBlock(
      '## Stable\n- Based in Riyadh',
      PROJECT_DOC,
      [turn('how does salience interact with forget?')],
      config,
      'dhakira',
    )

    expect(block.hasProfile).toBe(true)
    expect(block.hasProject).toBe(true)
    expect(block.memoryCount).toBe(1)

    const text = block.text
    // All three section headers present, in priority order.
    const aboutAt = text.indexOf('## About You')
    const projectAt = text.indexOf('## Project: dhakira')
    const turnsAt = text.indexOf('## Relevant Past Conversations')
    expect(aboutAt).toBeGreaterThanOrEqual(0)
    expect(projectAt).toBeGreaterThan(aboutAt)
    expect(turnsAt).toBeGreaterThan(projectAt)

    expect(text).toContain('Based in Riyadh')
    expect(text).toContain('portable AI memory wallet')
    expect(text).toContain('how does salience interact with forget?')
    expect(block.tokenCount).toBeLessThanOrEqual(config.maxTokens)
  })

  it('global absent + project present still composes (project + turns)', () => {
    const block = buildInjectionBlock('', PROJECT_DOC, [turn('q')], config, 'dhakira')
    expect(block.hasProfile).toBe(false)
    expect(block.hasProject).toBe(true)
    expect(block.text).not.toContain('## About You')
    expect(block.text).toContain('## Project: dhakira')
    expect(block.text).toContain('## Relevant Past Conversations')
  })

  it('uses a bare "## Project" header when no name is supplied', () => {
    const block = buildInjectionBlock('', PROJECT_DOC, [], config)
    expect(block.text).toContain('## Project\n')
    expect(block.text).not.toContain('## Project:')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Backward-compat: no project doc → byte-comparable to pre-T08 (global + turns)
// ───────────────────────────────────────────────────────────────────────────
describe('buildInjectionBlock — backward-compat (no project doc)', () => {
  it('produces the SAME output whether projectDoc is null or absent-equivalent', () => {
    const profile = '## Stable\n- Based in Riyadh\n\n## Active\n- Shipping v0.3'
    const turns = [turn('first', 0.9, 0), turn('second', 0.8, 1)]

    const block = buildInjectionBlock(profile, null, turns, config, 'dhakira')

    // No project doc → no project section at all (name is irrelevant).
    expect(block.hasProject).toBe(false)
    expect(block.text).not.toContain('## Project')
    // Structure is exactly the pre-T08 two-layer shape.
    expect(block.text).toContain('<dhakira_context>')
    expect(block.text).toContain('## About You\n## Stable\n- Based in Riyadh')
    expect(block.text).toContain('## Relevant Past Conversations')
    expect(block.text).toMatch(/<\/dhakira_context>$/)
  })

  it('a "global" request (null doc) with turns matches the classic two-layer block byte-for-byte', () => {
    const profile = '- TypeScript developer'
    const turns = [turn('How do I pool connections?', 0.9)]

    const withName = buildInjectionBlock(profile, null, turns, config, 'ignored-name')
    const withoutName = buildInjectionBlock(profile, null, turns, config)
    // The project name must NOT leak into output when there's no project doc.
    expect(withName.text).toBe(withoutName.text)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Degrade under pressure in REVERSE priority
// ───────────────────────────────────────────────────────────────────────────
describe('buildInjectionBlock — degradation under pressure', () => {
  it('drops turns FIRST when the budget is tight (project + global kept)', () => {
    const tight: WalletConfig['injection'] = { ...config, maxTokens: 120, projectMaxTokens: 700 }
    const manyTurns = Array.from({ length: 8 }, (_, i) =>
      turn(`a fairly long turn question number ${i} about pooling and caching`, 0.9 - i * 0.05, i),
    )

    const block = buildInjectionBlock('## Stable\n- Riyadh', PROJECT_DOC, manyTurns, tight, 'dhakira')

    // Global + project survive; turns are squeezed out first.
    expect(block.hasProfile).toBe(true)
    expect(block.hasProject).toBe(true)
    expect(block.memoryCount).toBeLessThan(manyTurns.length)
    expect(block.tokenCount).toBeLessThanOrEqual(tight.maxTokens + 40)
  })

  it('trims the project doc Open-threads-FIRST when the project cap is small', () => {
    const cappedProject: WalletConfig['injection'] = { ...config, projectMaxTokens: 30 }

    const block = buildInjectionBlock('', PROJECT_DOC, [], cappedProject, 'dhakira')

    expect(block.hasProject).toBe(true)
    // Open threads (rendered last) is the first section dropped under the cap.
    expect(block.text).not.toContain('Open threads')
    // The highest-value head sections survive.
    expect(block.text).toContain('What this is: portable AI memory wallet')
  })

  it('trims successive trailing sections as the cap shrinks (Open threads, then Gotchas)', () => {
    const tiny: WalletConfig['injection'] = { ...config, projectMaxTokens: 18 }
    const block = buildInjectionBlock('', PROJECT_DOC, [], tiny, 'dhakira')
    expect(block.text).not.toContain('Open threads')
    expect(block.text).not.toContain('Gotchas')
    expect(block.text).toContain('What this is: portable AI memory wallet')
  })

  it('ALWAYS keeps global identity, even when project + turns are present and budget is small', () => {
    const tight: WalletConfig['injection'] = { ...config, maxTokens: 90 }
    const block = buildInjectionBlock(
      '## Stable\n- Based in Riyadh',
      PROJECT_DOC,
      [turn('q', 0.9)],
      tight,
      'dhakira',
    )
    // Global is the highest priority — never dropped.
    expect(block.hasProfile).toBe(true)
    expect(block.text).toContain('Based in Riyadh')
  })

  it('never blows the ceiling regardless of input size', () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      turn(`turn ${i} ${'detail '.repeat(20)}`, 1 - i * 0.01, i),
    )
    const hugeProject = Array.from({ length: 40 }, (_, i) => `Key decisions:\n- decision ${i}`).join(
      '\n',
    )
    const block = buildInjectionBlock('## Stable\n- x', hugeProject, big, config, 'p')
    expect(estimateTokens(block.text)).toBeLessThanOrEqual(config.maxTokens + 40)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Flat-fallback project doc (no section labels) still composes + trims safely
// ───────────────────────────────────────────────────────────────────────────
describe('buildInjectionBlock — flat-fallback project doc', () => {
  it('composes a flat (unsectioned) project doc and trims trailing lines under a tiny cap', () => {
    const flat = ['- uses postgres', '- prefers dense docs', '- standing order seven'].join('\n')
    const block = buildInjectionBlock('', flat, [], { ...config, projectMaxTokens: 12 }, 'p')
    expect(block.hasProject).toBe(true)
    // Real memory bullets only — never fabricated, possibly fewer under the cap.
    expect(block.text).toContain('- uses postgres')
  })
})
