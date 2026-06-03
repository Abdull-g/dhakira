import { describe, expect, it } from 'vitest'

import { readMemoryInvalidatedAt } from '../../src/extraction/runner.ts'

describe('readMemoryInvalidatedAt — backward-compatible read', () => {
  it('file with `invalidatedAt: null` literal → null (still active)', () => {
    const content = [
      '---',
      'id: mem_1',
      'salienceTier: standard',
      'invalidatedAt: null',
      'expiresAt: null',
      '---',
      '',
      'body',
    ].join('\n')
    expect(readMemoryInvalidatedAt(content)).toBeNull()
  })

  it('OLD memory file with NO invalidatedAt line → null', () => {
    const oldContent = [
      '---',
      'id: mem_old',
      'salienceTier: standard',
      '---',
      '',
      'Prefers tea over coffee',
    ].join('\n')
    expect(readMemoryInvalidatedAt(oldContent)).toBeNull()
  })

  it('a valid ISO invalidatedAt → parsed Date', () => {
    const content = ['---', 'invalidatedAt: 2026-05-01T00:00:00.000Z', '---', '', 'body'].join('\n')
    expect(readMemoryInvalidatedAt(content)?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('missing/empty frontmatter → null', () => {
    expect(readMemoryInvalidatedAt('no frontmatter at all')).toBeNull()
  })

  it('unparseable invalidatedAt value → null (never throws)', () => {
    const content = ['---', 'invalidatedAt: not-a-date', '---', '', 'body'].join('\n')
    expect(readMemoryInvalidatedAt(content)).toBeNull()
  })
})
