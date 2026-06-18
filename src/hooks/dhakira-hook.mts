#!/usr/bin/env node
// Dhakira — Claude Code hook entrypoint (the script `dhakira connect claude-code`
// points Claude Code at). Deliberately trivial: read the event name from argv, the
// event JSON from stdin, hand both to the adapter, print whatever it returns, and
// ALWAYS exit 0. All real logic + the fail-open guarantees live in (and are tested
// in) claude-code-adapter.ts. This shim only does stdin/stdout/exit plumbing.
//
// Configured command: `node "<dist>/hooks/dhakira-hook.mjs" <EventName>`.

import { readFileSync } from 'node:fs'

import { handleEvent } from './claude-code-adapter.js'

async function main(): Promise<void> {
  const event = process.argv[2] ?? ''

  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>
  } catch {
    payload = {}
  }

  let out = ''
  try {
    out = await handleEvent(event, payload)
  } catch {
    out = ''
  }

  if (out.length > 0) process.stdout.write(`${out}\n`)
  process.exit(0)
}

main().catch(() => process.exit(0))
