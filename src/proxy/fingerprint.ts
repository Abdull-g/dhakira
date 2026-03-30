import { createHash } from 'node:crypto'

/**
 * Generate a stable context fingerprint from the system prompt.
 *
 * Strips any existing Dhakira injection block before hashing so the
 * fingerprint reflects the TOOL's context, not our own injection.
 * Uses the first 2048 chars to keep it stable even when system prompts
 * have minor variations (like timestamps or token counts appended).
 *
 * Returns a short hex hash (first 12 chars of SHA-256).
 */
export function computeContextFingerprint(systemPrompt: string | null): string {
  if (!systemPrompt) return 'default'

  // Strip our own injection block so it doesn't affect the fingerprint
  const cleaned = systemPrompt.replace(/<dhakira_context>[\s\S]*?<\/dhakira_context>/g, '').trim()

  if (cleaned.length === 0) return 'default'

  // Use first 2048 chars for stability — system prompts often append
  // variable data (timestamps, file listings) at the end
  const stable = cleaned.slice(0, 2048)

  return createHash('sha256').update(stable).digest('hex').slice(0, 12)
}
