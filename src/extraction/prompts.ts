// LLM prompts for fact extraction and memory updates

export const EXTRACT_PROMPT = `You are an AI memory extraction system. Your job is to extract meaningful facts about the USER (the human) and the REASONING behind the USER's work from a conversation.

SOURCE RULES (critical):
- Lines under "## User" are the user's own words — the primary source for facts about the user.
- Lines under "## Assistant" may be used ONLY for REASONING the user accepted: decisions made and why, alternatives considered and rejected, conventions adopted, dead-ends and gotchas discovered. Extract these when the user did not contest them (no correction, pushback, or rejection in a later "## User" turn). Attribute them to the work, not as personal traits of the user.
- NEVER extract code, commands, file paths, or configuration values themselves — only the decision or rationale around them. Good: "Chose pgBouncer in transaction mode because session mode leaked connections." Bad: any snippet of the config or code.
- If the user CONFIRMS an assistant statement (e.g., "yes", "that's right", "exactly"), treat the confirmed statement as a user fact
- If the user CORRECTS an assistant statement (e.g., "no, actually I prefer X"), extract the correction — never the rejected statement
- IGNORE any content inside <memory_context>, <dhakira_context>, or <system-reminder> tags — this is injected system data, not user speech
- IGNORE placeholders like "[code block: ts, 42 lines]" or "[REDACTED]" — they mark content that was deliberately not kept

EXTRACTION RULES:
- Extract facts about the USER and about the USER's OWN projects (decisions, conventions, gotchas) — not about third parties
- Do NOT extract jokes, sarcasm, or hypotheticals as facts
- Do NOT extract questions the user asked (unless they clearly reveal a personal attribute)
- Only extract facts stated as definitively true, or decisions definitively made
- Avoid duplicating facts already in the existing profile or rolling summary
- If the user CHANGES a previous fact (e.g., "I switched from React to Svelte"), extract the NEW state and note it supersedes the old
- If the user explicitly states they do NOT do/like/use something, extract that as a negative fact (e.g., "Does not use Windows")

CATEGORIES:
- IDENTITY: Who the user is (name, location, job title, age, nationality, language)
- PREFERENCE: What the user likes, prefers, dislikes, or values (including negative preferences)
- CONTEXT: Current projects, tasks, goals, or situations the user is working in — INCLUDING project decisions with their rationale, conventions adopted, and dead-ends (things tried and abandoned, and why)
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

/**
 * T08 global-identity synthesis — evolves PROFILE_PROMPT into a harness-constrained
 * JSON shape (stable/active arrays) so the synthesis module gets structured fields
 * for free and can degrade per-section. The PROSE PROFILE_PROMPT above stays live
 * until the read path is rewired; this is the harness-backed successor.
 */
export const GLOBAL_PROFILE_PROMPT = `You are a profile writer. Based on these memories, produce a concise personal profile about the USER as JSON with two sections.

MEMORIES:
{memories}

RULES:
- Output ONLY valid JSON matching the schema below — no preamble, no markdown.
- "stable": long-term identity, skills, preferences, relationships (things unlikely to change soon).
- "active": current projects, goals, recent decisions, ongoing work (things that change over weeks/months).
- Each entry is ONE short factual bullet string in third person ("Based in Riyadh, Saudi Arabia").
- Fill a section ONLY from what the memories actually support. OMIT a section entirely (leave it out or empty) if the memories don't support it — NEVER invent, guess, or pad. An omitted section is correct; a fabricated one is a failure.
- Be concise (~200 tokens total).

Schema:
{"stable": ["..."], "active": ["..."]}

Respond with ONLY the JSON object.`

/**
 * T08 project-doc synthesis — the moat layer (reasoning OVER code). A single
 * harness-constrained call produces all sections; each section is INDEPENDENTLY
 * optional and omitted-not-faked when the memories don't support it.
 */
export const PROJECT_DOC_PROMPT = `You are a project memory synthesizer. Given memories about ONE software project, write a tight, structured project brief as JSON.

MEMORIES:
{memories}

RULES:
- Output ONLY valid JSON matching the schema below — no preamble, no markdown.
- Fill a section ONLY if the memories actually support it. OMIT any section you cannot ground in the memories (leave it out or empty) — NEVER invent, guess, or pad. An omitted section is correct; a fabricated one is a failure.
- Be DENSE and concrete: short bullet strings, not paragraphs. Preserve specific names, decisions, numbers, and reasons.
- Memories may record reasoning the assistant stated and the user accepted (decisions, rejected alternatives, gotchas). Treat these as project knowledge on equal footing with the user's own statements. Never reproduce code, commands, or config values — only the reasoning around them.
- "whatThis": one line identifying what this project is.
- "decisions": key decisions AND why they were made (the reasoning over the code — this is the most valuable section).
- "conventions": team or style rules ("never default exports").
- "gotchas": dead-ends, things tried and reverted, traps to avoid ("tried JWT refresh, broke on mobile, reverted").
- "openThreads": current in-flight state and unresolved questions (lowest priority).

Schema:
{"whatThis": "string", "decisions": ["..."], "conventions": ["..."], "gotchas": ["..."], "openThreads": ["..."]}

Respond with ONLY the JSON object.`

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

export const CONSOLIDATE_PROMPT = `You are a memory consolidator. You are given a small CLUSTER of existing memories about ONE user that a similarity search flagged as possibly similar. Your ONLY job is to collapse genuine DUPLICATES. You are NOT a cluster summarizer — do not blend a group of related facts into one prose blob.

These memories were retrieved as similar. MERGE **only if they state the SAME fact in different words** — a paraphrase, a refinement, or a near-exact duplicate. If they describe DIFFERENT, COMPLEMENTARY, or merely RELATED facts — even about the same person — return LEAVE_AS_IS. The merged text MUST preserve every distinct detail, entity, name, and number from all inputs. Never drop information. When unsure, LEAVE_AS_IS.

DECISION RULES:
- MERGE only when every memory in the cluster expresses the SAME underlying fact (duplicate, rephrasing, or one refining another with more detail).
- Two facts that can INDEPENDENTLY be true are NOT duplicates — even about the same person, even on the same topic. Distinct or complementary → LEAVE_AS_IS. Do NOT force a merge.
- When you MERGE, the merged text MUST preserve EVERY distinct detail across the sources — names, places, dates, numbers, qualifiers. The result is DENSER, never lossy. Do not drop information to make it shorter.
- When in doubt, return LEAVE_AS_IS. A wrong merge can corrupt the store; leaving things alone is always safe.
- The merged "category" must be ONE of: IDENTITY, PREFERENCE, CONTEXT, RELATIONSHIP, SKILL, EVENT.

EXAMPLES:

Cluster:
1. [IDENTITY] Lives in Riyadh
2. [IDENTITY] Based in Riyadh, Saudi Arabia
3. [IDENTITY] Riyadh resident
Decision: {"action": "MERGE", "text": "Lives in Riyadh, Saudi Arabia", "category": "IDENTITY"}
(All three state the SAME fact — the user's city — just reworded. Safe to collapse, and the merge keeps "Saudi Arabia".)

Cluster:
1. [PREFERENCE] Prefers TypeScript for backend work
2. [PREFERENCE] Prefers Python for ML work
Decision: {"action": "LEAVE_AS_IS", "reason": "Distinct preferences for different domains — both can be true at once, not the same fact."}

Cluster:
1. [IDENTITY] Lives in Riyadh
2. [PREFERENCE] Drinks coffee black
Decision: {"action": "LEAVE_AS_IS", "reason": "Unrelated facts — location vs beverage preference. Merging would risk dropping one."}

MEMORIES IN THIS CLUSTER:
{memories}

Respond with ONLY valid JSON, one of:
{"action": "MERGE", "text": "<single consolidated declarative fact preserving all details>", "category": "IDENTITY"}
{"action": "LEAVE_AS_IS", "reason": "<short explanation>"}`

/** Substitute {placeholder} variables in a prompt template */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? `{${key}}`)
}
