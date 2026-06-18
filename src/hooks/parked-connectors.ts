// ⛔ PARKED FOR T10 — DO NOT WIRE. ⛔
//
// Harvested verbatim (mechanical config-merge plumbing) from the April hooks
// prototype `archive/hooks-v0.2-apr30` during T09 CP0, while the parts bin was
// open. These are the Codex (`~/.codex/config.toml` + `~/.codex/hooks.json`) and
// Cursor (`~/.cursor/hooks.json`) connect/disconnect mergers.
//
// They are intentionally DORMANT in T09:
//   - nothing imports this file,
//   - no CLI command reaches it,
//   - no route registers it.
// The T09 ticket ships Claude FIRST and ALONE; Codex is T10, Cursor is later.
// This file is kept fully self-contained (its own marker + command helpers) so it
// CANNOT touch the Claude slice. When T10 activates it, fold the duplicated
// helpers into a shared hook-config module.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// --- Self-contained copies of the shared hook helpers (see header note) -------

const DHAKIRA_HOOK_MARKER = 'dhakira-hook.mjs'

function hookCommand(hookPath: string, event: 'UserPromptSubmit' | 'Stop'): string {
  return `node "${hookPath}" ${event} 2>/dev/null`
}

// --- Codex: ~/.codex/config.toml [features] codex_hooks = true ----------------

export async function ensureCodexHooksFeature(): Promise<void> {
  const configPath = join(homedir(), '.codex', 'config.toml')
  await mkdir(dirname(configPath), { recursive: true })
  let text = ''
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    // missing
  }

  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(text)) {
    return
  }
  if (/^\s*codex_hooks\s*=\s*false\s*$/m.test(text)) {
    text = text.replace(/^\s*codex_hooks\s*=\s*false\s*$/m, 'codex_hooks = true')
    await writeFile(configPath, text, 'utf8')
    return
  }
  if (text.includes('[features]')) {
    if (!/codex_hooks\s*=/.test(text)) {
      text = text.replace(/(\[features\]\s*\n)/, '$1codex_hooks = true\n')
      await writeFile(configPath, text, 'utf8')
    }
    return
  }
  const addition = text.trim().length > 0 ? `${text.trimEnd()}\n\n` : ''
  await writeFile(configPath, `${addition}[features]\ncodex_hooks = true\n`, 'utf8')
}

// --- Codex: ~/.codex/hooks.json ----------------------------------------------

type CodexHooksRoot = {
  hooks?: Record<
    string,
    Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>
  >
}

export async function mergeCodexHooksJson(hookPath: string): Promise<void> {
  const hooksPath = join(homedir(), '.codex', 'hooks.json')
  await mkdir(dirname(hooksPath), { recursive: true })
  let root: CodexHooksRoot = {}
  try {
    root = JSON.parse(await readFile(hooksPath, 'utf8')) as CodexHooksRoot
  } catch {
    // new
  }
  const hooks = root.hooks ?? {}

  const mergeEvent = (event: 'UserPromptSubmit' | 'Stop'): void => {
    const cmd = hookCommand(hookPath, event)
    const blocks = hooks[event] ?? []
    const already = blocks.some((b) =>
      b.hooks?.some(
        (h) => typeof h.command === 'string' && h.command.includes(DHAKIRA_HOOK_MARKER),
      ),
    )
    if (already) return
    blocks.push({
      matcher: '',
      hooks: [{ type: 'command', command: cmd }],
    })
    hooks[event] = blocks
  }

  mergeEvent('UserPromptSubmit')
  mergeEvent('Stop')
  root.hooks = hooks
  await writeFile(hooksPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
}

export async function removeCodexHooks(): Promise<void> {
  const hooksPath = join(homedir(), '.codex', 'hooks.json')
  try {
    const root = JSON.parse(await readFile(hooksPath, 'utf8')) as CodexHooksRoot
    const hooks = root.hooks
    if (!hooks || typeof hooks !== 'object') return
    type Block = { matcher?: string; hooks?: Array<{ type: string; command: string }> }
    for (const key of Object.keys(hooks)) {
      const blocks = hooks[key] as Block[] | undefined
      if (!Array.isArray(blocks)) continue
      hooks[key] = blocks
        .map((b) => ({
          ...b,
          hooks: (b.hooks ?? []).filter(
            (h) => typeof h.command !== 'string' || !h.command.includes(DHAKIRA_HOOK_MARKER),
          ),
        }))
        .filter((b) => (b.hooks?.length ?? 0) > 0)
    }
    root.hooks = hooks
    await writeFile(hooksPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  } catch {
    // missing
  }
}

// --- Cursor: ~/.cursor/hooks.json (capture-only Stop hook) -------------------

type CursorHooksFile = {
  version?: number
  hooks?: Record<string, Array<{ command?: string; type?: string }>>
}

export async function mergeCursorStopHook(hookPath: string): Promise<void> {
  const hooksPath = join(homedir(), '.cursor', 'hooks.json')
  await mkdir(dirname(hooksPath), { recursive: true })
  let root: CursorHooksFile = { version: 1, hooks: {} }
  try {
    root = JSON.parse(await readFile(hooksPath, 'utf8')) as CursorHooksFile
  } catch {
    // new
  }
  if (root.version === undefined) {
    root.version = 1
  }
  const hooks = root.hooks ?? {}
  const stopList = hooks.stop ?? []
  const cmd = hookCommand(hookPath, 'Stop')
  const already = stopList.some(
    (h) => typeof h.command === 'string' && h.command.includes(DHAKIRA_HOOK_MARKER),
  )
  if (!already) {
    stopList.push({ command: cmd })
    hooks.stop = stopList
  }
  root.hooks = hooks
  await writeFile(hooksPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
}

export async function removeCursorHook(): Promise<void> {
  const hooksPath = join(homedir(), '.cursor', 'hooks.json')
  try {
    const root = JSON.parse(await readFile(hooksPath, 'utf8')) as CursorHooksFile
    const hooks = root.hooks
    if (!hooks?.stop) return
    hooks.stop = hooks.stop.filter(
      (h) => typeof h.command !== 'string' || !h.command.includes(DHAKIRA_HOOK_MARKER),
    )
    root.hooks = hooks
    await writeFile(hooksPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  } catch {
    // missing
  }
}
