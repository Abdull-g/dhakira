// Format a captured conversation as markdown with YAML frontmatter

import type { NormalizedMessage } from '../proxy/types.js'
import type { CapturedConversation } from './types.js'

const ROLE_HEADING: Record<NormalizedMessage['role'], string> = {
  system: '## System',
  user: '## User',
  assistant: '## Assistant',
}

/**
 * Format a captured conversation as a markdown string.
 *
 * Output structure:
 *   ---
 *   id: conv_abc123
 *   tool: cursor
 *   ...
 *   ---
 *
 *   ## User
 *   Message content here
 *
 *   ## Assistant
 *   Response content here
 */
export function formatConversation(conversation: CapturedConversation): string {
  const frontmatter = buildFrontmatter(conversation)
  const body = buildBody(conversation)
  return `${frontmatter}\n\n${body}`
}

function buildFrontmatter(conversation: CapturedConversation): string {
  const lines = [
    '---',
    `id: ${conversation.id}`,
    `tool: ${conversation.tool}`,
    `provider: ${conversation.provider}`,
    `model: ${conversation.model}`,
    `timestamp: ${conversation.timestamp.toISOString()}`,
    `tokenEstimate: ${conversation.tokenEstimate}`,
    `incognito: ${conversation.incognito}`,
    '---',
  ]
  return lines.join('\n')
}

function buildBody(conversation: CapturedConversation): string {
  const sections = conversation.messages.map((msg) => {
    const heading = ROLE_HEADING[msg.role]
    return `${heading}\n${msg.content}`
  })
  return sections.join('\n\n')
}
