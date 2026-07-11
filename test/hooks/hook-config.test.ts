import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'

import {
  mergeClaudeHooks,
  mergeCodexHooks,
  removeClaudeHooks,
  removeCodexHooks,
} from '../../src/hooks/hook-config.ts'

const HOOK_PATH = '/opt/dhakira/dist/hooks/dhakira-hook.mjs'
const tempDirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dhakira-hook-config-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function codexConfig(raw: string): Record<string, unknown> {
  return parse(raw) as Record<string, unknown>
}

function codexEvent(root: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const hooks = root.hooks as Record<string, unknown>
  return hooks[event] as Array<Record<string, unknown>>
}

function dhakiraCount(root: Record<string, unknown>, event: string): number {
  return codexEvent(root, event).filter((group) => {
    const handlers = group.hooks as Array<Record<string, unknown>>
    return handlers.some(
      (handler) =>
        typeof handler.command === 'string' && handler.command.includes('dhakira-hook.mjs'),
    )
  }).length
}

describe('Codex hook config', () => {
  it('is idempotent and emits the accepted nested hooks TOML shape', async () => {
    const path = await tempFile('config.toml')

    await mergeCodexHooks(HOOK_PATH, path)
    await mergeCodexHooks(HOOK_PATH, path)

    const raw = await readFile(path, 'utf8')
    const root = codexConfig(raw)
    expect(dhakiraCount(root, 'UserPromptSubmit')).toBe(1)
    expect(dhakiraCount(root, 'Stop')).toBe(1)
    expect(raw).toContain('[[hooks.UserPromptSubmit]]')
    expect(raw).toContain('[[hooks.UserPromptSubmit.hooks]]')
    expect(raw).toContain('[[hooks.Stop]]')
    expect(raw).toContain('[[hooks.Stop.hooks]]')
  })

  it('round-trips existing top-level, features, plugins, and MCP config semantically', async () => {
    const path = await tempFile('config.toml')
    const original = `model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"

[features]
hooks = true
js_repl = false

[plugins."documents@runtime"]
enabled = true

[mcp_servers.node_repl]
command = "/usr/local/bin/node-repl"
args = ["--safe"]

[mcp_servers.node_repl.env]
CODEX_HOME = "/tmp/codex"
`
    await writeFile(path, original, 'utf8')
    const before = codexConfig(original)

    await mergeCodexHooks(HOOK_PATH, path)
    const connected = codexConfig(await readFile(path, 'utf8'))
    expect(connected.model).toBe('gpt-5.6-sol')
    expect(connected.features).toEqual(before.features)
    expect(connected.plugins).toEqual(before.plugins)
    expect(connected.mcp_servers).toEqual(before.mcp_servers)

    await removeCodexHooks(path)
    expect(codexConfig(await readFile(path, 'utf8'))).toEqual(before)
  })

  it('disconnect removes only Dhakira and preserves unrelated hooks', async () => {
    const path = await tempFile('config.toml')
    const original = `[[hooks.UserPromptSubmit]]
matcher = ""

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node /opt/other/prompt-hook.mjs"

[[hooks.Stop]]
matcher = ""

[[hooks.Stop.hooks]]
type = "command"
command = "node /opt/other/stop-hook.mjs"
timeout = 30
`
    await writeFile(path, original, 'utf8')

    await mergeCodexHooks(HOOK_PATH, path)
    await removeCodexHooks(path)

    const root = codexConfig(await readFile(path, 'utf8'))
    expect(root).toEqual(codexConfig(original))
    expect(JSON.stringify(root)).not.toContain('dhakira-hook.mjs')
  })

  it('disconnect prunes the hooks table when Dhakira was its only user', async () => {
    const path = await tempFile('config.toml')
    await mergeCodexHooks(HOOK_PATH, path)
    await removeCodexHooks(path)

    expect(codexConfig(await readFile(path, 'utf8'))).toEqual({})
  })
})

describe('Claude hook config regression', () => {
  it('keeps the established JSON merge/remove behavior through shared helpers', async () => {
    const path = await tempFile('settings.json')
    const original = {
      permissions: { allow: ['Read'] },
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'node /opt/other/stop-hook.mjs' }],
          },
        ],
      },
    }
    await writeFile(path, `${JSON.stringify(original, null, 2)}\n`, 'utf8')

    await mergeClaudeHooks(HOOK_PATH, path)
    await mergeClaudeHooks(HOOK_PATH, path)
    const connected = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(dhakiraCount(connected, 'UserPromptSubmit')).toBe(1)
    expect(dhakiraCount(connected, 'Stop')).toBe(1)

    await removeClaudeHooks(path)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original)
  })
})
