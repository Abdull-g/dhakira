import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfig, WalletConfig } from '../../src/config/schema.ts'
import { classifyProviderByUrl } from '../../src/proxy/detect.ts'
import { createProxyServer, matchTool, resolveApiKey } from '../../src/proxy/server.ts'

const BASE_CONFIG: WalletConfig = {
  walletDir: '/tmp/test-wallet',
  proxy: { port: 0, host: '127.0.0.1' },
  dashboard: { port: 0, host: '127.0.0.1' },
  tools: [
    {
      name: 'cursor',
      provider: 'openai',
      apiKey: 'sk-test-openai',
      baseUrl: 'https://api.openai.com/v1',
    },
    {
      name: 'claude-code',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com/v1',
    },
  ],
  capture: { pipelineVersion: 'v1', debug: false },
  extraction: {
    schedule: '0 2 * * *',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test-openai',
    baseUrl: 'https://api.openai.com/v1',
  },
  injection: { maxTokens: 1800, minRelevanceScore: 0.3, recencyBoost: 0.3, maxTurns: 8 },
  incognito: false,
}

describe('resolveApiKey', () => {
  it('should return literal API keys unchanged', () => {
    expect(resolveApiKey('sk-literal-key')).toBe('sk-literal-key')
  })

  it('should resolve env: prefixed keys from environment', () => {
    process.env.TEST_API_KEY = 'resolved-value'
    expect(resolveApiKey('env:TEST_API_KEY')).toBe('resolved-value')
    delete process.env.TEST_API_KEY
  })

  it('should throw when env var is not set', () => {
    delete process.env.MISSING_VAR
    expect(() => resolveApiKey('env:MISSING_VAR')).toThrow('MISSING_VAR')
  })
})

describe('matchTool', () => {
  it('should match an OpenAI tool by bearer token', () => {
    const tool = matchTool(BASE_CONFIG.tools, 'Bearer sk-test-openai', undefined, '/v1/chat/completions')
    expect(tool?.name).toBe('cursor')
  })

  it('should match an Anthropic tool by x-api-key header', () => {
    const tool = matchTool(BASE_CONFIG.tools, undefined, 'sk-ant-test', '/v1/messages')
    expect(tool?.name).toBe('claude-code')
  })

  it('should return null when no key matches', () => {
    const tool = matchTool(BASE_CONFIG.tools, 'Bearer sk-wrong', 'sk-wrong', '/v1/chat/completions')
    expect(tool).toBeNull()
  })

  it('should return null when called with no headers', () => {
    const tool = matchTool(BASE_CONFIG.tools, undefined, undefined, '/v1/chat/completions')
    expect(tool).toBeNull()
  })

  it('should be case-insensitive for Bearer prefix', () => {
    const tool = matchTool(BASE_CONFIG.tools, 'bearer sk-test-openai', undefined, '/v1/chat/completions')
    expect(tool?.name).toBe('cursor')
  })

  it('should match an Anthropic wildcard for Anthropic URL with non-matching x-api-key', () => {
    const tools: ToolConfig[] = [
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
    ]

    const tool = matchTool(tools, undefined, 'sk-ant-not-the-real-key', '/v1/messages')
    expect(tool?.name).toBe('anthropic-wildcard')
  })

  it('should match an Anthropic wildcard for Anthropic URL with bearer token and query params', () => {
    const tools: ToolConfig[] = [
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
    ]

    const tool = matchTool(tools, 'Bearer sk-ant-oat01-fake-oauth', undefined, '/v1/messages?beta=true')
    expect(tool?.name).toBe('anthropic-wildcard')
  })

  it('should not match an Anthropic wildcard for OpenAI URLs', () => {
    const tools: ToolConfig[] = [
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
    ]

    const tool = matchTool(tools, 'Bearer sk-openai', undefined, '/v1/chat/completions')
    expect(tool).toBeNull()
  })

  it('should match the OpenAI wildcard for OpenAI URLs regardless of wildcard order', () => {
    const tools: ToolConfig[] = [
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
      {
        name: 'openai-wildcard',
        provider: 'openai',
        apiKey: '*',
        baseUrl: 'https://api.openai.com/v1',
      },
    ]

    const tool = matchTool(tools, 'Bearer sk-openai', undefined, '/v1/chat/completions')
    expect(tool?.name).toBe('openai-wildcard')
  })

  it('should prefer specific tools over wildcards when a key matches', () => {
    const tools: ToolConfig[] = [
      ...BASE_CONFIG.tools,
      {
        name: 'openai-wildcard',
        provider: 'openai',
        apiKey: '*',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
    ]

    const tool = matchTool(tools, 'Bearer sk-test-openai', undefined, '/v1/chat/completions')
    expect(tool?.name).toBe('cursor')
  })

  it('should not match wildcards for unknown URLs', () => {
    const tools: ToolConfig[] = [
      {
        name: 'anthropic-wildcard',
        provider: 'anthropic',
        apiKey: '*',
        baseUrl: 'https://api.anthropic.com',
      },
    ]

    const tool = matchTool(tools, 'Bearer sk-ant-oat01-fake-oauth', undefined, '/foo/bar')
    expect(tool).toBeNull()
  })
})

describe('classifyProviderByUrl', () => {
  it.each([
    ['/v1/messages', 'anthropic'],
    ['/v1/messages?beta=true', 'anthropic'],
    ['/v1/chat/completions', 'openai'],
    ['/v1/chat/completions?stream=true', 'openai'],
    ['/v1/completions', 'openai'],
    ['/', 'unknown'],
    ['/foo/bar', 'unknown'],
  ] as const)('classifies %s as %s', (url, expected) => {
    expect(classifyProviderByUrl(url)).toBe(expected)
  })
})

describe('createProxyServer', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(() => {
    server = createProxyServer(BASE_CONFIG)
  })

  afterEach(() => {
    server.close()
  })

  it('should return an http.Server instance', () => {
    expect(server).toBeInstanceOf(http.Server)
  })

  it('should listen on the configured port', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    expect(address.port).toBeGreaterThan(0)
  })

  it('should return 401 for requests with no matching API key', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-unknown', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('should return 400 for invalid JSON body', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-openai', 'content-type': 'application/json' },
      body: 'not json {{{',
    })

    expect(res.status).toBe(400)
  })

  it('should call injectMemories hook when not incognito', async () => {
    const injectMemories = vi.fn().mockResolvedValue(null)
    const serverWithHook = createProxyServer(BASE_CONFIG, { injectMemories })

    await new Promise<void>((resolve) => serverWithHook.listen(0, '127.0.0.1', resolve))
    const address = serverWithHook.address() as AddressInfo
    const hookUrl = `http://127.0.0.1:${address.port}`

    // This will fail at the provider forwarding stage, but the hook should still fire
    const res = await fetch(`${hookUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-openai', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    })

    // The proxy forwards the request: provider may return 401 (bad test key), 502 (unreachable),
    // or 200. All indicate the proxy successfully reached the forwarding stage.
    expect([200, 401, 429, 502]).toContain(res.status)
    expect(injectMemories).toHaveBeenCalledTimes(1)
    serverWithHook.close()
  })

  it('should not call injectMemories hook when incognito is true', async () => {
    const incognitoConfig: WalletConfig = { ...BASE_CONFIG, incognito: true }
    const injectMemories = vi.fn().mockResolvedValue(null)
    const serverWithHook = createProxyServer(incognitoConfig, { injectMemories })

    await new Promise<void>((resolve) => serverWithHook.listen(0, '127.0.0.1', resolve))
    const address = serverWithHook.address() as AddressInfo
    const hookUrl = `http://127.0.0.1:${address.port}`

    await fetch(`${hookUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-openai', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(injectMemories).not.toHaveBeenCalled()
    serverWithHook.close()
  })
})
