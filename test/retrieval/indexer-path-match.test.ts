/**
 * Path matching verification — the most critical test for the indexer.
 *
 * This test verifies that our handelize implementation produces the correct
 * database paths for turn pair files. The path must match what QMD's
 * reindexCollection would compute, otherwise we get duplicate index entries.
 *
 * When QMD is updated, run the verification script (scripts/verify-handelize.mjs)
 * to confirm our implementation still matches.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { handelize } from '../../src/retrieval/indexer.ts'

/**
 * Replicates the path computation from our indexer module.
 */
function computeRelativePath(filePath: string, walletDir: string): string {
  const turnsRoot = join(walletDir, 'turns') + '/'
  return filePath.startsWith(turnsRoot)
    ? filePath.slice(turnsRoot.length)
    : filePath
}

describe('path matching: direct insert vs store.update()', () => {
  const walletDir = '/home/user/.dhakira'

  const testCases = [
    {
      name: 'standard turn pair',
      absolutePath: `${walletDir}/turns/2026-03-27/conv_abc123def456-0.md`,
      expectedRelative: '2026-03-27/conv_abc123def456-0.md',
      expectedHandelized: '2026-03-27/conv-abc123def456-0.md',
    },
    {
      name: 'multi-digit turn index',
      absolutePath: `${walletDir}/turns/2026-03-27/conv_abc123def456-15.md`,
      expectedRelative: '2026-03-27/conv_abc123def456-15.md',
      expectedHandelized: '2026-03-27/conv-abc123def456-15.md',
    },
    {
      name: 'different date',
      absolutePath: `${walletDir}/turns/2026-01-01/conv_000000000000-0.md`,
      expectedRelative: '2026-01-01/conv_000000000000-0.md',
      expectedHandelized: '2026-01-01/conv-000000000000-0.md',
    },
    {
      name: 'year boundary',
      absolutePath: `${walletDir}/turns/2026-12-31/conv_ffffffffffff-99.md`,
      expectedRelative: '2026-12-31/conv_ffffffffffff-99.md',
      expectedHandelized: '2026-12-31/conv-ffffffffffff-99.md',
    },
  ]

  for (const tc of testCases) {
    it(`should compute correct relative path: ${tc.name}`, () => {
      const relative = computeRelativePath(tc.absolutePath, walletDir)
      expect(relative).toBe(tc.expectedRelative)
    })

    it(`should handelize correctly: ${tc.name}`, () => {
      const relative = computeRelativePath(tc.absolutePath, walletDir)
      const result = handelize(relative)
      expect(result).toBe(tc.expectedHandelized)
    })
  }

  it('should handle walletDir with expanded tilde', () => {
    const expandedWallet = '/Users/abdullah/.dhakira'
    const filePath = `${expandedWallet}/turns/2026-03-27/conv_abc-0.md`
    const relative = computeRelativePath(filePath, expandedWallet)
    expect(relative).toBe('2026-03-27/conv_abc-0.md')
  })

  // Verify key handelize behaviors for our naming conventions
  it('should lowercase all characters', () => {
    const result = handelize('2026-03-27/CONV_ABC-0.md')
    expect(result).toBe('2026-03-27/conv-abc-0.md')
  })

  it('should replace underscores with dashes', () => {
    const result = handelize('2026-03-27/conv_abc123-0.md')
    expect(result).toContain('conv-abc123')
  })

  it('should preserve .md extension', () => {
    const result = handelize('2026-03-27/conv_abc-0.md')
    expect(result.endsWith('.md')).toBe(true)
  })

  it('should preserve date directory structure', () => {
    const result = handelize('2026-03-27/conv_abc-0.md')
    expect(result).toMatch(/^2026-03-27\//)
  })

  it('should handle consecutive special characters', () => {
    const result = handelize('2026-03-27/conv__abc--0.md')
    // Multiple dashes collapse: conv-abc-0.md
    expect(result).not.toContain('--')
  })
})
