import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config/loader.ts'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

const fsMock = await import('node:fs/promises')

const VALID_YAML = `
walletDir: /custom/wallet
proxy:
  port: 4200
  host: 0.0.0.0
dashboard:
  port: 4201
  host: 0.0.0.0
tools:
  - name: cursor
    provider: openai
    apiKey: sk-literal-key
    baseUrl: https://api.openai.com/v1
extraction:
  schedule: "0 3 * * *"
  model: gpt-4o
  apiKey: sk-extract-key
  baseUrl: https://api.openai.com/v1
injection:
  maxTokens: 1000
  minRelevanceScore: 0.5
  recencyBoost: 0.2
  maxTurns: 6
incognito: true
`

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('when config file exists', () => {
    it('should return ok: true with parsed config', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig('/custom/wallet')
      expect(result.ok).toBe(true)
    })

    it('should parse walletDir from YAML', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.walletDir).toBe('/custom/wallet')
    })

    it('should parse proxy port and host', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.proxy.port).toBe(4200)
      expect(result.value.proxy.host).toBe('0.0.0.0')
    })

    it('should parse dashboard port and host', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.dashboard.port).toBe(4201)
    })

    it('should parse tools array with correct shape', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tools).toHaveLength(1)
      const tool = result.value.tools[0]
      expect(tool?.name).toBe('cursor')
      expect(tool?.provider).toBe('openai')
      expect(tool?.baseUrl).toBe('https://api.openai.com/v1')
    })

    it('should parse injection settings', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.injection.maxTokens).toBe(1000)
      expect(result.value.injection.minRelevanceScore).toBe(0.5)
      expect(result.value.injection.recencyBoost).toBe(0.2)
      expect(result.value.injection.maxTurns).toBe(6)
    })

    it('should parse incognito flag', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.incognito).toBe(true)
    })

    it('should keep literal API keys unchanged', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(VALID_YAML as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tools[0]?.apiKey).toBe('sk-literal-key')
    })

    it('should resolve env: prefixed API keys from environment', async () => {
      process.env.MY_API_KEY = 'resolved-secret'
      const yaml = `
tools:
  - name: cursor
    provider: openai
    apiKey: env:MY_API_KEY
    baseUrl: https://api.openai.com/v1
`
      vi.mocked(fsMock.readFile).mockResolvedValue(yaml as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tools[0]?.apiKey).toBe('resolved-secret')
      delete process.env.MY_API_KEY
    })

    it('should keep env:VAR_NAME when the env variable is not set', async () => {
      delete process.env.MISSING_KEY
      const yaml = `
tools:
  - name: cursor
    provider: openai
    apiKey: env:MISSING_KEY
    baseUrl: https://api.openai.com/v1
`
      vi.mocked(fsMock.readFile).mockResolvedValue(yaml as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tools[0]?.apiKey).toBe('env:MISSING_KEY')
    })

    it('should expand ~ in walletDir', async () => {
      const yaml = 'walletDir: ~/my-wallet\n'
      vi.mocked(fsMock.readFile).mockResolvedValue(yaml as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.walletDir).toBe(`${homedir()}/my-wallet`)
      expect(result.value.walletDir).not.toContain('~')
    })
  })

  describe('when config file does not exist (ENOENT)', () => {
    it('should return ok: true with defaults', async () => {
      const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      vi.mocked(fsMock.readFile).mockRejectedValue(err)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
    })

    it('should use default proxy port 4100', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      vi.mocked(fsMock.readFile).mockRejectedValue(err)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.proxy.port).toBe(4100)
    })

    it('should use the provided walletDir as the default walletDir', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      vi.mocked(fsMock.readFile).mockRejectedValue(err)
      const result = await loadConfig('/explicit/wallet')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.walletDir).toBe('/explicit/wallet')
    })

    it('should use ~/.dhakira as walletDir when no argument is given', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      vi.mocked(fsMock.readFile).mockRejectedValue(err)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.walletDir).toBe(join(homedir(), '.dhakira'))
    })
  })

  describe('when config file is malformed', () => {
    it('should return ok: false on file read errors other than ENOENT', async () => {
      const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      vi.mocked(fsMock.readFile).mockRejectedValue(err)
      const result = await loadConfig()
      expect(result.ok).toBe(false)
    })
  })

  describe('partial config merging with defaults', () => {
    it('should fall back to default dashboard port when not specified', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue('proxy:\n  port: 5000\n' as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.dashboard.port).toBe(4101)
    })

    it('should fall back to default injection settings when not specified', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue('incognito: true\n' as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.injection.maxTokens).toBe(1800)
      expect(result.value.injection.minRelevanceScore).toBe(0.3)
      expect(result.value.injection.recencyBoost).toBe(0.3)
      expect(result.value.injection.maxTurns).toBe(8)
    })

    it('should fall back to defaults for unrecognised injection fields', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue(
        'injection:\n  maxTokens: 500\n' as never,
      )
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.injection.maxTokens).toBe(500)
      expect(result.value.injection.minRelevanceScore).toBe(0.3)
    })

    it('should ignore tool entries with invalid provider', async () => {
      const yaml = `
tools:
  - name: bad-tool
    provider: invalid
    apiKey: key
    baseUrl: https://example.com
  - name: cursor
    provider: openai
    apiKey: sk-good
    baseUrl: https://api.openai.com/v1
`
      vi.mocked(fsMock.readFile).mockResolvedValue(yaml as never)
      const result = await loadConfig()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tools).toHaveLength(1)
      expect(result.value.tools[0]?.name).toBe('cursor')
    })
  })
})
