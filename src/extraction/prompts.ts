// LLM prompts for fact extraction and memory updates

export const EXTRACT_PROMPT = `You are an AI memory extraction system. Your job is to extract meaningful personal facts about the USER (the human) from a conversation.

SOURCE RULES (critical):
- ONLY extract facts from lines under "## User" — these are the user's actual words
- NEVER extract facts from lines under "## Assistant" — those are the AI's interpretations
- Exception: if the user CONFIRMS an assistant statement (e.g., "yes", "that's right", "exactly"), treat the confirmed statement as a user fact
- If the user CORRECTS an assistant statement (e.g., "no, actually I prefer X"), extract the correction
- IGNORE any content inside <memory_context>, <dhakira_context>, or <system-reminder> tags — this is injected system data, not user speech

EXTRACTION RULES:
- Extract facts about the USER only — not third parties or projects they describe
- Do NOT extract jokes, sarcasm, or hypotheticals as facts
- Do NOT extract questions the user asked (unless they clearly reveal a personal attribute)
- Only extract facts stated as definitively true about the user
- Avoid duplicating facts already in the existing profile or rolling summary
- If the user CHANGES a previous fact (e.g., "I switched from React to Svelte"), extract the NEW state and note it supersedes the old
- If the user explicitly states they do NOT do/like/use something, extract that as a negative fact (e.g., "Does not use Windows")

CATEGORIES:
- IDENTITY: Who the user is (name, location, job title, age, nationality, language)
- PREFERENCE: What the user likes, prefers, dislikes, or values (including negative preferences)
- CONTEXT: Current projects, tasks, goals, or situations the user is working in
- RELATIONSHIP: The user's connections to people, teams, or organizations
- SKILL: Technical or professional skills the user has, is learning, or lacks
- EVENT: Significant events, decisions, or milestones mentioned (meetings, launches, deadlines, achievements)

CONFIDENCE:
- HIGH: Explicitly and directly stated ("I am a TypeScript developer", "I live in Riyadh")
- MEDIUM: Implied or reasonably inferred from conversation context
- LOW: Mentioned once casually or ambiguously

TEMPORAL AWARENESS:
- When a fact is time-sensitive (projects, goals, current tasks, events), include a temporal reference
- Good: "Working on Dhakira project (as of {conversation_date})"
- Good: "Had a meeting with the design team about the API redesign"
- Bad: "Working on a project" (too vague, no temporal anchor)
- Stable identity facts (name, nationality) do NOT need temporal references

EXISTING PROFILE (already known — do not re-extract):
{existing_profile}

ROLLING SUMMARY (recent context — do not re-extract):
{rolling_summary}

CONVERSATION DATE: {conversation_date}

CONVERSATION:
{conversation}

Respond with ONLY valid JSON:
{
  "facts": [
    {
      "text": "Single declarative sentence about the user, with temporal reference if time-sensitive",
      "category": "PREFERENCE",
      "confidence": "HIGH"
    }
  ],
  "summary_update": "2-3 sentences: what was discussed, key decisions made, and what was newly learned about the user. Preserve specific details (names, dates, tools mentioned) — not just topics."
}

If no new facts exist, return: {"facts": [], "summary_update": "No new personal facts."}`

export const UPDATE_PROMPT = `You are a memory manager. A new fact was extracted from a conversation. Decide what to do with it given existing memories.

NEW FACT:
{new_fact}

EXISTING MEMORIES (most similar, found by search):
{existing_memories}

DECISION RULES:
- ADD: Fact is genuinely new and not captured in existing memories
- UPDATE: Fact refines, improves, or adds temporal context to an existing memory (provide targetId). Use when the new fact is a more complete or current version of an existing one.
- INVALIDATE: Fact directly contradicts an existing memory — the old fact is no longer true (provide targetId). The old memory should be marked as superseded, not deleted.
- NOOP: Fact is already fully captured in existing memories — no new information

Be careful with NOOP — if the new fact contains additional detail, a date, or a nuance not in the existing memory, prefer UPDATE over NOOP.

Respond with ONLY valid JSON, one of:
{"action": "ADD"}
{"action": "UPDATE", "targetId": "mem_abc123"}
{"action": "INVALIDATE", "targetId": "mem_abc123"}
{"action": "NOOP", "reason": "Already captured in ..."}`

export const PROFILE_PROMPT = `You are a profile writer. Based on these memories, write a concise personal profile in two sections.

MEMORIES:
{memories}

RULES:
- Two sections: STABLE (long-term facts) and ACTIVE (current projects/context)
- Bullet point format, one fact per line
- ~200 tokens total, be concise
- STABLE section: identity, skills, preferences, relationships (things unlikely to change soon)
- ACTIVE section: current projects, goals, recent decisions, ongoing work (things that change over weeks/months)
- Write in third person factual style (e.g., "Based in Riyadh, Saudi Arabia")
- No preamble or explanation

Format:
## Stable
- fact 1
- fact 2

## Active
- current context 1
- current context 2

Respond with ONLY the formatted profile.`

export const SALIENCE_PROMPT = `You score how intrinsically important ONE fact about the user is for long-term memory.

FACT: {fact_text}
CATEGORY: {category}
CONFIDENCE: {confidence}

Judge how much this fact matters for understanding who the user is over the long term.
- score: a number from 0 to 1 (1 = defining/essential, 0 = trivial/disposable)
- tier: "core" (defining identity, key relationships, lasting traits), "standard" (useful context, preferences, skills), or "trivia" (minor, fleeting, or low-value)
- reason: one short clause (max ~12 words) explaining the score

Guidance:
- Stable identity and important relationships score highest.
- Preferences and skills are usually "standard".
- One-off events or vague mentions are usually low / "trivia".
- Lower confidence should pull the score down.

Respond with ONLY valid JSON:
{"score": 0.0, "tier": "standard", "reason": "..."}`

export const CONSOLIDATE_PROMPT = `You are a memory consolidator. You are given a small CLUSTER of existing memories about ONE user that a similarity search flagged as possibly redundant. Decide whether they should be merged into a single denser memory, or left alone.

MEMORIES IN THIS CLUSTER:
{memories}

DECISION RULES:
- MERGE only when the memories truly say the SAME thing or REFINE each other (duplicates, rephrasings, or one adding detail to another).
- When you MERGE, the merged text MUST preserve EVERY distinct detail across the sources — names, dates, specifics, qualifiers. The result should be DENSER, never lossy. Do not drop information to make it shorter.
- If the memories are actually DISTINCT facts (different topics, or facts that can independently be true), return LEAVE_AS_IS — do NOT force a merge.
- When in doubt, return LEAVE_AS_IS. A wrong merge corrupts the store; leaving things alone is always safe.
- The merged "category" must be ONE of: IDENTITY, PREFERENCE, CONTEXT, RELATIONSHIP, SKILL, EVENT.

Respond with ONLY valid JSON, one of:
{"action": "MERGE", "text": "<single consolidated declarative fact preserving all details>", "category": "IDENTITY"}
{"action": "LEAVE_AS_IS", "reason": "<short explanation>"}`

/** Substitute {placeholder} variables in a prompt template */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? `{${key}}`)
}
