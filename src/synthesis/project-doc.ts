// Project-doc storage layout (T08, CP4). The global identity stays in profile.md
// (unchanged, backward-compat); each project's synthesized doc lives at
// {walletDir}/projects/<slug>-<shorthash>.md.
//
// The filename is DETERMINISTIC and FORWARD-resolvable: the read path recomputes
// it from the request's projectId — no reverse map needed. The <slug> keeps it
// human-readable; the <shorthash> of the RAW projectId guarantees uniqueness even
// when two different ids slugify the same (e.g. git:a/b vs git:a-b). This mirrors
// the project.ts folderId convention (basename + shortHash).
//
// Backward-compat: no projects/ dir → loadProjectDoc returns null everywhere a
// project doc would be read, so the wallet behaves exactly like pre-T08.
//
// STANDING ORDER #7: imports nothing from src/proxy/ or src/dashboard/.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const GLOBAL_PROJECT_ID = 'global'

function resolveDir(walletDir: string): string {
  if (walletDir.startsWith('~/')) return join(homedir(), walletDir.slice(2))
  return walletDir
}

/** Sanitize a projectId into a safe, deterministic, collision-proof filename. */
export function projectDocFileName(projectId: string): string {
  const slug = projectId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 12)
  return `${slug.length > 0 ? slug : 'project'}-${hash}.md`
}

/** Absolute path to a project's doc file (does not check existence). */
export function projectDocPath(walletDir: string, projectId: string): string {
  return join(resolveDir(walletDir), 'projects', projectDocFileName(projectId))
}

/**
 * A short human-friendly label for the `## Project: <name>` header. Strips the
 * provenance prefix and keeps the identifying tail (repo name, folder basename,
 * tag). Returns '' for the global scope (no project header).
 */
export function projectDisplayName(projectId: string): string {
  if (projectId === GLOBAL_PROJECT_ID || projectId.length === 0) return ''
  const colon = projectId.indexOf(':')
  const prefix = colon === -1 ? '' : projectId.slice(0, colon)
  const body = colon === -1 ? projectId : projectId.slice(colon + 1)

  if (prefix === 'git') {
    // host/owner/repo → repo (the most recognizable segment).
    return body.split('/').filter(Boolean).pop() ?? body
  }
  if (prefix === 'folder') {
    // basename-<12hex> → basename.
    return body.replace(/-[0-9a-f]{12}$/, '')
  }
  return body
}

/**
 * Load a project's synthesized doc, or null when absent (or when the request is
 * global-scoped). Never throws — a missing projects/ dir or file degrades to null
 * so the read path falls back to global + Layer-1 exactly like pre-T08.
 */
export async function loadProjectDoc(walletDir: string, projectId: string): Promise<string | null> {
  if (projectId === GLOBAL_PROJECT_ID || projectId.length === 0) return null
  try {
    return await readFile(projectDocPath(walletDir, projectId), 'utf8')
  } catch {
    return null
  }
}

/** Write a project's synthesized doc (creates projects/ on first write). */
export async function writeProjectDoc(
  walletDir: string,
  projectId: string,
  content: string,
): Promise<void> {
  const dir = join(resolveDir(walletDir), 'projects')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, projectDocFileName(projectId)), content, 'utf8')
}

/**
 * Remove a project's doc (freshness: when a project's live memory set empties out,
 * its stale always-injected doc must disappear, not linger). ENOENT is ignored.
 */
export async function removeProjectDoc(walletDir: string, projectId: string): Promise<void> {
  try {
    await rm(projectDocPath(walletDir, projectId))
  } catch {
    // Already absent — nothing to remove.
  }
}
