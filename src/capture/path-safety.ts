import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function expandWalletPath(walletDir: string): string {
  if (walletDir === '~' || walletDir.startsWith('~/') || walletDir.startsWith('~\\')) {
    return homedir() + walletDir.slice(1)
  }
  return walletDir
}

/** Strict slug for request-supplied tool names used in conversation filenames. */
export function toolPathSlug(tool: string): string {
  const slug = tool
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'unknown'
}

/** Preserve generated ID conventions while removing path syntax. */
export function idPathSlug(value: string, fallback = 'unknown'): string {
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : fallback
}

/**
 * Resolve a capture path and reject any lexical escape from the configured wallet.
 * Callers that write files catch this error and return their existing Result shape.
 */
export function resolveContainedCapturePath(walletDir: string, ...segments: string[]): string {
  const walletRoot = resolve(expandWalletPath(walletDir))
  const candidate = resolve(walletRoot, ...segments)
  const rel = relative(walletRoot, candidate)
  const escapesWallet = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (rel.length === 0 || escapesWallet) {
    throw new Error(`Refusing capture path outside wallet directory: ${candidate}`)
  }
  return candidate
}
