import { describe, expect, it } from 'vitest'
import { injectIntoSystemPrompt } from '../../src/injection/injector.ts'
import type { InjectionBlock } from '../../src/injection/types.ts'

function makeBlock(overrides: Partial<InjectionBlock> = {}): InjectionBlock {
  return {
    text: '<memory_context>\nYou prefer TypeScript.\n</memory_context>',
    tokenCount: 50,
    memoryCount: 1,
    hasProfile: false,
    ...overrides,
  }
}

const emptyBlock: InjectionBlock = {
  text: '',
  tokenCount: 0,
  memoryCount: 0,
  hasProfile: false,
}

describe('injectIntoSystemPrompt — empty block', () => {
  it('should return original prompt unchanged when injection block is empty', () => {
    const result = injectIntoSystemPrompt('You are a helpful assistant.', emptyBlock)
    expect(result).toBe('You are a helpful assistant.')
  })

  it('should return empty string when both prompt is null and block is empty', () => {
    const result = injectIntoSystemPrompt(null, emptyBlock)
    expect(result).toBe('')
  })
})

describe('injectIntoSystemPrompt — null original prompt', () => {
  it('should return injection block text when original prompt is null', () => {
    const block = makeBlock()
    const result = injectIntoSystemPrompt(null, block)
    expect(result).toBe(block.text)
  })

  it('should not add extra whitespace when original prompt is null', () => {
    const block = makeBlock({ text: '<memory_context>ctx</memory_context>' })
    const result = injectIntoSystemPrompt(null, block)
    expect(result).toBe('<memory_context>ctx</memory_context>')
  })
})

describe('injectIntoSystemPrompt — prepend behavior', () => {
  it('should prepend the injection block before the original prompt', () => {
    const original = 'You are a helpful assistant.'
    const block = makeBlock()
    const result = injectIntoSystemPrompt(original, block)
    expect(result.indexOf(block.text)).toBeLessThan(result.indexOf(original))
  })

  it('should separate the injection block and original prompt with two newlines', () => {
    const original = 'You are a helpful assistant.'
    const block = makeBlock()
    const result = injectIntoSystemPrompt(original, block)
    expect(result).toBe(`${block.text}\n\n${original}`)
  })

  it('should include the full injection block text', () => {
    const block = makeBlock({ text: '<memory_context>\nSome memory.\n</memory_context>' })
    const result = injectIntoSystemPrompt('Be concise.', block)
    expect(result).toContain('<memory_context>')
    expect(result).toContain('Some memory.')
    expect(result).toContain('</memory_context>')
  })

  it('should include the full original prompt text', () => {
    const original = 'You are a specialist in TypeScript. Always use strict mode.'
    const block = makeBlock()
    const result = injectIntoSystemPrompt(original, block)
    expect(result).toContain(original)
  })

  it('should not duplicate content from either source', () => {
    const original = 'Respond concisely.'
    const block = makeBlock({ text: '<memory_context>ctx</memory_context>' })
    const result = injectIntoSystemPrompt(original, block)
    const blockOccurrences = result.split('<memory_context>').length - 1
    const originalOccurrences = result.split('Respond concisely.').length - 1
    expect(blockOccurrences).toBe(1)
    expect(originalOccurrences).toBe(1)
  })
})

describe('injectIntoSystemPrompt — return type', () => {
  it('should always return a string', () => {
    expect(typeof injectIntoSystemPrompt(null, emptyBlock)).toBe('string')
    expect(typeof injectIntoSystemPrompt(null, makeBlock())).toBe('string')
    expect(typeof injectIntoSystemPrompt('prompt', makeBlock())).toBe('string')
    expect(typeof injectIntoSystemPrompt('prompt', emptyBlock)).toBe('string')
  })
})
