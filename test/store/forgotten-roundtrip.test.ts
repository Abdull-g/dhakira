import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildMemoryContent,
  readMemoryForgottenAt,
  softForgetMemoryFile,
  writeMemoryFile,
} from '../../src/extraction/runner.ts'
import type { MemoryRecord } from '../../src/extraction/types.ts'

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    text: 'Senior backend engineer based in Riyadh',
    category: 'IDENTITY',
    confidence: 'HIGH',
    salienceScore: 0.92,
    salienceTier: 'standard',
    source: 'conv_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    invalidatedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

describe('forgottenAt write/read round-trip', () => {
  it('a set forgottenAt survives buildMemoryContent → readMemoryForgottenAt (ISO precision)', () => {
    const forgottenAt = new Date('2026-06-03T12:00:00.000Z')
    const content = buildMemoryContent(record({ forgottenAt }))
    expect(content).toMatch(/^forgottenAt: 2026-06-03T12:00:00\.000Z$/m)
    expect(readMemoryForgottenAt(content)?.toISOString()).toBe(forgottenAt.toISOString())
  })

  it('an ACTIVE memory (forgottenAt unset) emits NO forgottenAt line (byte-identical to pre-T06)', () => {
    const content = buildMemoryContent(record())
    expect(content).not.toMatch(/forgottenAt/)
    expect(readMemoryForgottenAt(content)).toBeNull()
  })
})

describe('readMemoryForgottenAt — backward-compatible read', () => {
  it('OLD memory file with NO forgottenAt line → null (active)', () => {
    const oldContent = [
      '---',
      'id: mem_old',
      'salienceTier: standard',
      'invalidatedAt: null',
      'expiresAt: null',
      '---',
      '',
      'Prefers tea over coffee',
    ].join('\n')
    expect(readMemoryForgottenAt(oldContent)).toBeNull()
  })

  it('explicit `forgottenAt: null` literal → null', () => {
    const content = ['---', 'forgottenAt: null', '---', '', 'body'].join('\n')
    expect(readMemoryForgottenAt(content)).toBeNull()
  })

  it('unparseable forgottenAt value → null (never throws)', () => {
    const content = ['---', 'forgottenAt: not-a-date', '---', '', 'body'].join('\n')
    expect(readMemoryForgottenAt(content)).toBeNull()
  })

  it('missing/empty frontmatter → null', () => {
    expect(readMemoryForgottenAt('no frontmatter at all')).toBeNull()
  })
})

describe('softForgetMemoryFile — anchored stamp, body-safe', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'forget-stamp-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('stamps forgottenAt as the last frontmatter line, readable back', async () => {
    await writeMemoryFile(walletDir, record({ id: 'mem_stamp' }))
    await softForgetMemoryFile(walletDir, 'mem_stamp')
    const content = await readFile(join(walletDir, 'memories', 'mem_stamp.md'), 'utf8')
    expect(readMemoryForgottenAt(content)).not.toBeNull()
    // forgottenAt sits inside the frontmatter, immediately before the closing fence.
    expect(content).toMatch(/forgottenAt: .+\n---\n/)
  })

  it('a body containing a `---` horizontal rule is NEVER corrupted (anchored regex)', async () => {
    const text = 'First paragraph.\n\n---\n\nSecond paragraph after a horizontal rule.'
    await writeMemoryFile(walletDir, record({ id: 'mem_hr', text }))
    await softForgetMemoryFile(walletDir, 'mem_hr')
    const content = await readFile(join(walletDir, 'memories', 'mem_hr.md'), 'utf8')
    // The stamp landed in frontmatter, and the body's horizontal rule survives intact.
    expect(readMemoryForgottenAt(content)).not.toBeNull()
    expect(content).toContain(
      'First paragraph.\n\n---\n\nSecond paragraph after a horizontal rule.',
    )
    // Exactly one forgottenAt line total (it did NOT also stamp the body's ---).
    expect((content.match(/^forgottenAt: /gm) ?? []).length).toBe(1)
  })

  it('malformed/missing frontmatter → NO write, file left byte-identical (skip guard)', async () => {
    const malformed = 'just body text\nwith a --- line\nbut no leading frontmatter\n'
    // Seed a valid memory so the memories/ dir exists, then drop a malformed file.
    await writeMemoryFile(walletDir, record({ id: 'seed' }))
    await writeFile(join(walletDir, 'memories', 'mem_bad.md'), malformed, 'utf8')

    await softForgetMemoryFile(walletDir, 'mem_bad')

    const after = await readFile(join(walletDir, 'memories', 'mem_bad.md'), 'utf8')
    expect(after).toBe(malformed)
    expect(readMemoryForgottenAt(after)).toBeNull()
  })
})
