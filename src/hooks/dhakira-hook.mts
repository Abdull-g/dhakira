#!/usr/bin/env node
// Dhakira — shared Claude Code/Codex hook entrypoint. Both tools point at this
// marker-stable script; hook-dispatch selects the stateless adapter from the
// verified payload contract. This shim only does stdin/stdout/exit plumbing and
// ALWAYS exits 0.
//
// Configured command: `node "<dist>/hooks/dhakira-hook.mjs" <EventName>`.

import { readFileSync } from 'node:fs'

import { dispatchHookEvent } from './hook-dispatch.js'

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
    out = await dispatchHookEvent(event, payload)
  } catch {
    out = ''
  }

  if (out.length > 0) process.stdout.write(`${out}\n`)
  process.exit(0)
}

main().catch(() => process.exit(0))
