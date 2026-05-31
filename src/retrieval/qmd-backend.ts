// QMD adapter for the RetrievalBackend seam.
// ALL @tobilu/qmd imports and ALL store.internal.* access are confined to THIS file.
import type { QMDStore } from '@tobilu/qmd'
import type { RawCandidate, RetrievalBackend, RetrievalBackendSearchOptions } from './backend.js'

// Re-exported so callers (e.g. search.ts) can reference the QMDStore type without
// importing @tobilu/qmd directly — QMD coupling stays confined to this file.
export type { QMDStore }

/**
 * Adapts a QMDStore to the RetrievalBackend interface.
 * READ methods are thin wrappers over the calls previously made directly in search.ts,
 * preserving the exact same mapping and body-resolution behavior.
 */
export class QMDBackend implements RetrievalBackend {
  constructor(private readonly store: QMDStore) {}

  async search(opts: RetrievalBackendSearchOptions): Promise<RawCandidate[]> {
    const hybridResults = await this.store.search({
      query: opts.query,
      collection: opts.collection,
      limit: opts.limit,
    })
    // QMD's search() returns HybridQueryResult[] where .body is ALWAYS present.
    return hybridResults.map((r) => ({ score: r.score, body: r.body, file: r.file }))
  }

  async searchLex(
    query: string,
    opts: { collection: string; limit: number },
  ): Promise<RawCandidate[]> {
    const lexResults = await this.store.searchLex(query, {
      collection: opts.collection,
      limit: opts.limit,
    })
    // searchLex() returns SearchResult[] where .body is OPTIONAL — resolve it exactly
    // as the former resolveBody(store, r, false) lexical branch did.
    return Promise.all(
      lexResults.map(async (r) => {
        const fp = r.filepath ?? ((r as Record<string, unknown>).file as string) ?? ''
        const body =
          r.body !== undefined && r.body !== null
            ? r.body
            : ((await this.store.getDocumentBody(fp)) ?? '')
        return { score: r.score, body, file: fp }
      }),
    )
  }

  async getDocumentBody(filepath: string): Promise<string | null> {
    return this.store.getDocumentBody(filepath)
  }

  async close(): Promise<void> {
    return this.store.close()
  }
}
