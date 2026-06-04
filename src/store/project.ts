// Project identity (Step 7). The PURE resolver core — deterministic, NO I/O,
// NO model, NO network. Mirrors the tier-policy.ts / forget.ts purity discipline:
// the whole moat (cross-tool, cross-machine project continuity) lives here as
// plain signal→id logic and is exhaustively fixture-testable.
//
// LAPTOP-SAFE (non-negotiable, consolidation lesson): never loads a model, never
// guesses with an LLM. `resolveProjectId` is a pure function — same signals in,
// same id out. The I/O of reading git/cwd/headers happens at the EDGE (capture/
// inject), not here.
//
// TOOL-AGNOSTIC (Standing Order #7 + universality rule): this resolver is built
// ONCE and is identical for every tool. Nothing Claude-specific or Codex-specific
// lives in the resolver. The only per-tool seam is `sniffCwd`, which parses cwd
// out of whatever payload TEXT it is handed — it does not know or care which tool
// produced that text.
//
// PRIVACY INVARIANT: this file performs zero I/O and zero network. The git read
// that fills `gitRemote`/`gitRoot` is local-disk-only and happens at the edge.
import { createHash } from 'node:crypto'

/**
 * Normalized bag of project signals gathered by L1 at the edge.
 * Every field is optional — the resolver degrades gracefully down the ladder.
 */
export interface ProjectSignals {
  /** Explicit tag from the `X-Dhakira-Project` header / connect env (universal floor). */
  explicitTag?: string
  /** Raw git remote url, read LOCALLY off disk at the edge (never from GitHub). */
  gitRemote?: string
  /** Absolute path of the git toplevel (used when a repo has no remote yet). */
  gitRoot?: string
  /** Folder path sniffed from the tool payload (no git). */
  cwd?: string
  /** System-prompt fingerprint — today's mechanism, DEMOTED to last-resort fallback. */
  fingerprint?: string
}

/** Short, stable hash — same convention as proxy/fingerprint.ts (SHA-256, 12 hex). */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}

/**
 * Normalize a git remote url into a canonical, machine-independent id of the form
 * `host/owner/repo` (lowercased). THIS is what makes the project id stable across
 * machines and tools — the moat. Every clone of the same repo, however cloned,
 * collapses to one id:
 *   https://github.com/Owner/Repo.git        → github.com/owner/repo
 *   https://user:token@github.com/owner/repo  → github.com/owner/repo
 *   git@github.com:owner/repo.git             → github.com/owner/repo
 *   ssh://git@github.com:22/owner/repo.git    → github.com/owner/repo
 *
 * Strips protocol, userinfo, port (so https/ssh of the same repo collapse), and a
 * trailing `.git`. Returns null for anything it can't confidently parse — the
 * caller then falls through to the next rung. NEVER throws.
 */
export function normalizeGitRemote(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const s = raw.trim()
  if (s.length === 0) return null

  let authority: string
  let path: string

  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  if (scheme) {
    // URL form: scheme://[userinfo@]host[:port]/path
    const rest = s.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    authority = rest.slice(0, slash)
    path = rest.slice(slash + 1)
  } else {
    // scp-like form: [user@]host:path
    const at = s.lastIndexOf('@')
    const afterUser = at === -1 ? s : s.slice(at + 1)
    const colon = afterUser.indexOf(':')
    if (colon === -1) return null
    authority = afterUser.slice(0, colon)
    path = afterUser.slice(colon + 1)
  }

  // Strip userinfo (anything up to and including '@') then the port.
  const at = authority.lastIndexOf('@')
  if (at !== -1) authority = authority.slice(at + 1)
  const host = authority.replace(/:\d+$/, '').trim()

  // Strip leading/trailing slashes, a trailing `.git`, then any leftover slash.
  const repoPath = path
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')

  if (host.length === 0 || repoPath.length === 0) return null
  return `${host}/${repoPath}`.toLowerCase()
}

/**
 * Normalize a user/tool-declared project tag into a safe slug. Keeps alnum plus
 * `._/-` (so tags like `payments/api` survive), collapses any other run to `-`,
 * trims stray dashes. Returns null when nothing usable remains.
 */
export function slugifyTag(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return slug.length === 0 ? null : slug
}

/**
 * Build a folder-based id: `folder:<basename>-<shorthash(absPath)>`.
 * The basename keeps it human-readable; the hash of the absolute path keeps two
 * different projects that share a basename (~/work/api vs ~/play/api) distinct.
 * This rung only needs single-machine stability — cross-machine stability is the
 * git rung's job, by design. Returns null for an empty/rootless path.
 */
export function folderId(path: string | undefined): string | null {
  if (path === undefined) return null
  const trimmed = path.trim().replace(/[/\\]+$/, '')
  if (trimmed.length === 0) return null
  const base = trimmed.split(/[/\\]/).filter(Boolean).pop()
  if (base === undefined || base.length === 0) return null
  return `folder:${base.toLowerCase()}-${shortHash(trimmed)}`
}

/**
 * Resolve a stable, normalized projectId from gathered signals. PURE: same
 * signals → same id. The prefix is a PROVENANCE/CONFIDENCE marker:
 *   explicit:<slug>            — user/tool declared intent (always wins)
 *   git:host/owner/repo        — rock-solid, machine-independent (the moat)
 *   folder:<basename>-<hash>   — decent, single-machine
 *   fp:<hash>                  — weak guess (demoted fingerprint fallback)
 *   global                     — default sentinel (never breaks; today's behavior)
 *
 * Applies the identity ladder in priority order. NEVER throws; missing everything
 * → "global".
 */
export function resolveProjectId(signals: ProjectSignals): string {
  // 1. Explicit declared intent — always wins (header / connect env).
  const explicit = slugifyTag(signals.explicitTag)
  if (explicit !== null) return `explicit:${explicit}`

  // 2. git remote — canonical, machine-independent. THE moat.
  const remote = normalizeGitRemote(signals.gitRemote)
  if (remote !== null) return `git:${remote}`

  // 3. Folder path. Prefer the git toplevel (covers private/never-pushed repos
  //    with no remote) over a plain cwd; both are absolute paths.
  const folder = folderId(signals.gitRoot ?? signals.cwd)
  if (folder !== null) return folder

  // 4. Fingerprint fallback — demoted so nothing regresses, never a direct moat.
  const fp = signals.fingerprint?.trim()
  if (fp !== undefined && fp.length > 0 && fp !== 'default') return `fp:${fp}`

  // 5. Default scope — worst case equals current behavior.
  return 'global'
}

/**
 * Sniff an absolute cwd path out of a tool's request payload TEXT. Tool-agnostic
 * on purpose: it recognizes the two known dynamic-context shapes and returns the
 * first hit, without knowing which tool produced the text.
 *
 *   - Codex (Responses API):  <environment_context><cwd>/abs/path</cwd>...   (most reliable)
 *   - Claude Code (system prompt dynamic section):  "- Primary working directory: /abs/path"
 *
 * NOTE (build split, do NOT lose): the Codex `<cwd>` BRAIN ships here in T07 and
 * is proven against both fixture shapes. Wiring `/v1/responses` into
 * classifyProviderByUrl + a Responses-API normalizer so Codex traffic actually
 * reaches the parsed path is a DELIVERY follow-up (T07.1), not engine logic.
 *
 * Returns null when no cwd marker is present (e.g. the user disabled the dynamic
 * section) — the caller degrades gracefully down the ladder.
 */
export function sniffCwd(payloadText: string | null | undefined): string | null {
  if (payloadText === null || payloadText === undefined || payloadText.length === 0) return null

  // Codex: explicit <cwd> tag.
  const codex = payloadText.match(/<cwd>\s*([^<\n]+?)\s*<\/cwd>/)
  if (codex?.[1] !== undefined) {
    const cwd = codex[1].trim()
    if (cwd.length > 0) return cwd
  }

  // Claude Code: "Primary working directory:" prose line (verified marker; accept
  // a bare "Working directory:" too, defensively).
  const cc = payloadText.match(
    /(?:Primary working directory|Working directory)\s*:\s*([^\n]+?)\s*$/m,
  )
  if (cc?.[1] !== undefined) {
    const cwd = cc[1].trim()
    if (cwd.length > 0) return cwd
  }

  return null
}
