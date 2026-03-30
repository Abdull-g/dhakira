// Load + manage profile.md with mtime-based cache invalidation

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '../proxy/types.js'

interface ProfileCache {
  content: string
  mtimeMs: number
}

const cache = new Map<string, ProfileCache>()

function resolveDir(walletDir: string): string {
  if (walletDir.startsWith('~/')) {
    return join(homedir(), walletDir.slice(2))
  }
  return walletDir
}

export async function loadProfile(walletDir: string): Promise<Result<string>> {
  const profilePath = join(resolveDir(walletDir), 'profile.md')

  let mtimeMs: number
  try {
    const stats = await stat(profilePath)
    mtimeMs = stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: '' }
    }
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }

  const cached = cache.get(profilePath)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return { ok: true, value: cached.content }
  }

  try {
    const content = await readFile(profilePath, 'utf8')
    cache.set(profilePath, { content, mtimeMs })
    return { ok: true, value: content }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
