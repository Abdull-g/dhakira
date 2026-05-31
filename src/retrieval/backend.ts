// RetrievalBackend seam — the open/closed line for retrieval data access.
// This file is QMD-free: it declares only the abstract read-path contract.

/** A raw search candidate from the backend, before any of OUR ranking is applied. */
export interface RawCandidate {
  score: number // backend's own relevance score
  body: string // full turn-pair markdown body
  file: string // source filepath
}

export interface RetrievalBackendSearchOptions {
  query: string
  collection: string
  limit: number
}

export interface RetrievalBackend {
  // ---- READ path (FULLY implemented in Step 1 — this is all the seam needs now) ----
  search(opts: RetrievalBackendSearchOptions): Promise<RawCandidate[]> // hybrid
  searchLex(query: string, opts: { collection: string; limit: number }): Promise<RawCandidate[]> // BM25 fallback
  getDocumentBody(filepath: string): Promise<string | null>

  // lifecycle
  close(): Promise<void>
}
