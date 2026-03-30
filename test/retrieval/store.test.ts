import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWalletStore } from '../../src/retrieval/store.ts'

// Mock QMD — it requires native binaries that won't run in this environment
vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

const qmdMock = await import('@tobilu/qmd')
const fsMock = await import('node:fs/promises')

const WALLET_DIR = '/tmp/test-wallet'

const MOCK_STORE = {
  search: vi.fn(),
  searchLex: vi.fn(),
  searchVector: vi.fn(),
  addCollection: vi.fn(),
  removeCollection: vi.fn(),
  renameCollection: vi.fn(),
  listCollections: vi.fn(),
  getDefaultCollectionNames: vi.fn(),
  addContext: vi.fn(),
  removeContext: vi.fn(),
  setGlobalContext: vi.fn(),
  getGlobalContext: vi.fn(),
  listContexts: vi.fn(),
  update: vi.fn(),
  embed: vi.fn(),
  getStatus: vi.fn(),
  getIndexHealth: vi.fn(),
  close: vi.fn(),
  expandQuery: vi.fn(),
  get: vi.fn(),
  getDocumentBody: vi.fn(),
  multiGet: vi.fn(),
  internal: {} as never,
  dbPath: join(WALLET_DIR, 'wallet.sqlite'),
}

describe('createWalletStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(qmdMock.createStore).mockResolvedValue(MOCK_STORE)
  })

  it('should return ok: true with the store on success', async () => {
    const result = await createWalletStore(WALLET_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe(MOCK_STORE)
  })

  it('should create the conversations directory', async () => {
    await createWalletStore(WALLET_DIR)
    expect(fsMock.mkdir).toHaveBeenCalledWith(join(WALLET_DIR, 'conversations'), {
      recursive: true,
    })
  })

  it('should create the memories directory', async () => {
    await createWalletStore(WALLET_DIR)
    expect(fsMock.mkdir).toHaveBeenCalledWith(join(WALLET_DIR, 'memories'), { recursive: true })
  })

  it('should initialize QMD with the correct dbPath', async () => {
    await createWalletStore(WALLET_DIR)
    expect(qmdMock.createStore).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: join(WALLET_DIR, 'wallet.sqlite'),
      }),
    )
  })

  it('should configure both conversations and memories collections', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, unknown> } },
    ]
    const collections = opts.config.collections
    expect(collections).toHaveProperty('conversations')
    expect(collections).toHaveProperty('memories')
  })

  it('should set the correct path for each collection', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, { path: string }> } },
    ]
    const { conversations, memories } = opts.config.collections
    expect(conversations.path).toBe(join(WALLET_DIR, 'conversations'))
    expect(memories.path).toBe(join(WALLET_DIR, 'memories'))
  })

  it('should use **/*.md as the glob pattern for both collections', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, { pattern: string }> } },
    ]
    expect(opts.config.collections.conversations?.pattern).toBe('**/*.md')
    expect(opts.config.collections.memories?.pattern).toBe('**/*.md')
  })

  it('should return ok: false when QMD createStore throws', async () => {
    vi.mocked(qmdMock.createStore).mockRejectedValueOnce(new Error('DB init failed'))
    const result = await createWalletStore(WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('DB init failed')
  })

  it('should return ok: false when mkdir throws', async () => {
    vi.mocked(fsMock.mkdir).mockRejectedValueOnce(new Error('Permission denied'))
    const result = await createWalletStore(WALLET_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Permission denied')
  })

  it('should never throw — always returns a Result', async () => {
    vi.mocked(qmdMock.createStore).mockRejectedValueOnce(new Error('Boom'))
    await expect(createWalletStore(WALLET_DIR)).resolves.not.toThrow()
  })
})
