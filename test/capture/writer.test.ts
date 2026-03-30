import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedConversation } from '../../src/capture/types.ts'
import { buildFilePath, writeConversation } from '../../src/capture/writer.ts'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

// Import the mocked module after vi.mock so we can inspect calls
const fsMock = await import('node:fs/promises')

const WALLET_DIR = '/tmp/test-wallet'

function makeConversation(overrides: Partial<CapturedConversation> = {}): CapturedConversation {
  return {
    id: 'conv_abc123',
    tool: 'cursor',
    provider: 'openai',
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there!' },
    ],
    // 2026-03-20 01:30 local — use a fixed UTC time; local offset affects expected path in real runs,
    // so we derive expected path from the same Date object to avoid timezone coupling.
    timestamp: new Date('2026-03-20T01:30:00.000Z'),
    tokenEstimate: 50,
    incognito: false,
    ...overrides,
  }
}

describe('buildFilePath', () => {
  it('should place the file inside conversations/{date}/', () => {
    const conv = makeConversation()
    const path = buildFilePath(WALLET_DIR, conv)
    expect(path).toContain(join(WALLET_DIR, 'conversations'))
  })

  it('should use the short last-6-chars of the id in the filename', () => {
    const conv = makeConversation({ id: 'conv_abc123' })
    const path = buildFilePath(WALLET_DIR, conv)
    expect(path).toContain('abc123')
  })

  it('should include the tool name in the filename', () => {
    const path = buildFilePath(WALLET_DIR, makeConversation({ tool: 'claude-code' }))
    expect(path).toContain('claude-code')
  })

  it('should end with .md extension', () => {
    expect(buildFilePath(WALLET_DIR, makeConversation())).toMatch(/\.md$/)
  })

  it('should embed HHhMMm time in the filename', () => {
    // Use a fixed Date and derive expected time from the same Date to be timezone-agnostic
    const d = new Date('2026-03-20T01:30:00.000Z')
    const expectedTime = `${d.getHours().toString().padStart(2, '0')}h${d.getMinutes().toString().padStart(2, '0')}m`
    const path = buildFilePath(WALLET_DIR, makeConversation({ timestamp: d }))
    expect(path).toContain(expectedTime)
  })

  it('should expand a leading ~ in walletDir', () => {
    const path = buildFilePath('~/my-wallet', makeConversation())
    expect(path).not.toContain('~')
    expect(path).toContain('my-wallet')
  })

  it('should include the YYYY-MM-DD date directory derived from the timestamp', () => {
    const d = new Date('2026-03-20T01:30:00.000Z')
    const year = d.getFullYear()
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    const expectedDate = `${year}-${month}-${day}`
    const path = buildFilePath(WALLET_DIR, makeConversation({ timestamp: d }))
    expect(path).toContain(expectedDate)
  })
})

describe('writeConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return ok: true with the file path on success', async () => {
    const result = await writeConversation(makeConversation(), WALLET_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain(WALLET_DIR)
    expect(result.value).toMatch(/\.md$/)
  })

  it('should call mkdir with recursive: true', async () => {
    await writeConversation(makeConversation(), WALLET_DIR)
    expect(fsMock.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
  })

  it('should call writeFile with the correct path and utf8 encoding', async () => {
    const conv = makeConversation()
    const result = await writeConversation(conv, WALLET_DIR)
    if (!result.ok) return

    expect(fsMock.writeFile).toHaveBeenCalledWith(result.value, expect.any(String), 'utf8')
  })

  it('should write content containing the conversation id in frontmatter', async () => {
    const conv = makeConversation({ id: 'conv_xyz999' })
    await writeConversation(conv, WALLET_DIR)

    const [, content] = (fsMock.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(content).toContain('id: conv_xyz999')
  })

  it('should write message content to the file', async () => {
    await writeConversation(makeConversation(), WALLET_DIR)

    const [, content] = (fsMock.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(content).toContain('## User')
    expect(content).toContain('Hello!')
    expect(content).toContain('## Assistant')
    expect(content).toContain('Hi there!')
  })

  it('should mkdir with the parent directory of the file', async () => {
    const conv = makeConversation()
    const result = await writeConversation(conv, WALLET_DIR)
    if (!result.ok) return

    const expectedDir = result.value.substring(0, result.value.lastIndexOf('/'))
    expect(fsMock.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true })
  })

  it('should return ok: false when mkdir fails', async () => {
    vi.mocked(fsMock.mkdir).mockRejectedValueOnce(new Error('Permission denied'))

    const result = await writeConversation(makeConversation(), WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Permission denied')
  })

  it('should return ok: false when writeFile fails', async () => {
    vi.mocked(fsMock.writeFile).mockRejectedValueOnce(new Error('Disk full'))

    const result = await writeConversation(makeConversation(), WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Disk full')
  })

  it('should never throw even when filesystem throws', async () => {
    vi.mocked(fsMock.mkdir).mockRejectedValueOnce(new Error('Catastrophic failure'))
    await expect(writeConversation(makeConversation(), WALLET_DIR)).resolves.not.toThrow()
  })
})
