import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnPair } from '../../src/capture/turns.ts'

const loadConfigMock = vi.fn()
const recordTurnMock = vi.fn()
const searchTurnsMock = vi.fn()
const loadProfileMock = vi.fn()
const closeMock = vi.fn()
const createWalletStoreMock = vi.fn()

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: loadConfigMock,
}))

vi.mock('../../src/capture/record.js', () => ({
  recordTurn: recordTurnMock,
}))

vi.mock('../../src/retrieval/search.js', () => ({
  searchTurns: searchTurnsMock,
}))

vi.mock('../../src/retrieval/store.js', () => ({
  createWalletStore: createWalletStoreMock,
}))

vi.mock('../../src/injection/profile.js', () => ({
  loadProfile: loadProfileMock,
}))

const { commandProfile, commandRecord, commandSearch } = await import('../../src/cli.ts')

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as never)
}

function makeTurnPair(overrides: Partial<TurnPair> = {}): TurnPair {
  return {
    id: 'turn_abc123456789',
    userContent: 'I prefer TypeScript',
    assistantContent: 'Noted.',
    timestamp: '2026-05-08T14:23:00.000Z',
    tool: 'user-recorded',
    sessionId: 'user-records',
    turnIndex: 0,
    contextFingerprint: 'default',
    ...overrides,
  }
}

describe('CLI commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadConfigMock.mockResolvedValue({ ok: true, value: { walletDir: '/tmp/test-wallet' } })
    recordTurnMock.mockResolvedValue({ ok: true, value: makeTurnPair() })
    searchTurnsMock.mockResolvedValue({ ok: true, value: [] })
    loadProfileMock.mockResolvedValue({ ok: true, value: '' })
    closeMock.mockResolvedValue(undefined)
    createWalletStoreMock.mockResolvedValue({ ok: true, value: { close: closeMock } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('commandRecord rejects empty input', async () => {
    const exit = mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(commandRecord([])).rejects.toThrow('process.exit')

    expect(recordTurnMock).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('commandRecord joins multi-arg input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await commandRecord(['I', 'prefer', 'TS'])

    expect(recordTurnMock).toHaveBeenCalledWith('/tmp/test-wallet', 'I prefer TS')
  })

  it('commandRecord prints success on Result.ok', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    recordTurnMock.mockResolvedValue({ ok: true, value: makeTurnPair({ turnIndex: 7 }) })

    await commandRecord(['I prefer TS'])

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('✓ Recorded as turn 23456789 (turn #7 in user-records).'),
    )
  })

  it('commandRecord exits 1 on Result.err', async () => {
    const exit = mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    recordTurnMock.mockResolvedValue({ ok: false, error: new Error('disk full') })

    await expect(commandRecord(['fact'])).rejects.toThrow('process.exit')

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('commandSearch rejects empty query', async () => {
    const exit = mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(commandSearch([])).rejects.toThrow('process.exit')

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('commandSearch passes query to searchTurns', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await commandSearch(['foo', 'bar'])

    expect(searchTurnsMock).toHaveBeenCalledWith(expect.anything(), { query: 'foo bar', limit: 5 })
  })

  it('commandSearch honors --limit flag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await commandSearch(['foo', '--limit', '10'])

    expect(searchTurnsMock).toHaveBeenCalledWith(expect.anything(), { query: 'foo', limit: 10 })
  })

  it('commandSearch clamps --limit to range', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await commandSearch(['foo', '--limit', '0'])
    await commandSearch(['foo', '--limit', '999'])

    expect(searchTurnsMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      query: 'foo',
      limit: 1,
    })
    expect(searchTurnsMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      query: 'foo',
      limit: 50,
    })
  })

  it('commandSearch handles no-results gracefully', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit')

    await commandSearch(['missing'])

    expect(log).toHaveBeenCalledWith(expect.stringContaining('No matching turns found.'))
    expect(exit).not.toHaveBeenCalled()
  })

  it('commandSearch closes store after run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await commandSearch(['foo'])

    expect(closeMock).toHaveBeenCalled()
  })

  it('commandProfile prints empty-state message when profile is empty', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit')

    await commandProfile()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Still learning about you'))
    expect(exit).not.toHaveBeenCalled()
  })

  it('commandProfile prints profile content when present', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    loadProfileMock.mockResolvedValue({ ok: true, value: '# Profile\nAbdullah, Riyadh' })

    await commandProfile()

    expect(log).toHaveBeenCalledWith('# Profile\nAbdullah, Riyadh')
  })
})
