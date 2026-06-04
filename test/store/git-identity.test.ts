import cp from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRemoteUrl, readGitIdentity } from '../../src/store/git-identity.ts'

// ---------------------------------------------------------------------------
// parseRemoteUrl — INI section walk
// ---------------------------------------------------------------------------

describe('parseRemoteUrl', () => {
  it('prefers [remote "origin"]', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "upstream"]',
      '\turl = https://github.com/upstream/repo.git',
      '[remote "origin"]',
      '\turl = git@github.com:owner/repo.git',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n')
    expect(parseRemoteUrl(config)).toBe('git@github.com:owner/repo.git')
  })

  it('falls back to the first remote when there is no origin', () => {
    const config = ['[remote "upstream"]', '\turl = https://example.com/u/r.git'].join('\n')
    expect(parseRemoteUrl(config)).toBe('https://example.com/u/r.git')
  })

  it('returns null when there is no remote section', () => {
    expect(parseRemoteUrl('[core]\n\tbare = false\n')).toBeNull()
    expect(parseRemoteUrl('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// readGitIdentity — local-disk read + walk-up
// ---------------------------------------------------------------------------

describe('readGitIdentity — local disk only', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-identity-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedRepo(root: string, configBody: string): Promise<void> {
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'config'), configBody, 'utf8')
  }

  it('reads remote + root from .git/config', async () => {
    await seedRepo(dir, '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n')
    const id = await readGitIdentity(dir)
    expect(id.gitRemote).toBe('https://github.com/owner/repo.git')
    expect(id.gitRoot).toBe(dir)
  })

  it('walks UP from a subdirectory to find the repo root (stable across subdirs)', async () => {
    await seedRepo(dir, '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n')
    const sub = join(dir, 'packages', 'api', 'src')
    await mkdir(sub, { recursive: true })
    const id = await readGitIdentity(sub)
    expect(id.gitRemote).toBe('git@github.com:owner/repo.git')
    expect(id.gitRoot).toBe(dir)
  })

  it('a repo with no remote → gitRoot only (covers never-pushed local repos)', async () => {
    await seedRepo(dir, '[core]\n\tbare = false\n')
    const id = await readGitIdentity(dir)
    expect(id.gitRemote).toBeUndefined()
    expect(id.gitRoot).toBe(dir)
  })

  it('no git anywhere → no remote signal (degrades gracefully, never throws)', async () => {
    const plain = join(dir, 'plain', 'folder')
    await mkdir(plain, { recursive: true })
    const id = await readGitIdentity(plain)
    // No config we wrote → no remote. (gitRoot may be unset; we never invent one.)
    expect(id.gitRemote).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PRIVACY GUARD (core-soul invariant) — signal gathering is LOCAL-ONLY.
// Asserts ZERO outbound connections AND zero process spawns during a real read.
// ---------------------------------------------------------------------------

describe('readGitIdentity — PRIVACY INVARIANT: no network, no spawn', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-identity-privacy-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reads a real .git/config WITHOUT any TCP connect / http(s) request / child process', async () => {
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(
      join(dir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n',
      'utf8',
    )

    // net.Socket.prototype.connect is the universal chokepoint for ANY outbound
    // TCP (http, https, git protocol, GitHub) — the load-bearing assertion.
    const socketConnect = vi.spyOn(net.Socket.prototype, 'connect')
    const netConnect = vi.spyOn(net, 'connect')
    const httpReq = vi.spyOn(http, 'request')
    const httpGet = vi.spyOn(http, 'get')
    const httpsReq = vi.spyOn(https, 'request')
    const httpsGet = vi.spyOn(https, 'get')
    // "Do NOT shell out to git" — no child process of any kind.
    const spawn = vi.spyOn(cp, 'spawn')
    const exec = vi.spyOn(cp, 'exec')
    const execFile = vi.spyOn(cp, 'execFile')
    const spawnSync = vi.spyOn(cp, 'spawnSync')
    const execSync = vi.spyOn(cp, 'execSync')

    const id = await readGitIdentity(dir)

    // Prove the gather actually did its work (not a vacuous no-op).
    expect(id.gitRemote).toBe('https://github.com/owner/repo.git')

    // ...and did it entirely locally.
    expect(socketConnect).toHaveBeenCalledTimes(0)
    expect(netConnect).toHaveBeenCalledTimes(0)
    expect(httpReq).toHaveBeenCalledTimes(0)
    expect(httpGet).toHaveBeenCalledTimes(0)
    expect(httpsReq).toHaveBeenCalledTimes(0)
    expect(httpsGet).toHaveBeenCalledTimes(0)
    expect(spawn).toHaveBeenCalledTimes(0)
    expect(exec).toHaveBeenCalledTimes(0)
    expect(execFile).toHaveBeenCalledTimes(0)
    expect(spawnSync).toHaveBeenCalledTimes(0)
    expect(execSync).toHaveBeenCalledTimes(0)
  })
})
