import { describe, expect, it } from 'vitest'

import {
  canonicalProjectId,
  folderId,
  normalizeGitRemote,
  type ProjectSignals,
  resolveProjectId,
  slugifyTag,
  sniffCwd,
} from '../../src/store/project.ts'

function signals(overrides: Partial<ProjectSignals> = {}): ProjectSignals {
  return { ...overrides }
}

// ---------------------------------------------------------------------------
// normalizeGitRemote — the canonical, machine-independent id (the moat core)
// ---------------------------------------------------------------------------

describe('normalizeGitRemote — protocol/auth/suffix all collapse to one id', () => {
  const canonical = 'github.com/owner/repo'

  it('https with .git', () => {
    expect(normalizeGitRemote('https://github.com/owner/repo.git')).toBe(canonical)
  })
  it('https without .git', () => {
    expect(normalizeGitRemote('https://github.com/owner/repo')).toBe(canonical)
  })
  it('https with embedded userinfo (token)', () => {
    expect(normalizeGitRemote('https://user:ghp_token@github.com/owner/repo.git')).toBe(canonical)
  })
  it('scp-like git@ form', () => {
    expect(normalizeGitRemote('git@github.com:owner/repo.git')).toBe(canonical)
  })
  it('ssh:// form with explicit port', () => {
    expect(normalizeGitRemote('ssh://git@github.com:22/owner/repo.git')).toBe(canonical)
  })
  it('git:// form', () => {
    expect(normalizeGitRemote('git://github.com/owner/repo.git')).toBe(canonical)
  })
  it('mixed case host + owner collapse via lowercasing', () => {
    expect(normalizeGitRemote('https://GitHub.com/Owner/Repo.git')).toBe(canonical)
  })
  it('trailing slash is stripped', () => {
    expect(normalizeGitRemote('https://github.com/owner/repo/')).toBe(canonical)
  })

  it('non-github host is preserved', () => {
    expect(normalizeGitRemote('git@gitlab.example.com:team/sub/proj.git')).toBe(
      'gitlab.example.com/team/sub/proj',
    )
  })

  it('garbage / non-remote → null (caller falls through, never throws)', () => {
    expect(normalizeGitRemote('not a remote at all')).toBeNull()
    expect(normalizeGitRemote('')).toBeNull()
    expect(normalizeGitRemote('   ')).toBeNull()
    expect(normalizeGitRemote(undefined)).toBeNull()
    expect(normalizeGitRemote('https://github.com')).toBeNull() // no path
  })
})

// ---------------------------------------------------------------------------
// slugifyTag — explicit declared intent
// ---------------------------------------------------------------------------

describe('slugifyTag', () => {
  it('lowercases and keeps ._/- , collapses other runs to dash', () => {
    expect(slugifyTag('Payments API')).toBe('payments-api')
    expect(slugifyTag('payments/api')).toBe('payments/api')
    expect(slugifyTag('  My  Cool   Repo!! ')).toBe('my-cool-repo')
  })
  it('empty / whitespace / undefined → null', () => {
    expect(slugifyTag('')).toBeNull()
    expect(slugifyTag('   ')).toBeNull()
    expect(slugifyTag('!!!')).toBeNull()
    expect(slugifyTag(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// folderId — single-machine stable, basename + abspath hash
// ---------------------------------------------------------------------------

describe('folderId', () => {
  it('is deterministic for the same absolute path', () => {
    expect(folderId('/home/me/work/api')).toBe(folderId('/home/me/work/api'))
  })
  it('same basename, different parent → different ids (no false collision)', () => {
    expect(folderId('/home/me/work/api')).not.toBe(folderId('/home/me/play/api'))
  })
  it('starts with folder:<basename>-', () => {
    expect(folderId('/home/me/work/api')).toMatch(/^folder:api-[0-9a-f]{12}$/)
  })
  it('trailing slash does not change identity', () => {
    expect(folderId('/home/me/work/api/')).toBe(folderId('/home/me/work/api'))
  })
  it('empty / rootless → null', () => {
    expect(folderId('')).toBeNull()
    expect(folderId('   ')).toBeNull()
    expect(folderId('/')).toBeNull()
    expect(folderId(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveProjectId — the identity ladder
// ---------------------------------------------------------------------------

// v0.3.1 (audit D12): an explicit id that is ALREADY canonical passes through, so the
// same project cannot split into `git:…` (proxy-resolved) and `explicit:git-…` (hook).
describe('resolveProjectId — canonical explicit ids pass through (D12)', () => {
  it.each([
    'git:github.com/acme/widgets',
    'folder:repo-1a2b3c',
    'explicit:payments',
    'fp:abc123def456',
  ])('keeps %s as-is instead of re-wrapping it', (id) => {
    expect(resolveProjectId(signals({ explicitTag: id, cwd: '/home/me/other' }))).toBe(id)
    expect(canonicalProjectId(id)).toBe(id)
  })

  it('"global" as an explicit id is the global sentinel, not explicit:global', () => {
    expect(resolveProjectId(signals({ explicitTag: 'global', cwd: '/home/me/repo' }))).toBe(
      'global',
    )
  })

  it('a human tag still becomes explicit:<slug> (the proxy header behaviour, now shared by hooks)', () => {
    expect(resolveProjectId(signals({ explicitTag: 'My Payments App' }))).toBe(
      'explicit:my-payments-app',
    )
    expect(canonicalProjectId('My Payments App')).toBeNull()
    expect(canonicalProjectId('')).toBeNull()
    expect(canonicalProjectId('git:')).toBeNull() // a bare scheme is not an id
  })
})

describe('resolveProjectId — ladder priority', () => {
  it('explicit tag wins over everything', () => {
    const id = resolveProjectId(
      signals({
        explicitTag: 'payments',
        gitRemote: 'git@github.com:owner/repo.git',
        cwd: '/home/me/repo',
        fingerprint: 'abc123',
      }),
    )
    expect(id).toBe('explicit:payments')
  })

  it('git remote wins over folder + fingerprint', () => {
    const id = resolveProjectId(
      signals({
        gitRemote: 'https://github.com/owner/repo.git',
        gitRoot: '/home/me/repo',
        cwd: '/home/me/repo',
        fingerprint: 'abc123',
      }),
    )
    expect(id).toBe('git:github.com/owner/repo')
  })

  it('gitRoot (no remote) → folder id, preferred over cwd', () => {
    const id = resolveProjectId(signals({ gitRoot: '/home/me/local-repo', cwd: '/somewhere/else' }))
    expect(id).toBe(folderId('/home/me/local-repo'))
  })

  it('cwd only → folder id', () => {
    const id = resolveProjectId(signals({ cwd: '/home/me/plain-folder' }))
    expect(id).toBe(folderId('/home/me/plain-folder'))
  })

  it('fingerprint only → fp: fallback', () => {
    expect(resolveProjectId(signals({ fingerprint: 'deadbeef0000' }))).toBe('fp:deadbeef0000')
  })

  it("fingerprint 'default' is NOT used → global", () => {
    expect(resolveProjectId(signals({ fingerprint: 'default' }))).toBe('global')
  })

  it('nothing at all → global', () => {
    expect(resolveProjectId(signals())).toBe('global')
  })

  it('malformed git remote falls through to cwd gracefully (never throws)', () => {
    const id = resolveProjectId(signals({ gitRemote: '@@@garbage@@@', cwd: '/home/me/repo' }))
    expect(id).toBe(folderId('/home/me/repo'))
  })
})

// ---------------------------------------------------------------------------
// THE MOAT TESTS (called out explicitly in the ticket)
// ---------------------------------------------------------------------------

describe('resolveProjectId — moat invariants', () => {
  it('same repo, two clone paths → SAME id (via gitRemote). The moat.', () => {
    const machineA = resolveProjectId(
      signals({ gitRemote: 'git@github.com:owner/repo.git', cwd: '/home/alice/code/repo' }),
    )
    const machineB = resolveProjectId(
      signals({ gitRemote: 'https://github.com/owner/repo.git', cwd: '/Users/bob/dev/repo' }),
    )
    expect(machineA).toBe(machineB)
    expect(machineA).toBe('git:github.com/owner/repo')
  })

  it('same repo, two tools (DIFFERENT fingerprints) → SAME id. Cross-tool.', () => {
    const claudeCode = resolveProjectId(
      signals({ gitRemote: 'https://github.com/owner/repo.git', fingerprint: 'claude111111' }),
    )
    const codex = resolveProjectId(
      signals({ gitRemote: 'https://github.com/owner/repo.git', fingerprint: 'codex2222222' }),
    )
    expect(claudeCode).toBe(codex)
  })

  it('two similar boilerplates (near-identical fingerprints) → DIFFERENT ids', () => {
    // Today fingerprints would near-collide; gitRemote disambiguates → fixes false bleed.
    const fp = 'samelooking00'
    const projA = resolveProjectId(
      signals({ gitRemote: 'https://github.com/owner/next-app-a.git', fingerprint: fp }),
    )
    const projB = resolveProjectId(
      signals({ gitRemote: 'https://github.com/owner/next-app-b.git', fingerprint: fp }),
    )
    expect(projA).not.toBe(projB)
  })
})

// ---------------------------------------------------------------------------
// sniffCwd — the only per-tool seam, proven tool-agnostically
// ---------------------------------------------------------------------------

describe('sniffCwd — tool-agnostic cwd extraction', () => {
  it('Codex: extracts <cwd> from <environment_context>', () => {
    const payload =
      'some prefix\n<environment_context>\n  <cwd>/Users/mbolin/code/codex5</cwd>\n  <shell>zsh</shell>\n</environment_context>'
    expect(sniffCwd(payload)).toBe('/Users/mbolin/code/codex5')
  })

  it('Claude Code: extracts "Primary working directory:" prose line (corpus-verified shape)', () => {
    const payload =
      'You are operating in the following environment: \n - Primary working directory: /home/tester/corpus-test\n - Is a git repository: false\n - Platform: linux'
    expect(sniffCwd(payload)).toBe('/home/tester/corpus-test')
  })

  it('accepts a bare "Working directory:" defensively', () => {
    expect(sniffCwd('Working directory: /tmp/proj')).toBe('/tmp/proj')
  })

  it('Codex tag wins when both shapes are present', () => {
    const payload = 'Primary working directory: /a\n<cwd>/b</cwd>'
    expect(sniffCwd(payload)).toBe('/b')
  })

  it('no marker (e.g. dynamic section disabled) → null', () => {
    expect(sniffCwd('a generic system prompt with no cwd anywhere')).toBeNull()
    expect(sniffCwd('')).toBeNull()
    expect(sniffCwd(null)).toBeNull()
    expect(sniffCwd(undefined)).toBeNull()
  })

  it('end-to-end: sniffed Codex cwd (no git) → stable folder id', () => {
    const cwd = sniffCwd('<cwd>/Users/me/proj</cwd>')
    expect(resolveProjectId(signals({ cwd: cwd ?? undefined }))).toBe(folderId('/Users/me/proj'))
  })
})
