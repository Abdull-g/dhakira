// Secret detection and redaction before storage
import type { Result } from '../proxy/types.js'
import { createLogger } from '../utils/logger.js'

export interface RedactResult {
  cleaned: string
  redactedCount: number
}

/**
 * Ordered list of secret patterns. Each entry has a human-readable name (for
 * logging) and a regex that captures the sensitive value in group 1.
 *
 * Design notes:
 * - We match the prefix + the token so the replacement preserves the prefix
 *   where possible, making redacted output easier to understand.
 * - All regexes are non-greedy and bounded to avoid catastrophic backtracking.
 * - Patterns are applied in order; later patterns act on the already-cleaned text.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // OpenAI-style keys: sk-..., sk-proj-...
  {
    name: 'openai-key',
    pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,
  },
  // Anthropic keys
  {
    name: 'anthropic-key',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  },
  // Generic "key-" prefixed tokens
  {
    name: 'generic-key',
    pattern: /\b(key-[A-Za-z0-9_-]{16,})\b/g,
  },
  // GitHub PATs
  {
    name: 'github-pat',
    pattern: /\b(ghp_[A-Za-z0-9]{36,})\b/g,
  },
  // GitHub fine-grained PATs
  {
    name: 'github-fine-grained',
    pattern: /\b(github_pat_[A-Za-z0-9_]{50,})\b/g,
  },
  // AWS access key IDs
  {
    name: 'aws-access-key',
    pattern: /\b(AKIA[A-Z0-9]{16})\b/g,
  },
  // AWS secret access keys (typically 40-char base64-like after label)
  {
    name: 'aws-secret',
    pattern:
      /(?:aws_secret(?:_access)?_key|AWS_SECRET(?:_ACCESS)?_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+]{40})["']?/gi,
  },
  // JWT tokens (three base64url segments)
  {
    name: 'jwt',
    pattern: /\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  // Bearer tokens in Authorization headers or inline
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+([A-Za-z0-9_\-.+/]{20,})\b/gi,
  },
  // Inline password assignments: password is X, my password: X, password = X
  {
    name: 'inline-password',
    pattern:
      /(?:password\s+is\s+|my\s+password[:\s]\s*|password\s*[=:]\s*)["']?([^\s"',;]{8,})["']?/gi,
  },
  // token: <value> or token = <value>
  {
    name: 'token-label',
    pattern: /\btoken\s*[=:]\s*["']?([A-Za-z0-9_\-.+/]{20,})["']?/gi,
  },
]

const logger = createLogger('capture:secrets')

/**
 * Scan `text` for known secret patterns and replace each detected secret with
 * `[REDACTED]`. Returns the cleaned string and a count of redactions made.
 *
 * This function is pure — it never throws.
 */
export function redactSecrets(text: string): RedactResult {
  let cleaned = text
  let redactedCount = 0

  for (const { name, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex since we reuse compiled regexes with the /g flag
    pattern.lastIndex = 0

    const before = cleaned
    cleaned = cleaned.replace(pattern, (match, secret: string) => {
      redactedCount++
      // Replace only the captured secret group, not any surrounding label text
      return match.replace(secret, '[REDACTED]')
    })

    if (cleaned !== before) {
      logger.warn('Secret redacted', { type: name })
    }
  }

  return { cleaned, redactedCount }
}

/**
 * Convenience wrapper that returns a Result so callers can use the standard
 * error-as-value pattern if they need it (e.g. in async pipelines).
 */
export function safeRedactSecrets(text: string): Result<RedactResult> {
  try {
    return { ok: true, value: redactSecrets(text) }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}
