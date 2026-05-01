import { parse as parseYaml } from 'yaml'
import type { ContentBlock, ConversationTrace, TraceMessage, TraceRole } from './ingest.js'

export interface SanitizeRule {
  id: string
  scope: TraceRole
  action: 'remove'
  pattern: string
}

export interface SanitizeRulesConfig {
  rules: SanitizeRule[]
}

export interface SanitizeResult {
  trace: ConversationTrace
  hits: Array<{ ruleId: string; count: number }>
}

export const DEFAULT_SANITIZE_RULES: SanitizeRulesConfig = {
  rules: [
    {
      id: 'claude-code-system-reminder',
      scope: 'user',
      action: 'remove',
      pattern: '<system-reminder>[\\s\\S]*?</system-reminder>',
    },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSanitizeRulesYaml(yamlText: string): SanitizeRulesConfig {
  const parsed: unknown = parseYaml(yamlText)
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) return { rules: [] }

  return {
    rules: parsed.rules.flatMap((item): SanitizeRule[] => {
      if (!isRecord(item)) return []
      if (typeof item.id !== 'string') return []
      if (!isTraceRole(item.scope)) return []
      if (item.action !== 'remove') return []
      if (typeof item.pattern !== 'string') return []
      return [{ id: item.id, scope: item.scope, action: item.action, pattern: item.pattern }]
    }),
  }
}

export function sanitizeTrace(
  trace: ConversationTrace,
  config: SanitizeRulesConfig = DEFAULT_SANITIZE_RULES,
): SanitizeResult {
  const hitCounts = new Map<string, number>()
  const messages = trace.messages.map((message) =>
    sanitizeMessage(message, config.rules, hitCounts),
  )
  const sanitizerRemovedAll = messages.some((message) =>
    message.content.some((block) => block.type === 'text' && block.text.length === 0),
  )

  return {
    trace: { ...trace, messages, sanitizerRemovedAll },
    hits: [...hitCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })),
  }
}

function sanitizeMessage(
  message: TraceMessage,
  rules: SanitizeRule[],
  hitCounts: Map<string, number>,
): TraceMessage {
  const scopedRules = rules.filter((rule) => rule.scope === message.role)
  if (scopedRules.length === 0) return message

  return {
    ...message,
    content: message.content.map((block) => sanitizeBlock(block, scopedRules, hitCounts)),
  }
}

function sanitizeBlock(
  block: ContentBlock,
  rules: SanitizeRule[],
  hitCounts: Map<string, number>,
): ContentBlock {
  if (block.type !== 'text') return block

  let text = block.text
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, 'g')
    let count = 0
    text = text.replace(regex, () => {
      count++
      return ''
    })
    if (count > 0) {
      hitCounts.set(rule.id, (hitCounts.get(rule.id) ?? 0) + count)
      text = normalizeRemovedBlockWhitespace(text)
    }
  }

  return { ...block, text }
}

function normalizeRemovedBlockWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isTraceRole(value: unknown): value is TraceRole {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool'
}
