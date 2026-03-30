import { describe, expect, it } from 'vitest'
import { computeContextFingerprint } from '../../src/proxy/fingerprint.ts'

describe('computeContextFingerprint', () => {
  describe('null / empty input', () => {
    it('should return "default" for null', () => {
      expect(computeContextFingerprint(null)).toBe('default')
    })

    it('should return "default" for empty string', () => {
      expect(computeContextFingerprint('')).toBe('default')
    })

    it('should return "default" for whitespace-only string', () => {
      expect(computeContextFingerprint('   \n\t  ')).toBe('default')
    })

    it('should return "default" when only a dhakira_context block is present', () => {
      const onlyBlock = '<dhakira_context>\n## About You\n- TypeScript dev\n</dhakira_context>'
      expect(computeContextFingerprint(onlyBlock)).toBe('default')
    })

    it('should return "default" when only whitespace remains after stripping the block', () => {
      const prompt = '   <dhakira_context>some stuff</dhakira_context>   '
      expect(computeContextFingerprint(prompt)).toBe('default')
    })
  })

  describe('output format', () => {
    it('should return a 12-character hex string for a valid prompt', () => {
      const result = computeContextFingerprint('You are a helpful assistant.')
      expect(result).toMatch(/^[0-9a-f]{12}$/)
    })

    it('should not return "default" for a non-empty prompt', () => {
      expect(computeContextFingerprint('You are a helpful assistant.')).not.toBe('default')
    })
  })

  describe('determinism', () => {
    it('should return the same fingerprint for the same prompt called twice', () => {
      const prompt = 'You are a TypeScript expert.'
      expect(computeContextFingerprint(prompt)).toBe(computeContextFingerprint(prompt))
    })

    it('should return different fingerprints for different prompts', () => {
      const a = computeContextFingerprint('You are a TypeScript expert.')
      const b = computeContextFingerprint('You are a Python expert.')
      expect(a).not.toBe(b)
    })
  })

  describe('dhakira_context block stripping', () => {
    it('should produce the same fingerprint with and without an injected block', () => {
      const base = 'You are an expert software engineer.'
      const withBlock =
        `${base}\n\n<dhakira_context>\n## About You\n- TypeScript dev\n</dhakira_context>`
      expect(computeContextFingerprint(base)).toBe(computeContextFingerprint(withBlock))
    })

    it('should strip multiple dhakira_context blocks before hashing', () => {
      const base = 'You are a helpful assistant.'
      const withTwoBlocks =
        `${base}<dhakira_context>first</dhakira_context>middle<dhakira_context>second</dhakira_context>`
      // Both "middle" text remains — fingerprint differs from base
      const withOneBlock = `${base}middle`
      expect(computeContextFingerprint(withTwoBlocks)).toBe(
        computeContextFingerprint(withOneBlock),
      )
    })
  })

  describe('2048-char stability window', () => {
    it('should produce the same fingerprint when prompts share the first 2048 chars', () => {
      const shared = 'A'.repeat(2048)
      const promptA = shared + 'extra-A'
      const promptB = shared + 'extra-B'
      expect(computeContextFingerprint(promptA)).toBe(computeContextFingerprint(promptB))
    })

    it('should produce different fingerprints when the first 2048 chars differ', () => {
      const differentStart = 'You are a TypeScript expert. ' + 'A'.repeat(2048)
      const baseStart = 'You are a Python expert. ' + 'A'.repeat(2048)
      expect(computeContextFingerprint(differentStart)).not.toBe(
        computeContextFingerprint(baseStart),
      )
    })
  })
})
