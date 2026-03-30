import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '../../src/proxy/types.ts'
import {
  buildTurnFilePath,
  extractTurnPairs,
  formatTurnPair,
  storeTurnPairs,
  writeTurnPair,
} from '../../src/capture/turns.ts'
import type { TurnPair } from '../../src/capture/turns.ts'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

const fsMock = await import('node:fs/promises')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET_DIR = '/tmp/test-wallet'
const SESSION_ID = 'conv_abc123'
const TOOL = 'claude-code'
const TIMESTAMP = new Date('2026-03-26T10:00:00.000Z')

function msgs(...pairs: Array<[string, string]>): NormalizedMessage[] {
  return pairs.flatMap(([user, assistant]) => [
    { role: 'user' as const, content: user },
    { role: 'assistant' as const, content: assistant },
  ])
}

function makePair(overrides: Partial<TurnPair> = {}): TurnPair {
  return {
    id: 'turn_abc123',
    userContent: 'How do I set up pgBouncer?',
    assistantContent: 'You can set up pgBouncer by...',
    timestamp: TIMESTAMP.toISOString(),
    tool: TOOL,
    sessionId: SESSION_ID,
    turnIndex: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// extractTurnPairs
// ---------------------------------------------------------------------------

describe('extractTurnPairs', () => {
  it('returns one pair for a single user+assistant exchange', () => {
    const messages = msgs(['Hello', 'Hi there!'])
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].userContent).toBe('Hello')
    expect(pairs[0].assistantContent).toBe('Hi there!')
  })

  it('assigns sequential turnIndex values starting at 0', () => {
    const messages = msgs(['Q1', 'A1'], ['Q2', 'A2'], ['Q3', 'A3'])
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs.map((p) => p.turnIndex)).toEqual([0, 1, 2])
  })

  it('skips system messages', () => {
    const messages: NormalizedMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].userContent).toBe('Hello')
  })

  it('drops an orphaned user message with no following assistant reply', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2 with no reply' },
    ]
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].userContent).toBe('Q1')
  })

  it('returns an empty array for an empty message list', () => {
    expect(extractTurnPairs([], TOOL, SESSION_ID, TIMESTAMP)).toHaveLength(0)
  })

  it('returns an empty array when only system messages are present', () => {
    const messages: NormalizedMessage[] = [
      { role: 'system', content: 'System context here.' },
    ]
    expect(extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)).toHaveLength(0)
  })

  it('attaches the correct sessionId to every pair', () => {
    const pairs = extractTurnPairs(msgs(['Q', 'A'], ['Q2', 'A2']), TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs.every((p) => p.sessionId === SESSION_ID)).toBe(true)
  })

  it('attaches the correct tool to every pair', () => {
    const pairs = extractTurnPairs(msgs(['Q', 'A']), 'cursor', SESSION_ID, TIMESTAMP)
    expect(pairs[0].tool).toBe('cursor')
  })

  it('stores the timestamp as an ISO string', () => {
    const pairs = extractTurnPairs(msgs(['Q', 'A']), TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs[0].timestamp).toBe(TIMESTAMP.toISOString())
  })

  it('generates a unique id for each pair', () => {
    const pairs = extractTurnPairs(msgs(['Q1', 'A1'], ['Q2', 'A2']), TOOL, SESSION_ID, TIMESTAMP)
    const ids = pairs.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('redacts secrets found in user content', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'My key is sk-aaaaaaaaaaaaaaaaaaaaaaaa' },
      { role: 'assistant', content: 'Got it.' },
    ]
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs[0].userContent).toContain('[REDACTED]')
    expect(pairs[0].userContent).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('redacts secrets found in assistant content', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'What key should I use?' },
      { role: 'assistant', content: 'Use sk-aaaaaaaaaaaaaaaaaaaaaaaa for this.' },
    ]
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    expect(pairs[0].assistantContent).toContain('[REDACTED]')
  })

  it('handles consecutive assistant messages by pairing the user with the first assistant', () => {
    // Two assistant messages in a row — second one is effectively orphaned from the next user
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'First response' },
      { role: 'assistant', content: 'Second response' }, // orphaned
    ]
    const pairs = extractTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP)
    // The first user+assistant is paired; the extra assistant is skipped
    expect(pairs).toHaveLength(1)
    expect(pairs[0].assistantContent).toBe('First response')
  })
})

// ---------------------------------------------------------------------------
// buildTurnFilePath
// ---------------------------------------------------------------------------

describe('buildTurnFilePath', () => {
  it('places the file inside turns/{date}/', () => {
    const pair = makePair()
    const path = buildTurnFilePath(WALLET_DIR, pair)
    expect(path).toContain(join(WALLET_DIR, 'turns'))
  })

  it('uses YYYY-MM-DD directory derived from the timestamp', () => {
    const pair = makePair({ timestamp: '2026-03-26T10:00:00.000Z' })
    const path = buildTurnFilePath(WALLET_DIR, pair)
    const d = new Date('2026-03-26T10:00:00.000Z')
    const year = d.getFullYear()
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    expect(path).toContain(`${year}-${month}-${day}`)
  })

  it('uses {sessionId}-{turnIndex}.md as the filename', () => {
    const pair = makePair({ sessionId: 'sess_xyz789', turnIndex: 3 })
    const path = buildTurnFilePath(WALLET_DIR, pair)
    expect(path).toMatch(/sess_xyz789-3\.md$/)
  })

  it('expands a leading ~ in walletDir', () => {
    const path = buildTurnFilePath('~/my-wallet', makePair())
    expect(path).not.toContain('~')
    expect(path).toContain('my-wallet')
  })
})

// ---------------------------------------------------------------------------
// formatTurnPair
// ---------------------------------------------------------------------------

describe('formatTurnPair', () => {
  it('includes YAML frontmatter with the turn id', () => {
    const content = formatTurnPair(makePair({ id: 'turn_xyz999' }))
    expect(content).toContain('id: turn_xyz999')
  })

  it('includes sessionId in frontmatter', () => {
    const content = formatTurnPair(makePair({ sessionId: 'sess_zzz' }))
    expect(content).toContain('sessionId: sess_zzz')
  })

  it('includes tool in frontmatter', () => {
    const content = formatTurnPair(makePair({ tool: 'cursor' }))
    expect(content).toContain('tool: cursor')
  })

  it('includes turnIndex in frontmatter', () => {
    const content = formatTurnPair(makePair({ turnIndex: 5 }))
    expect(content).toContain('turnIndex: 5')
  })

  it('includes ## User heading with user content', () => {
    const content = formatTurnPair(makePair({ userContent: 'How do I sort?' }))
    expect(content).toContain('## User')
    expect(content).toContain('How do I sort?')
  })

  it('includes ## Assistant heading with assistant content', () => {
    const content = formatTurnPair(makePair({ assistantContent: 'Use Array.sort()' }))
    expect(content).toContain('## Assistant')
    expect(content).toContain('Use Array.sort()')
  })

  it('opens and closes frontmatter with --- delimiters', () => {
    const content = formatTurnPair(makePair())
    const lines = content.split('\n')
    expect(lines[0]).toBe('---')
    const closingIndex = lines.indexOf('---', 1)
    expect(closingIndex).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// writeTurnPair
// ---------------------------------------------------------------------------

describe('writeTurnPair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok: true with the file path on success', async () => {
    const result = await writeTurnPair(makePair(), WALLET_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain(WALLET_DIR)
    expect(result.value).toMatch(/\.md$/)
  })

  it('calls mkdir with recursive: true', async () => {
    await writeTurnPair(makePair(), WALLET_DIR)
    expect(fsMock.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
  })

  it('calls writeFile with utf8 encoding', async () => {
    await writeTurnPair(makePair(), WALLET_DIR)
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'utf8',
    )
  })

  it('writes content containing the turn id in frontmatter', async () => {
    await writeTurnPair(makePair({ id: 'turn_test99' }), WALLET_DIR)
    const [, content] = (fsMock.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(content).toContain('id: turn_test99')
  })

  it('returns ok: false when mkdir fails', async () => {
    vi.mocked(fsMock.mkdir).mockRejectedValueOnce(new Error('Permission denied'))
    const result = await writeTurnPair(makePair(), WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Permission denied')
  })

  it('returns ok: false when writeFile fails', async () => {
    vi.mocked(fsMock.writeFile).mockRejectedValueOnce(new Error('Disk full'))
    const result = await writeTurnPair(makePair(), WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Disk full')
  })

  it('never throws even when the filesystem throws', async () => {
    vi.mocked(fsMock.mkdir).mockRejectedValueOnce(new Error('Catastrophic failure'))
    await expect(writeTurnPair(makePair(), WALLET_DIR)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// storeTurnPairs (integration of extract + write)
// ---------------------------------------------------------------------------

describe('storeTurnPairs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns one Result per extracted turn pair', async () => {
    const messages = msgs(['Q1', 'A1'], ['Q2', 'A2'])
    const results = await storeTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP, WALLET_DIR)
    expect(results).toHaveLength(2)
  })

  it('returns an empty array when the message list produces no pairs', async () => {
    const results = await storeTurnPairs([], TOOL, SESSION_ID, TIMESTAMP, WALLET_DIR)
    expect(results).toHaveLength(0)
  })

  it('calls writeFile once per extracted pair', async () => {
    const messages = msgs(['Q1', 'A1'], ['Q2', 'A2'], ['Q3', 'A3'])
    await storeTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP, WALLET_DIR)
    expect(fsMock.writeFile).toHaveBeenCalledTimes(3)
  })

  it('all results are ok: true on a happy path', async () => {
    const messages = msgs(['Q', 'A'])
    const results = await storeTurnPairs(messages, TOOL, SESSION_ID, TIMESTAMP, WALLET_DIR)
    expect(results.every((r) => r.ok)).toBe(true)
  })
})
