import { describe, expect, it } from 'vitest'

import { buildMemoryContent, readMemoryExpiresAt } from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    text: 'Senior backend engineer based in Riyadh',
    category: 'IDENTITY',
    confidence: 'HIGH',
    salienceScore: 0.92,
    salienceTier: 'core',
    source: 'conv_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

describe('expiresAt write/read round-trip', () => {
  it('a TTL’d expiresAt survives buildMemoryContent → readMemoryExpiresAt (ISO precision)', () => {
    const expiresAt = new Date('2026-07-01T00:00:00.000Z')
    const content = buildMemoryContent(record({ salienceTier: 'standard', expiresAt }))
    const readBack = readMemoryExpiresAt(content)
    expect(readBack).not.toBeNull()
    expect(readBack?.toISOString()).toBe(expiresAt.toISOString())
  })

  it('a durable (null) expiresAt round-trips to null', () => {
    const content = buildMemoryContent(record({ salienceTier: 'core', expiresAt: null }))
    // The written frontmatter contains the literal `expiresAt: null`.
    expect(content).toMatch(/^expiresAt: null$/m)
    expect(readMemoryExpiresAt(content)).toBeNull()
  })
})

describe('readMemoryExpiresAt — backward-compatible read', () => {
  it('OLD memory file with NO expiresAt line → null (durable)', () => {
    const oldContent = [
      '---',
      'id: mem_old',
      'category: PREFERENCE',
      'confidence: MEDIUM',
      'salienceScore: 0.5',
      'salienceTier: standard',
      'source: conv_old',
      'createdAt: 2025-01-01T00:00:00.000Z',
      'validFrom: 2025-01-01T00:00:00.000Z',
      'invalidatedAt: null',
      '---',
      '',
      'Prefers tea over coffee',
    ].join('\n')
    expect(readMemoryExpiresAt(oldContent)).toBeNull()
  })

  it('explicit `expiresAt: null` literal → null', () => {
    const content = ['---', 'id: mem_2', 'expiresAt: null', '---', '', 'body'].join('\n')
    expect(readMemoryExpiresAt(content)).toBeNull()
  })

  it('a valid ISO expiresAt → parsed Date', () => {
    const content = ['---', 'expiresAt: 2026-07-01T00:00:00.000Z', '---', '', 'body'].join('\n')
    expect(readMemoryExpiresAt(content)?.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('missing/empty frontmatter → null', () => {
    expect(readMemoryExpiresAt('no frontmatter at all')).toBeNull()
  })

  it('unparseable expiresAt value → null (never throws)', () => {
    const content = ['---', 'expiresAt: not-a-date', '---', '', 'body'].join('\n')
    expect(readMemoryExpiresAt(content)).toBeNull()
  })
})
