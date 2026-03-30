// Extraction type definitions

export interface ExtractedFact {
  /** The fact text */
  text: string
  /** Category of this fact */
  category: 'IDENTITY' | 'PREFERENCE' | 'CONTEXT' | 'RELATIONSHIP' | 'SKILL' | 'EVENT'
  /** How confident we are */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export type UpdateAction =
  | { action: 'ADD'; fact: ExtractedFact }
  | { action: 'UPDATE'; fact: ExtractedFact; targetId: string }
  | { action: 'INVALIDATE'; fact: ExtractedFact; targetId: string }
  | { action: 'NOOP'; reason: string }

export interface ExtractionResult {
  /** Extracted facts from this conversation */
  facts: ExtractedFact[]
  /** Summary update for rolling context */
  summaryUpdate: string
  /** Which conversation this was extracted from */
  conversationId: string
}

export interface MemoryRecord {
  /** Unique memory ID */
  id: string
  /** The memory text */
  text: string
  /** Category */
  category: ExtractedFact['category']
  /** Confidence level */
  confidence: ExtractedFact['confidence']
  /** Source conversation ID */
  source: string
  /** When this memory was created */
  createdAt: Date
  /** When the fact became true */
  validFrom: Date
  /** When this was invalidated (null if still valid) */
  invalidatedAt: Date | null
}
