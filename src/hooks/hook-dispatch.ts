// Shared stdin payload dispatcher for the bundled dhakira-hook.mjs entrypoint.
//
// Codex requires turn_id on both supported events; Claude Code does not emit it.
// That verified contract lets both tools point at the same marker-stable script
// without adding tool-specific command arguments to their hook configuration.

import { handleEvent as handleClaudeEvent } from './claude-code-adapter.js'
import { handleEvent as handleCodexEvent } from './codex-adapter.js'
import type { AdapterOptions } from './shared-adapter.js'

function isCodexPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.turn_id === 'string'
}

export async function dispatchHookEvent(
  event: string,
  payload: Record<string, unknown>,
  opts: AdapterOptions = {},
): Promise<string> {
  const handleEvent = isCodexPayload(payload) ? handleCodexEvent : handleClaudeEvent
  return handleEvent(event, payload, opts)
}
