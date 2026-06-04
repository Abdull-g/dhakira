import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  loadProjectDoc,
  projectDisplayName,
  projectDocFileName,
  projectDocPath,
  removeProjectDoc,
  writeProjectDoc,
} from '../../src/synthesis/project-doc.ts'

// ───────────────────────────────────────────────────────────────────────────
// Filename sanitization — deterministic, safe, collision-proof
// ───────────────────────────────────────────────────────────────────────────
describe('projectDocFileName — sanitization', () => {
  it('is deterministic for the same projectId', () => {
    expect(projectDocFileName('git:github.com/owner/repo')).toBe(
      projectDocFileName('git:github.com/owner/repo'),
    )
  })

  it('produces a filesystem-safe name (no slashes/colons) ending in .md', () => {
    const name = projectDocFileName('git:github.com/owner/repo')
    expect(name).toMatch(/^[a-z0-9._-]+\.md$/)
    expect(name).not.toContain('/')
    expect(name).not.toContain(':')
  })

  it('distinguishes ids that slugify the same via the raw-id hash (no collision)', () => {
    // 'git:a/b' and 'git:a-b' both slugify toward "git-a-b" — the hash keeps them apart.
    expect(projectDocFileName('git:a/b')).not.toBe(projectDocFileName('git:a-b'))
  })

  it('keeps a human-readable slug head', () => {
    expect(projectDocFileName('git:github.com/owner/repo')).toMatch(/^git-github\.com-owner-repo-/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Display name — the `## Project: <name>` label
// ───────────────────────────────────────────────────────────────────────────
describe('projectDisplayName', () => {
  it('git id → repo name (the recognizable tail)', () => {
    expect(projectDisplayName('git:github.com/owner/repo')).toBe('repo')
  })
  it('folder id → basename (drops the -<12hex> suffix)', () => {
    expect(projectDisplayName('folder:api-ab12cd34ef56')).toBe('api')
  })
  it('explicit tag → the tag body', () => {
    expect(projectDisplayName('explicit:payments')).toBe('payments')
  })
  it('global / empty → no name', () => {
    expect(projectDisplayName('global')).toBe('')
    expect(projectDisplayName('')).toBe('')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Storage round-trip — write / load / remove (forward-resolvable, no reverse map)
// ───────────────────────────────────────────────────────────────────────────
describe('project-doc storage round-trip', () => {
  let walletDir: string

  beforeEach(async () => {
    walletDir = await mkdtemp(join(tmpdir(), 'project-doc-'))
  })
  afterEach(async () => {
    await rm(walletDir, { recursive: true, force: true })
  })

  it('writes a doc, then loads it back by recomputing the filename from the projectId', async () => {
    const projectId = 'git:github.com/owner/repo'
    await writeProjectDoc(walletDir, projectId, 'What this is: a tool')

    const loaded = await loadProjectDoc(walletDir, projectId)
    expect(loaded).toBe('What this is: a tool')

    // The file actually lives at projects/<slug>-<hash>.md.
    const onDisk = await readFile(projectDocPath(walletDir, projectId), 'utf8')
    expect(onDisk).toBe('What this is: a tool')
  })

  it('a global-scoped request never reads a project doc (returns null)', async () => {
    expect(await loadProjectDoc(walletDir, 'global')).toBeNull()
  })

  it('no projects/ dir → loadProjectDoc returns null (pre-T08 behavior)', async () => {
    expect(await loadProjectDoc(walletDir, 'git:github.com/owner/repo')).toBeNull()
  })

  it('removeProjectDoc deletes the doc (freshness) and is a no-op when already absent', async () => {
    const projectId = 'explicit:payments'
    await writeProjectDoc(walletDir, projectId, 'body')
    expect(await loadProjectDoc(walletDir, projectId)).toBe('body')

    await removeProjectDoc(walletDir, projectId)
    expect(await loadProjectDoc(walletDir, projectId)).toBeNull()

    // Removing again must not throw.
    await expect(removeProjectDoc(walletDir, projectId)).resolves.toBeUndefined()
  })
})
