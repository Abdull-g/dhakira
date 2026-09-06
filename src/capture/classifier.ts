import { parse as parseYaml } from 'yaml'
import type { ConversationTrace } from './ingest.js'

/**
 * Capture taxonomy. v0.3.1 (audit D11): `pre_flight` was removed — nothing ever
 * produced it (it existed only in the skip set); `error_response` now SKIPS on
 * both the rule and heuristic paths (it used to be kept when rule-matched).
 *
 * Agentic turns: a `tool_intermediate` capture (the API roundtrip whose response
 * ends in a tool call) is skipped as a capture, but its assistant text is NOT
 * lost — the final roundtrip of the same turn carries the whole history and
 * `extractTurnPairs` stitches the intermediate reasoning into the final pair
 * (corpus-verified in test/capture/classifier.test.ts).
 */
export type CaptureCategory =
  | 'real_conversation'
  | 'title_generation'
  | 'summarization'
  | 'tool_intermediate'
  | 'tool_internal_autocomplete'
  | 'tool_only_roundtrip'
  | 'error_response'

export interface Classification {
  category: CaptureCategory
  keep: boolean
  reason: string
  ruleId?: string
}

export interface RuleConditions {
  system_prompt_contains_all?: string[]
  system_prompt_contains_any?: string[]
  user_first_message_starts_with?: string
  model_includes?: string
  max_tokens_lte?: number
  response_json_keys_only?: string[]
  response_matches_regex?: string
  assistant_response_has_tool_use?: boolean
}

export interface ClassifierRule {
  id: string
  require_all: RuleConditions
}

export type ClassifierRules = Partial<Record<CaptureCategory, ClassifierRule[]>>

export const DEFAULT_CLASSIFIER_RULES: ClassifierRules = {
  title_generation: [
    {
      id: 'claude-code-haiku-title',
      require_all: {
        system_prompt_contains_all: ['Generate a concise', 'title'],
        model_includes: 'haiku',
      },
    },
    {
      id: 'single-title-field-prompt',
      require_all: {
        system_prompt_contains_all: ['Return JSON with a single "title" field'],
      },
    },
  ],
  summarization: [
    {
      id: 'summarize-following',
      require_all: {
        system_prompt_contains_any: [
          'summarize the following',
          'compress the following conversation',
        ],
      },
    },
  ],
  tool_intermediate: [
    {
      id: 'assistant-response-has-tool-use',
      require_all: {
        assistant_response_has_tool_use: true,
      },
    },
  ],
  tool_internal_autocomplete: [
    {
      id: 'claude-code-suggestion-mode',
      require_all: {
        user_first_message_starts_with: '[SUGGESTION MODE:',
      },
    },
  ],
  // TODO(v0.2.5): Add aider-repo-map once classifier rules can target system/first-user
  // boilerplate without dropping real turns. Exact aider marker:
  // "Here are summaries of some files present in my git repo."
  // TODO(v0.2.5): Add aider-source-fences once classifier rules can detect pure file-dump
  // messages. Verified aider fence names: source, code, pre, codeblock, sourcecode.
  // TODO(v0.2.5): Add aider-search-replace handling via sanitizer (not classifier) —
  // SEARCH/REPLACE blocks are real content, not intermediate tool noise, so they must be
  // captured but optionally stripped downstream.
}

const SKIP_CATEGORIES = new Set<CaptureCategory>([
  'title_generation',
  'summarization',
  'tool_intermediate',
  'tool_internal_autocomplete',
  'error_response',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRules(raw: unknown): ClassifierRules {
  if (!isRecord(raw)) return {}
  const rules: ClassifierRules = {}

  for (const [category, value] of Object.entries(raw)) {
    if (!isCaptureCategory(category) || !Array.isArray(value)) continue
    rules[category] = value.flatMap((item): ClassifierRule[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.require_all)) {
        return []
      }
      return [{ id: item.id, require_all: normalizeConditions(item.require_all) }]
    })
  }

  return rules
}

function normalizeConditions(raw: Record<string, unknown>): RuleConditions {
  return {
    system_prompt_contains_all: stringArray(raw.system_prompt_contains_all),
    system_prompt_contains_any: stringArray(raw.system_prompt_contains_any),
    user_first_message_starts_with:
      typeof raw.user_first_message_starts_with === 'string'
        ? raw.user_first_message_starts_with
        : undefined,
    model_includes: typeof raw.model_includes === 'string' ? raw.model_includes : undefined,
    max_tokens_lte: typeof raw.max_tokens_lte === 'number' ? raw.max_tokens_lte : undefined,
    response_json_keys_only: stringArray(raw.response_json_keys_only),
    response_matches_regex:
      typeof raw.response_matches_regex === 'string' ? raw.response_matches_regex : undefined,
    assistant_response_has_tool_use:
      typeof raw.assistant_response_has_tool_use === 'boolean'
        ? raw.assistant_response_has_tool_use
        : undefined,
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function isCaptureCategory(value: string): value is CaptureCategory {
  return (
    value === 'real_conversation' ||
    value === 'title_generation' ||
    value === 'summarization' ||
    value === 'tool_intermediate' ||
    value === 'tool_internal_autocomplete' ||
    value === 'tool_only_roundtrip' ||
    value === 'error_response'
  )
}

export function parseClassifierRulesYaml(yamlText: string): ClassifierRules {
  return normalizeRules(parseYaml(yamlText) as unknown)
}

export function classifyConversation(
  trace: ConversationTrace,
  rules: ClassifierRules = DEFAULT_CLASSIFIER_RULES,
): Classification {
  const configuredCategories: CaptureCategory[] = [
    'title_generation',
    'summarization',
    'tool_intermediate',
    'tool_internal_autocomplete',
    'tool_only_roundtrip',
    'error_response',
  ]

  for (const category of configuredCategories) {
    for (const rule of rules[category] ?? []) {
      if (matchesRule(trace, rule)) {
        return {
          category,
          keep: !SKIP_CATEGORIES.has(category),
          reason: `matched rule ${rule.id}`,
          ruleId: rule.id,
        }
      }
    }
  }

  if (isToolOnlyRoundtrip(trace)) {
    return {
      category: 'tool_only_roundtrip',
      keep: true,
      reason: 'assistant response contains tool_use blocks without text',
    }
  }

  if (isErrorResponse(trace)) {
    return {
      category: 'error_response',
      keep: false,
      reason: 'response contains an error object',
    }
  }

  return {
    category: 'real_conversation',
    keep: true,
    reason: 'no classifier rule matched',
  }
}

function matchesRule(trace: ConversationTrace, rule: ClassifierRule): boolean {
  const conditions = rule.require_all
  const systemPrompt = trace.systemPrompt.toLowerCase()
  const model = trace.model.toLowerCase()

  if (
    conditions.system_prompt_contains_all?.some(
      (needle) => !systemPrompt.includes(needle.toLowerCase()),
    )
  ) {
    return false
  }

  if (
    conditions.system_prompt_contains_any !== undefined &&
    !conditions.system_prompt_contains_any.some((needle) =>
      systemPrompt.includes(needle.toLowerCase()),
    )
  ) {
    return false
  }

  if (
    conditions.user_first_message_starts_with !== undefined &&
    !userFirstMessageText(trace).startsWith(conditions.user_first_message_starts_with)
  ) {
    return false
  }

  if (
    conditions.model_includes !== undefined &&
    !model.includes(conditions.model_includes.toLowerCase())
  ) {
    return false
  }

  if (conditions.max_tokens_lte !== undefined && trace.maxTokens > conditions.max_tokens_lte) {
    return false
  }

  if (
    conditions.response_json_keys_only !== undefined &&
    !responseJsonKeysOnly(trace.rawResponse, conditions.response_json_keys_only)
  ) {
    return false
  }

  if (
    conditions.response_matches_regex !== undefined &&
    !new RegExp(conditions.response_matches_regex).test(responseText(trace.rawResponse))
  ) {
    return false
  }

  if (
    conditions.assistant_response_has_tool_use !== undefined &&
    responseHasToolUse(trace) !== conditions.assistant_response_has_tool_use
  ) {
    return false
  }

  return true
}

function userFirstMessageText(trace: ConversationTrace): string {
  const firstUserMessage = trace.messages.find((message) => message.role === 'user')
  if (firstUserMessage === undefined) return ''
  return firstUserMessage.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

function responseJsonKeysOnly(rawResponse: unknown, expectedKeys: string[]): boolean {
  if (!isRecord(rawResponse)) return false
  const actual = Object.keys(rawResponse).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function responseText(rawResponse: unknown): string {
  if (typeof rawResponse === 'string') return rawResponse
  if (rawResponse === null || rawResponse === undefined) return ''
  return JSON.stringify(rawResponse)
}

function isToolOnlyRoundtrip(trace: ConversationTrace): boolean {
  const last = getResponseMessage(trace)
  if (last === undefined || last.content.length === 0) return false
  const hasText = last.content.some(
    (block) => block.type === 'text' && block.text.trim().length > 0,
  )
  const hasToolUse = last.content.some((block) => block.type === 'tool_use')
  return hasToolUse && !hasText
}

function responseHasToolUse(trace: ConversationTrace): boolean {
  const last = getResponseMessage(trace)
  return last?.content.some((block) => block.type === 'tool_use') ?? false
}

function getResponseMessage(
  trace: ConversationTrace,
): ConversationTrace['messages'][number] | undefined {
  if (trace.responseMessageIndex === undefined) return undefined
  return trace.messages[trace.responseMessageIndex]
}

function isErrorResponse(trace: ConversationTrace): boolean {
  return isRecord(trace.rawResponse) && isRecord(trace.rawResponse.error)
}
