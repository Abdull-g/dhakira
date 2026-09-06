import type { TurnPair } from './turns.js'

export type QualityRejectReason =
  | 'user_too_short'
  | 'assistant_junk_short'
  | 'assistant_json_stub'
  | 'mostly_whitespace_or_nonprintable'

export interface QualityGateResult {
  keep: boolean
  reasons: QualityRejectReason[]
  tags: string[]
}

export interface QualityGateLogEntry {
  pairId: string
  reasons: QualityRejectReason[]
}

/**
 * Ring-buffer cap for the in-memory rejection log (v0.3.1, audit D14). The log
 * is diagnostics only; unbounded, a long-lived daemon that rejects many pairs
 * would grow it forever. Oldest entries are dropped once the cap is reached.
 */
export const REJECTION_LOG_MAX = 500

const rejectionLog: QualityGateLogEntry[] = []
const JUNK_ASSISTANT = /^(I(\s|')?ll(?:\s|$)|Let me(?:\s|$)|Sure,?(?:\s|$)|Okay,?(?:\s|$))/i

export function evaluateTurnPair(pair: TurnPair): QualityGateResult {
  const reasons: QualityRejectReason[] = []
  const tags: string[] = []

  if (pair.userContent.trim().length < 10) {
    reasons.push('user_too_short')
  }

  if (isShortJunkAssistant(pair.assistantContent)) {
    reasons.push('assistant_junk_short')
  }

  if (isJsonOnlyStub(pair.assistantContent)) {
    reasons.push('assistant_json_stub')
  }

  if (isMostlyWhitespaceOrNonPrintable(pair.userContent, pair.assistantContent)) {
    reasons.push('mostly_whitespace_or_nonprintable')
  }

  if (pair.userContent.length > 50_000 || pair.assistantContent.length > 50_000) {
    tags.push('oversized')
  }

  if ((pair.metadata?.toolsUsed.length ?? 0) > 5) {
    tags.push('complex_tool_flow')
  }

  return { keep: reasons.length === 0, reasons, tags }
}

export function applyQualityGate(pairs: TurnPair[]): TurnPair[] {
  return pairs.filter((pair) => {
    const result = evaluateTurnPair(pair)
    if (!result.keep) {
      rejectionLog.push({ pairId: pair.id, reasons: result.reasons })
      if (rejectionLog.length > REJECTION_LOG_MAX) {
        rejectionLog.splice(0, rejectionLog.length - REJECTION_LOG_MAX)
      }
    }
    return result.keep
  })
}

export function getQualityGateRejections(): QualityGateLogEntry[] {
  return [...rejectionLog]
}

export function clearQualityGateRejections(): void {
  rejectionLog.length = 0
}

function isShortJunkAssistant(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.length < 15 && JUNK_ASSISTANT.test(trimmed)
}

function isJsonOnlyStub(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) return false
    const keys = Object.keys(parsed)
    return keys.length === 1 && (keys[0] === 'title' || keys[0] === 'summary')
  } catch {
    return false
  }
}

function isMostlyWhitespaceOrNonPrintable(userContent: string, assistantContent: string): boolean {
  return mostlyBad(userContent) || mostlyBad(assistantContent)
}

function mostlyBad(content: string): boolean {
  if (content.length === 0) return true
  const badChars = [...content].filter((char) => /\s/.test(char) || isNonPrintable(char)).length
  return badChars / content.length >= 0.9
}

function isNonPrintable(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code < 32 && char !== '\n' && char !== '\r' && char !== '\t') || code === 127
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
