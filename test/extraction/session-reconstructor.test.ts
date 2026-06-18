import { describe, expect, it } from 'vitest'

import {
  cleanSessionContent,
  hasSubstantiveContent,
} from '../../src/extraction/session-reconstructor.js'

describe('cleanSessionContent', () => {
  it('keeps user and assistant sections, drops system', () => {
    const raw = [
      '## System',
      'You are a helpful assistant.',
      '',
      '## User',
      'I am Abdullah, building a payments app.',
      '',
      '## Assistant',
      'Got it — a payments app.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    expect(out).toContain('## User')
    expect(out).toContain('I am Abdullah, building a payments app.')
    expect(out).toContain('## Assistant')
    expect(out).not.toContain('You are a helpful assistant.')
    expect(out).not.toContain('## System')
  })

  it('drops [SUGGESTION MODE ...] autocomplete user turns (poison filter)', () => {
    const raw = [
      '## User',
      '[SUGGESTION MODE: complete the following code snippet]',
      '',
      '## Assistant',
      'const x = 1',
      '',
      '## User',
      'Actually, scratch Postgres — going with flat markdown files.',
      '',
      '## Assistant',
      'Understood, markdown it is.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    // Real user intent survives.
    expect(out).toContain('Actually, scratch Postgres')
    // Autocomplete poison is gone.
    expect(out).not.toContain('SUGGESTION MODE')
  })

  it('drops SUGGESTION turns even with leading markdown decoration', () => {
    const raw = ['## User', '> [SUGGESTION MODE: autocomplete]', '', '## Assistant', 'done'].join(
      '\n',
    )

    expect(cleanSessionContent(raw)).not.toContain('SUGGESTION')
  })

  it('does NOT drop a real user turn that merely mentions suggestion mode mid-sentence', () => {
    const raw = [
      '## User',
      'Can you explain what [SUGGESTION usage looks like in practice?',
      '',
      '## Assistant',
      'Sure.',
    ].join('\n')

    // Body does not START with [SUGGESTION → kept.
    expect(cleanSessionContent(raw)).toContain('Can you explain')
  })

  it('strips injected memory/context tags from kept sections', () => {
    const raw = [
      '## User',
      '<dhakira_context>prior memory</dhakira_context>',
      'What did we decide about the database?',
      '',
      '## Assistant',
      'We chose markdown.',
    ].join('\n')

    const out = cleanSessionContent(raw)
    expect(out).not.toContain('prior memory')
    expect(out).toContain('What did we decide about the database?')
  })
})

describe('hasSubstantiveContent', () => {
  it('returns true with >=2 substantive user messages', () => {
    const cleaned = [
      '## User',
      'I am Abdullah and I am building a portable AI memory wallet.',
      '## Assistant',
      'Great — tell me more.',
      '## User',
      'My real goal is impact, not financial gain whatsoever.',
      '## Assistant',
      'Understood.',
    ].join('\n')
    expect(hasSubstantiveContent(cleaned)).toBe(true)
  })

  it('returns false with only short user messages', () => {
    const cleaned = ['## User', 'hi', '## User', 'ok'].join('\n')
    expect(hasSubstantiveContent(cleaned)).toBe(false)
  })
})
