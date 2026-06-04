// Retrieval LOAD path (OPEN): backend plumbing + turn-pair parsing.
// QMD-free — talks only to the RetrievalBackend seam.
import type { TurnPair } from '../capture/turns.js'
import { createLogger } from '../utils/logger.js'
import type { RawCandidate, RetrievalBackend } from './backend.js'

/**
 * Parse a TurnPair from the markdown body of a turn pair file.
 * Expects YAML frontmatter followed by ## User / ## Assistant sections.
 * Returns null if the body is malformed or missing required fields.
 */
export function parseTurnPairFromBody(body: string): TurnPair | null {
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fmMatch?.[1]) return null

  const fm = fmMatch[1]
  const get = (key: string): string =>
    fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''

  const id = get('id')
  const sessionId = get('sessionId')
  const timestamp = get('timestamp')
  if (!id || !sessionId || !timestamp) return null

  const afterFm = body.slice(fmMatch[0].length)
  const userMatch = afterFm.match(/## User\n([\s\S]*?)(?=\n## Assistant|$)/)
  const assistantMatch = afterFm.match(/## Assistant\n([\s\S]*)$/)

  const userRecorded = get('userRecorded') === 'true' ? true : undefined

  return {
    id,
    sessionId,
    tool: get('tool'),
    timestamp,
    turnIndex: parseInt(get('turnIndex') || '0', 10),
    userContent: userMatch?.[1]?.trim() ?? '',
    assistantContent: assistantMatch?.[1]?.trim() ?? '',
    contextFingerprint: get('contextFingerprint') || 'default',
    // Backward-compat: pre-T07 turns have no projectId line → "global" (never break).
    projectId: get('projectId') || 'global',
    ...(userRecorded === undefined ? {} : { userRecorded }),
  }
}

/**
 * Load raw candidates from the backend: attempt hybrid search, fall back to BM25
 * (`searchLex`) on failure (e.g. embedding models not yet loaded on cold start).
 */
export async function loadCandidates(
  backend: RetrievalBackend,
  query: string,
  fetchLimit: number,
): Promise<RawCandidate[]> {
  const logger = createLogger('retrieval')

  try {
    return await backend.search({ query, collection: 'turns', limit: fetchLimit })
  } catch (hybridErr) {
    logger.warn('Hybrid search unavailable, falling back to BM25', {
      error: hybridErr instanceof Error ? hybridErr.message : String(hybridErr),
    })
    return backend.searchLex(query, { collection: 'turns', limit: fetchLimit })
  }
}
