// ⛔ CURSOR CONNECTOR PARKED — DO NOT WIRE. ⛔
//
// Harvested verbatim (mechanical config-merge plumbing) from the April hooks
// prototype during T09 CP0. Codex's stale hooks.json/codex_hooks implementation
// was removed in T10; current Codex wiring lives in hook-config.ts. Only the
// still-dormant Cursor connector remains here.
//
// It is intentionally DORMANT:
//   - nothing imports this file,
//   - no CLI command reaches it,
//   - no route registers it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DHAKIRA_HOOK_MARKER, hookCommand } from './hook-config.js'

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
