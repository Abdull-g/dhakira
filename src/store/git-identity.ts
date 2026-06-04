// Local git identity read (Step 7, the L1 edge — the ONE risky bit, isolated).
//
// PRIVACY INVARIANT (core-soul, non-negotiable): this reads ONLY local disk —
// it walks up for a `.git` and parses `.git/config`. It NEVER spawns a process,
// NEVER calls git, NEVER touches the network, and NEVER contacts GitHub. Reading
// `.git/config` directly (rather than shelling `git config`) is deliberate: fewer
// moving parts and zero chance of an outbound connection. The privacy-guard test
// asserts no network call happens here.
//
// NEVER THROWS into the capture path: any failure (no repo, unreadable config,
// malformed pointer) degrades to "no signal" → {} → the resolver falls to the
// next rung. Capture is additive; project-stamping must never break a capture.
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface GitIdentity {
  /** Raw `remote.origin.url` (or first remote) read from `.git/config`, if any. */
  gitRemote?: string
  /** Absolute path of the git toplevel (the dir containing `.git`), if found. */
  gitRoot?: string
}

/** Walk up from `startDir` looking for a `.git` (dir OR file). Returns the toplevel. */
async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir)
  // Bounded walk — never loop forever on odd filesystems.
  for (let i = 0; i < 64; i++) {
    try {
      const st = await stat(join(dir, '.git'))
      if (st.isDirectory() || st.isFile()) return dir
    } catch {
      // no .git here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Resolve the path to the `config` file for a repo rooted at `root`.
 * - `.git` is a directory → `root/.git/config` (the common case).
 * - `.git` is a file (submodule / worktree) → follow `gitdir:`; if that dir has a
 *   `commondir` pointer, the real config lives there (worktrees share one config).
 */
async function resolveConfigPath(root: string): Promise<string | null> {
  const dotgit = join(root, '.git')
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(dotgit)
  } catch {
    return null
  }

  if (st.isDirectory()) return join(dotgit, 'config')

  // `.git` is a file: "gitdir: <path>"
  let pointer: string
  try {
    pointer = await readFile(dotgit, 'utf8')
  } catch {
    return null
  }
  const m = pointer.match(/^gitdir:\s*(.+)$/m)
  if (!m?.[1]) return null
  const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim())

  // Worktrees keep config in the common dir, not the per-worktree gitdir.
  try {
    const common = await readFile(join(gitdir, 'commondir'), 'utf8')
    const commonTrimmed = common.trim()
    const commonDir = isAbsolute(commonTrimmed) ? commonTrimmed : resolve(gitdir, commonTrimmed)
    return join(commonDir, 'config')
  } catch {
    return join(gitdir, 'config')
  }
}

/**
 * Parse a git config INI for a remote url. Prefers `[remote "origin"]`, falling
 * back to the first remote found (better a non-origin remote than no moat at all).
 * Returns null when there is no remote.
 */
/** If `line` opens a section, return its remote name (or null for non-remote sections). */
function remoteSectionName(line: string): string | null {
  return line.match(/^\[remote\s+"([^"]+)"\]/)?.[1] ?? null
}

/** Extract a `url = ...` value from a config line, if present. */
function configUrl(line: string): string | null {
  return line.match(/^url\s*=\s*(.+)$/)?.[1]?.trim() ?? null
}

export function parseRemoteUrl(config: string): string | null {
  let inRemote: string | null = null
  let originUrl: string | null = null
  let firstUrl: string | null = null

  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inRemote = remoteSectionName(line)
      continue
    }
    if (inRemote === null) continue
    const url = configUrl(line)
    if (url === null) continue
    if (firstUrl === null) firstUrl = url
    if (inRemote === 'origin' && originUrl === null) originUrl = url
  }

  return originUrl ?? firstUrl
}

/**
 * Read the local git identity for a starting directory. Local-disk only, never
 * network, never throws. Returns {} when there is no git repo or nothing readable.
 */
export async function readGitIdentity(startDir: string): Promise<GitIdentity> {
  try {
    // Only read git for a directory that actually exists ON THIS MACHINE. A cwd
    // sniffed from a payload may be foreign (hosted, or another machine) — walking
    // up a non-existent path would be pointless and could even latch onto an
    // unrelated ancestor `.git`. No local dir → no local signal → next rung.
    try {
      const st = await stat(startDir)
      if (!st.isDirectory()) return {}
    } catch {
      return {}
    }

    const root = await findGitRoot(startDir)
    if (root === null) return {}

    const configPath = await resolveConfigPath(root)
    if (configPath === null) return { gitRoot: root }

    let config: string
    try {
      config = await readFile(configPath, 'utf8')
    } catch {
      return { gitRoot: root }
    }

    const remote = parseRemoteUrl(config)
    return remote === null ? { gitRoot: root } : { gitRoot: root, gitRemote: remote }
  } catch {
    // Defense in depth — the edge must never throw into capture.
    return {}
  }
}
