// Token counting/estimation
// Simple estimation: ~4 chars per token (good enough for budgeting, not billing)

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  let total = 0
  for (const msg of messages) {
    // ~4 tokens overhead per message (role, formatting)
    total += 4 + estimateTokens(msg.content)
  }
  return total
}
