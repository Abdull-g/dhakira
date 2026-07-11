// Shared connect/disconnect plumbing for hook-based tool adapters.
//
// Claude stores the shared hook tree in JSON; Codex 0.137 stores the same tree
// under [hooks] in config.toml. Format-specific I/O stays at the edge while the
// marker-guarded merge/removal rules live in one place.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

export const DHAKIRA_HOOK_MARKER = 'dhakira-hook.mjs'

export type HookEvent = 'UserPromptSubmit' | 'Stop'

interface HookHandler extends Record<string, unknown> {
  type?: string
  command?: string
}

interface HookGroup extends Record<string, unknown> {
  matcher?: string
  hooks?: HookHandler[]
}

type HookTree = Record<string, unknown>
type ConfigRoot = Record<string, unknown>

export function hookCommand(hookPath: string, event: HookEvent): string {
  return `node "${hookPath}" ${event} 2>/dev/null`
}

function hookTree(root: ConfigRoot): HookTree {
  if (typeof root.hooks === 'object' && root.hooks !== null && !Array.isArray(root.hooks)) {
    return root.hooks as HookTree
  }
  const hooks: HookTree = {}
  root.hooks = hooks
  return hooks
}

function eventGroups(hooks: HookTree, event: string): HookGroup[] {
  const groups = hooks[event]
  return Array.isArray(groups) ? (groups as HookGroup[]) : []
}

function hasDhakiraHandler(group: HookGroup): boolean {
  return (
    group.hooks?.some(
      (handler) =>
        typeof handler.command === 'string' && handler.command.includes(DHAKIRA_HOOK_MARKER),
    ) ?? false
  )
}

/** Add one Dhakira handler per event without disturbing unrelated hook groups. */
export function mergeDhakiraHooks(root: ConfigRoot, hookPath: string): ConfigRoot {
  const hooks = hookTree(root)
  for (const event of ['UserPromptSubmit', 'Stop'] as const) {
    const groups = eventGroups(hooks, event)
    if (!groups.some(hasDhakiraHandler)) {
      groups.push({
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand(hookPath, event) }],
      })
    }
    hooks[event] = groups
  }
  return root
}

/** Remove only marker-matched handlers and prune groups/tables made empty by removal. */
export function removeDhakiraHooks(root: ConfigRoot): ConfigRoot {
  if (typeof root.hooks !== 'object' || root.hooks === null || Array.isArray(root.hooks)) {
    return root
  }
  const hooks = root.hooks as HookTree

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const remaining = (groups as HookGroup[])
      .map((group) => ({
        ...group,
        hooks: group.hooks?.filter(
          (handler) =>
            typeof handler.command !== 'string' || !handler.command.includes(DHAKIRA_HOOK_MARKER),
        ),
      }))
      .filter((group) => (group.hooks?.length ?? 0) > 0)

    if (remaining.length > 0) hooks[event] = remaining
    else delete hooks[event]
  }

  if (Object.keys(hooks).length === 0) delete root.hooks
  return root
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

export function claudeSettingsPath(home = homedir()): string {
  return join(home, '.claude', 'settings.json')
}

export function codexConfigPath(home = homedir()): string {
  return join(home, '.codex', 'config.toml')
}

function parseCodexConfig(raw: string): ConfigRoot {
  // Keep TOML integer/float distinctions stable across the parse/stringify round trip.
  return parse(raw, { integersAsBigInt: true }) as ConfigRoot
}

function stringifyCodexConfig(root: ConfigRoot): string {
  return stringify(root, { numbersAsFloat: true })
}

export async function mergeClaudeHooks(
  hookPath: string,
  settingsPath = claudeSettingsPath(),
): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true })
  let root: ConfigRoot = {}
  try {
    root = JSON.parse(await readFile(settingsPath, 'utf8')) as ConfigRoot
  } catch {
    // Preserve Claude's established behavior: missing/unreadable/invalid starts fresh.
  }
  mergeDhakiraHooks(root, hookPath)
  await writeFile(settingsPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
}

export async function removeClaudeHooks(settingsPath = claudeSettingsPath()): Promise<void> {
  let root: ConfigRoot
  try {
    root = JSON.parse(await readFile(settingsPath, 'utf8')) as ConfigRoot
  } catch {
    return
  }
  removeDhakiraHooks(root)
  await writeFile(settingsPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
}

export async function mergeCodexHooks(
  hookPath: string,
  configPath = codexConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  const raw = await readOptional(configPath)
  const root = raw === null || raw.trim().length === 0 ? {} : parseCodexConfig(raw)
  mergeDhakiraHooks(root, hookPath)
  await writeFile(configPath, stringifyCodexConfig(root), 'utf8')
}

export async function removeCodexHooks(configPath = codexConfigPath()): Promise<void> {
  const raw = await readOptional(configPath)
  if (raw === null || raw.trim().length === 0) return
  const root = parseCodexConfig(raw)
  removeDhakiraHooks(root)
  await writeFile(configPath, stringifyCodexConfig(root), 'utf8')
}
