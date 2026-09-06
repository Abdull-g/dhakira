import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyModelResidency, createWalletStore } from '../../src/retrieval/store.ts'

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

  it('should configure memories and turns collections only', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, unknown> } },
    ]
    const collections = opts.config.collections
    expect(collections).toHaveProperty('memories')
    expect(collections).toHaveProperty('turns')
    expect(collections).not.toHaveProperty('conversations')
  })

  it('should set the correct path for each collection', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, { path: string }> } },
    ]
    const { memories, turns } = opts.config.collections
    expect(memories.path).toBe(join(WALLET_DIR, 'memories'))
    expect(turns.path).toBe(join(WALLET_DIR, 'turns'))
  })

  it('should use **/*.md as the glob pattern for searchable collections', async () => {
    await createWalletStore(WALLET_DIR)
    const [opts] = vi.mocked(qmdMock.createStore).mock.calls[0] as [
      { config: { collections: Record<string, { pattern: string }> } },
    ]
    expect(opts.config.collections.memories?.pattern).toBe('**/*.md')
    expect(opts.config.collections.turns?.pattern).toBe('**/*.md')
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

// v0.3.1 D2 — model residency. QMD 2.0.1 hardcodes a 5-minute idle unload of its
// three search models; the first recall after a pause then reloads them inside the
// hook's 1.5 s budget. Residency flips the two runtime fields on QMD's LlamaCpp.
describe('applyModelResidency (D2)', () => {
  function storeWithLlm(): {
    store: ReturnType<typeof makeStoreWithInternal>
    llm: { inactivityTimeoutMs: number; disposeModelsOnInactivity: boolean }
  } {
    const llm = { inactivityTimeoutMs: 5 * 60 * 1000, disposeModelsOnInactivity: true }
    return { store: makeStoreWithInternal({ llm }), llm }
  }
  function makeStoreWithInternal(internal: unknown) {
    return { ...MOCK_STORE, internal } as unknown as Parameters<typeof applyModelResidency>[0]
  }

  it('disables the idle unload timer and model disposal when resident (default)', () => {
    const { store, llm } = storeWithLlm()
    expect(applyModelResidency(store, true)).toBe(true)
    expect(llm.inactivityTimeoutMs).toBe(0)
    expect(llm.disposeModelsOnInactivity).toBe(false)
  })

  it('leaves QMD defaults untouched when modelsResident is false', () => {
    const { store, llm } = storeWithLlm()
    expect(applyModelResidency(store, false)).toBe(false)
    expect(llm.inactivityTimeoutMs).toBe(5 * 60 * 1000)
    expect(llm.disposeModelsOnInactivity).toBe(true)
  })

  it('degrades to a no-op (returns false) if QMD internals have drifted', () => {
    expect(applyModelResidency(makeStoreWithInternal({}), true)).toBe(false)
    expect(applyModelResidency(makeStoreWithInternal({ llm: { foo: 1 } }), true)).toBe(false)
    expect(applyModelResidency(makeStoreWithInternal(undefined), true)).toBe(false)
  })

  it('createWalletStore applies residency by default and honours { modelsResident: false }', async () => {
    const llm = { inactivityTimeoutMs: 300_000, disposeModelsOnInactivity: true }
    vi.mocked(qmdMock.createStore).mockResolvedValue({ ...MOCK_STORE, internal: { llm } } as never)
    await createWalletStore(WALLET_DIR)
    expect(llm.inactivityTimeoutMs).toBe(0)

    const llm2 = { inactivityTimeoutMs: 300_000, disposeModelsOnInactivity: true }
    vi.mocked(qmdMock.createStore).mockResolvedValue({
      ...MOCK_STORE,
      internal: { llm: llm2 },
    } as never)
    await createWalletStore(WALLET_DIR, { modelsResident: false })
    expect(llm2.inactivityTimeoutMs).toBe(300_000)
    expect(llm2.disposeModelsOnInactivity).toBe(true)
  })
})
