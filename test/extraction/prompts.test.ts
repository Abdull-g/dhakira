// v0.3.1 G4.2 — the extraction prompt must ask for REASONING (decisions, rejected
// alternatives, conventions, gotchas) that the assistant stated and the user
// accepted, while still forbidding code itself. Locks the contract so a later
// prompt edit cannot silently reinstate the "never read ## Assistant" ban that
// starved project docs of every "why".

import { describe, expect, it } from 'vitest'

import { EXTRACT_PROMPT, fillTemplate, PROJECT_DOC_PROMPT } from '../../src/extraction/prompts.ts'

describe('EXTRACT_PROMPT — reasoning over code (G4.2)', () => {
  it('no longer bans reading ## Assistant outright', () => {
    expect(EXTRACT_PROMPT).not.toMatch(/NEVER extract facts from lines under "## Assistant"/)
    expect(EXTRACT_PROMPT).not.toMatch(/ONLY extract facts from lines under "## User"/)
  })

  it('asks for accepted reasoning from the assistant: decisions, rejected alternatives, conventions, gotchas', () => {
    expect(EXTRACT_PROMPT).toMatch(/decisions made and why/i)
    expect(EXTRACT_PROMPT).toMatch(/alternatives considered and rejected/i)
    expect(EXTRACT_PROMPT).toMatch(/conventions adopted/i)
    expect(EXTRACT_PROMPT).toMatch(/dead-ends and gotchas/i)
    expect(EXTRACT_PROMPT).toMatch(/user did not contest/i)
  })

  it('still forbids extracting code, commands, paths or config values themselves', () => {
    expect(EXTRACT_PROMPT).toMatch(
      /NEVER extract code, commands, file paths, or configuration values/,
    )
  })

  it('tells the model to ignore storage placeholders and injected tags', () => {
    expect(EXTRACT_PROMPT).toContain('[code block: ts, 42 lines]')
    expect(EXTRACT_PROMPT).toContain('[REDACTED]')
    expect(EXTRACT_PROMPT).toContain('<dhakira_context>')
  })

  it('keeps the correction/confirmation rules and the CONTEXT category carries decisions', () => {
    expect(EXTRACT_PROMPT).toMatch(/If the user CONFIRMS an assistant statement/)
    expect(EXTRACT_PROMPT).toMatch(/If the user CORRECTS an assistant statement/)
    expect(EXTRACT_PROMPT).toMatch(/CONTEXT:.*project decisions with their rationale/)
  })

  it('template placeholders still fill', () => {
    const filled = fillTemplate(EXTRACT_PROMPT, {
      existing_profile: 'P',
      rolling_summary: 'S',
      conversation_date: '2026-09-06',
      conversation: 'C',
    })
    expect(filled).not.toMatch(
      /\{(existing_profile|rolling_summary|conversation_date|conversation)\}/,
    )
  })
})

describe('PROJECT_DOC_PROMPT consumes accepted assistant reasoning', () => {
  it('treats assistant-stated, user-accepted reasoning as project knowledge and forbids code', () => {
    expect(PROJECT_DOC_PROMPT).toMatch(/reasoning the assistant stated and the user accepted/i)
    expect(PROJECT_DOC_PROMPT).toMatch(/Never reproduce code, commands, or config values/)
  })
})
