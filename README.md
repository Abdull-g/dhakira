# Dhakira

[![npm version](https://img.shields.io/npm/v/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![npm downloads](https://img.shields.io/npm/dm/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![license](https://img.shields.io/npm/l/dhakira.svg?color=0366d6)](LICENSE)
[![node](https://img.shields.io/node/v/dhakira.svg?color=0366d6)](package.json)

**Your AI, with memory.**

Every AI session starts from zero. Dhakira changes that.

Dhakira is a local memory engine for your AI tools. It captures your conversations, learns from them over time, and quietly injects relevant context into future sessions — so every tool you use already knows you.

It connects through your tool's native hooks. Two commands and Claude Code or Codex has memory.

Your data never leaves your machine. No cloud. No account. Just a folder.

```bash
npm install -g dhakira
dhakira init
dhakira connect claude-code
```

## Table of Contents

- [What Works Today](#what-works-today)
- [Install](#install)
- [Usage](#usage)
- [Supported Tools](#supported-tools)
- [How It Works](#how-it-works)
- [What Gets Injected](#what-gets-injected)
- [Full Local Stack](#full-local-stack)
- [CLI](#cli)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [Your Wallet](#your-wallet)
- [Privacy](#privacy)
- [What You Give Up](#what-you-give-up)
- [Requirements](#requirements)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## What Works Today

An honest map of the project. Everything in the first table is shipped and tested in this release.

**Working**

| Capability | What it does |
|---|---|
| Claude Code hooks | `dhakira connect claude-code` — recall on every prompt, capture on every turn |
| Codex hooks | `dhakira connect codex` — same two events, Codex transcript format |
| Capture pipeline | Classify, redact secrets, extract, quality-gate, store |
| Salience scoring | Rates each memory core / standard / trivia at extraction time |
| Two-tier store | Durable memories stay; low-value ones carry an expiry |
| Consolidation | Off-line sweep that merges redundant memories into denser ones |
| Forget lifecycle | Expired and superseded memories retire, reversibly, after a grace period |
| Project scoping | Detects which repo you're in and scopes memory to it, across tools |
| Hybrid retrieval | BM25 + embeddings + reranking, scored on relevance, salience, recency, project |
| Profile synthesis | A generated "About You" that evolves as you work |
| Local models | Query expansion, embeddings, reranking, and synthesis all run on your machine |
| Dashboard | Browse conversations, read your profile, watch injections, toggle incognito |
| Base-URL proxy | Routes any OpenAI- or Anthropic-compatible tool through Dhakira |

**Supported, not actively developed**

| Capability | Status |
|---|---|
| Proxy delivery path | Works, tested, and documented below. Hooks are where the work goes now — they're deterministic, they know your working directory, and they don't sit between you and your provider. If your tool has no hook system, the proxy is a real fallback, not a deprecated one. |

**Planned**

| Capability | Notes |
|---|---|
| More hook adapters | Gemini CLI, OpenCode, Cursor |
| Session backfill | Import your existing tool history so memory starts full, not empty |
| Hosted sync | Optional, for people who work across several machines |

## Install

```bash
npm install -g dhakira
dhakira init
```

`dhakira init` detects your API keys (or Claude Max/Pro subscription), writes `~/.dhakira/config.yaml`, and creates your wallet at `~/.dhakira`. Requires Node.js 22+.

On first launch, Dhakira downloads ~2.25 GB of local models (query expansion, embeddings, reranker). This happens once — a progress line keeps you posted.

## Usage

Start Dhakira:

```bash
dhakira start
```

Connect your tools:

```bash
dhakira connect claude-code
dhakira connect codex
```

That writes hook entries into `~/.claude/settings.json` or `~/.codex/config.toml`. Codex asks you to trust new hooks — open Codex, run `/hooks`, and approve the two Dhakira entries.

Then just work. Dhakira reads your prompt, finds anything relevant in your history, and passes it to your tool as extra context. When the turn finishes, it captures what happened.

To disconnect:

```bash
dhakira disconnect claude-code
```

Want to teach it something directly? `dhakira record "I prefer functional patterns, no classes"` and that fact is in your wallet immediately.

### Tools without hooks

Dhakira also runs a proxy on `localhost:4100`. Point any OpenAI- or Anthropic-compatible tool at it:

```bash
# aider
aider --openai-api-base http://localhost:4100/v1

# Any OpenAI-compatible tool
export OPENAI_BASE_URL=http://localhost:4100/v1
```

## Supported Tools

### Hooks

The primary path. Deterministic lifecycle events, no traffic interception, and Dhakira sees your working directory so memory is scoped to the right project.

| Tool | Setup |
|------|-------|
| **Claude Code** | `dhakira connect claude-code` |
| **Codex** | `dhakira connect codex`, then approve the hooks with `/hooks` inside Codex |

### Base-URL routing

For tools with no hook system. Dhakira sits between your tool and its provider, and auto-detects Anthropic or OpenAI request format.

| Tool | Setup |
|------|-------|
| **Claude Code (API key)** | `export ANTHROPIC_BASE_URL=http://localhost:4100` |
| **Claude Code (Max/Pro subscription)** | `dhakira init` offers a subscription option when no API key is found, then set `ANTHROPIC_BASE_URL` as above |
| **aider** | `aider --openai-api-base http://localhost:4100/v1` |
| **Continue.dev** | Set `apiBase: http://localhost:4100/v1` on your model in `~/.continue/config.yaml` |
| **Any OpenAI-compatible tool** | Set the tool's base URL to `http://localhost:4100/v1` |
| **Ollama-backed tools** | Point at Dhakira; configure Ollama as the upstream in `config.yaml` |

> **Cursor, Copilot, ChatGPT, Claude.ai web/app:** these route API calls through their vendors' own servers, so a local proxy on `localhost` can't intercept them, and they don't expose a hook system Dhakira can connect to. Cursor's BYOK mode accepts a custom base URL, but it needs a publicly reachable endpoint — Dhakira stays on `localhost`, so this path isn't supported today.

## How It Works

Dhakira runs one local daemon with two jobs: recall memory before a turn, capture memory after it. Hooks and the proxy are just two ways of reaching it.

### Hooks (primary)

```
[Claude Code / Codex]
        │
        │  UserPromptSubmit ──→ [ Dhakira daemon ] ──→ recall
        │                              │              (search + rank + compose)
        │  ←────── extra context ──────┘
        │
        │  ...your tool talks to its provider directly.
        │     Dhakira is not in that path.
        │
        └─ Stop ──────────────→ [ Dhakira daemon ] ──→ capture
                                       │              (classify, redact,
                                       │               extract, store)
                                       └─ async, never blocks you
```

1. You submit a prompt. The hook sends it to the daemon.
2. The daemon searches your history, ranks what's relevant, and returns a context block.
3. Your tool receives that block as additional context and calls its provider itself.
4. When the turn ends, the hook reads the finished exchange and hands it to the daemon.
5. The daemon classifies it, redacts secrets, extracts facts, and stores them.
6. In the background, consolidation merges redundant memories and your profile refreshes.

**If Dhakira is down, nothing breaks.** Every hook call has a 1.5 second timeout and returns empty on any failure. Your AI works normally, just without memory. This is enforced in code, not by convention — see `src/hooks/shared-adapter.ts`.

### Base-URL proxy (secondary)

```
[Your AI Tool] ──→ [Dhakira proxy :4100] ──→ [API Provider]
                          │                         │
                     inject memory            stream back
                     into the request         untouched
                          │
                     capture after
                     the response
```

Same daemon, same engine. The difference is that Dhakira forwards your request instead of standing beside it.

Everything happens locally. Search uses hybrid retrieval (BM25 + semantic embeddings + reranking) via local GGUF models — no API calls for search, embeddings, or profile synthesis by default.

## What Gets Injected

Dhakira adds a small context block (~1800 tokens) to your session. The block looks like this:

```text
<dhakira_context>

## About You
- TypeScript developer, based in Riyadh
- Working on a RAG-based memory system
- Prefers functional patterns, no classes

## Relevant Past Conversations
[2026-03-28] You: How should I handle connection pooling in PostgreSQL?
→ Used pgBouncer with pool_mode=transaction after testing session mode.

[2026-03-25] You: What's the best hybrid search library for Node.js?
→ Evaluated QMD, LanceDB, and ChromaDB. Chose QMD for BM25+vector combo.

</dhakira_context>
```

The "About You" section is your **profile** — synthesized from your history by a local LLM, refreshed automatically as you work. The "Relevant Past Conversations" section is different every time, tailored to what you're actually working on. If you're debugging auth, you get auth history. If you're designing a schema, you get schema discussions.

Dhakira also knows which project you're in. Conversations from the current repo are boosted — and because the project is identified by the repo itself, not by the tool, memory from Codex surfaces in Claude Code and the other way around. Cross-project knowledge still appears when it's genuinely relevant.

## Full Local Stack

Dhakira works with cloud APIs, but it also works entirely offline with local models.

The memory engine is already 100% local — search, embeddings, reranking, **and profile synthesis** all run on your machine. Profile synthesis uses the same local 1.7B model that ships for query expansion, in-process, no extra download. If you also run your LLM locally, nothing ever touches the internet:

```yaml
# ~/.dhakira/config.yaml
tools:
  - name: Ollama
    provider: openai
    apiKey: "ollama"
    baseUrl: http://localhost:11434/v1
```

`dhakira init` auto-detects Ollama, LM Studio, and LocalAI if they're running. Works with any server that speaks the OpenAI API format.

**Your data. Your models. Your machine.**

## CLI

```
dhakira init         Set up Dhakira for the first time
dhakira start        Start Dhakira (daemon, hooks, dashboard)
dhakira start -d     Start in background
dhakira start -v     Verbose — show which memories are injected
dhakira stop         Stop a running instance
dhakira status       Show stats
dhakira connect      Wire tool hooks into Dhakira (claude-code | codex)
dhakira disconnect   Remove tool hooks
dhakira record       Save a fact directly to your memory
dhakira search       Search your captured memories
dhakira profile      Show your generated memory profile
dhakira extract      Regenerate your profile from captured conversations
dhakira consolidate  Distill redundant memories into denser ones
dhakira forget       Retire expired and aged-superseded memories
dhakira reset        Delete your wallet and start fresh
```

Dhakira runs in the background once started — these commands let you talk to your wallet directly, without going through an AI tool.

### Record a memory

```bash
$ dhakira record "I'm a TypeScript developer, based in Riyadh"
✓ Recorded as turn 8f3a2c1d (turn #1 in user-records).

$ dhakira record "I prefer functional patterns over classes"
✓ Recorded as turn b7e1a9f0 (turn #2 in user-records).
```

Recorded facts are first-class memories — indexed, searched, and pulled into your context block alongside captured conversation turns.

### Search your wallet

```bash
$ dhakira search "PostgreSQL pooling"

  1. [2026-03-25 · session sess_abc] (score 0.84)
     You: How should I handle connection pooling in PostgreSQL?
     → Used pgBouncer with pool_mode=transaction after testing session mode.

  2. [2026-03-12 · session sess_xyz] (score 0.71)
     You: pgBouncer vs PgPool-II for a small Node.js app?
     → Picked pgBouncer for its lower memory footprint.

  --limit N to return more (default 5, max 50)
```

This is the same search that runs during recall — useful for spot-checking what your tools are actually getting.

### Consolidate and forget

Memory that only grows gets noisy. Two commands keep it dense:

```bash
$ dhakira consolidate    # merge redundant memories into denser ones
$ dhakira forget         # retire expired and aged-superseded memories
```

Both are explicit and reversible. `forget` is a soft forget — it marks memories as retired and stops surfacing them, but the files stay on disk. Memories scored as **core** are never retired. Superseded memories get a 14-day grace period before they're eligible, so a bad merge can be undone.

### Profile

```bash
$ dhakira profile
```

Prints your generated profile (`~/.dhakira/profile.md`) with a "last updated" timestamp. If you haven't generated one yet:

```
No profile yet. Still learning about you — keep using your AI tools
and run `dhakira extract` to generate a profile.
```

### Status

```
$ dhakira status

  dhakira
  ━━━━━━━
  Status:   running (localhost:4100)
  Wallet:   ~/.dhakira
  Sessions: 12
  Turns:    847
  Size:     3.2 MB
  Last:     2 minutes ago
```

### Verbose mode

```
$ dhakira start -v

  Warming up search models (~2.25GB first time, one-time download)...
  [4:33 PM] Search models ready.
  [4:35 PM] 3 turns injected (0.41s)
    → "PostgreSQL connection pooling" (Mar 25)
    → "API authentication flow" (Mar 24)
    → "Rust error handling patterns" (Mar 22)
```

## Dashboard

A minimal web UI at `http://localhost:4101` — browse captured conversations, see your generated profile, watch what's being injected, and toggle incognito mode.

The Profile page is **read-only** — your profile is built by Dhakira, not edited by hand. The page shows when it was last refreshed, how many memories went into it, and a "Regenerate now" button if you want to force an update.

You can also record memories and run searches from the dashboard, with the same wiring as the CLI.

No login. No auth. It's localhost.

## Configuration

```yaml
# ~/.dhakira/config.yaml

proxy:
  port: 4100
  host: 127.0.0.1

dashboard:
  port: 4101
  host: 127.0.0.1

tools:
  # Cloud providers — API key path
  - name: Claude Code
    provider: anthropic
    apiKey: env:ANTHROPIC_API_KEY
    baseUrl: https://api.anthropic.com

  - name: OpenAI
    provider: openai
    apiKey: env:OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1

  # Claude Max/Pro subscription — pass-through auth
  - name: Claude Code (subscription)
    provider: anthropic
    apiKey: "*"
    baseUrl: https://api.anthropic.com

  # Local models
  - name: Ollama
    provider: openai
    apiKey: "ollama"
    baseUrl: http://localhost:11434/v1

injection:
  maxTokens: 1800         # Total injection budget
  minRelevanceScore: 0.3  # Minimum score to include a memory
  recencyBoost: 0.3       # Favor more recent conversations
  maxTurns: 8             # Max past conversations to inject

extraction:
  # Profile synthesis defaults to a local 1.7B model — zero API calls.
  # To use a stronger external model instead, fill these in:
  # apiKey: env:OPENAI_API_KEY
  # baseUrl: https://api.openai.com/v1
  # model: gpt-4o-mini
  apiKey: ""

capture:
  pipelineVersion: v2     # v2 is used for new installs
  debug: false

incognito: false          # Pause capture and injection globally
```

API keys support `env:VAR_NAME` syntax — Dhakira reads from your environment, never stores keys in the config file.

Tools connected by hooks don't need a `tools:` entry. That list is for base-URL routing.

### Wildcard matching (`apiKey: "*"`)

Wildcard tools pass the caller's original auth headers through untouched. This is how Claude Code's Max/Pro subscription (OAuth bearer) routes through the proxy without an API key. `dhakira init` offers to set this up when no `ANTHROPIC_API_KEY` is detected.

### Profile synthesis

Your profile is the "About You" block. It's built by an LLM that summarizes patterns from your captured turns.

By default this runs **locally** on a 1.7B model that ships with Dhakira. No API key, no network calls, no extra download. The trade-off is quality — a 1.7B model gives you a useful profile, a frontier model gives you a sharper one.

To upgrade, set `extraction.apiKey` (and optionally `extraction.baseUrl` and `extraction.model`). Anything OpenAI-compatible works.

Synthesis runs automatically in the background — the first pass after ~10 captured turns, refreshes every ~50. Force one with `dhakira extract` or the dashboard button.

### Capture pipeline

New installs use the v2 pipeline: a classifier, sanitizer, tool-aware extractor, and quality gate, so your wallet stores clean per-turn memories instead of harness boilerplate.

It runs for hook-captured turns and for both Anthropic- and OpenAI-format proxy traffic. Roll back with:

```yaml
capture:
  pipelineVersion: v1
```

## Your Wallet

Everything lives in `~/.dhakira`:

```
~/.dhakira/
├── config.yaml          # Your configuration
├── wallet.sqlite        # Search index (BM25 + embeddings)
├── profile.md           # Generated user profile
├── turns/               # Individual conversation turns
│   └── 2026-03-28/
│       ├── sess_abc-0.md
│       └── sess_abc-1.md
├── memories/            # Extracted facts, with salience and expiry
├── conversations/       # Full conversation backups
└── .pid                 # Process ID (when running)
```

It's just files. Back them up. Sync them. Move them to another machine. Grep them. They're yours.

## Privacy

**What Dhakira stores:**
- Conversation turns as markdown files, secret-redacted (`~/.dhakira/turns/`)
- Extracted facts as markdown files (`~/.dhakira/memories/`)
- Full conversation archives, stored verbatim (`~/.dhakira/conversations/`)
- A search index with embeddings (`wallet.sqlite`)
- A generated profile (`profile.md`)

**What Dhakira doesn't do:**
- Send your memory anywhere. Storage, search, extraction, and profile synthesis are all local. On the hook path, the only network traffic is your tool talking to its own provider — Dhakira isn't in that path at all. On the proxy path, Dhakira forwards your request to the provider you configured. Nothing else leaves.
- Phone home. No telemetry, no analytics, no update checks.
- Store your API keys in config. Keys use `env:` references.
- Write memory anywhere except `~/.dhakira`. Capture paths are constrained to the wallet directory.

The one exception, and it's deliberate: `dhakira connect` edits your tool's own config — `~/.claude/settings.json` or `~/.codex/config.toml` — because that's where hooks are registered. It merges rather than replaces, touches only entries it can identify as its own, and `dhakira disconnect` removes exactly those. If either file can't be parsed, Dhakira backs it up and refuses to write instead of overwriting your settings.

### Project detection never leaves your disk

Dhakira scopes memory by identifying the repository you're working in. It does that by reading `.git/config` off your local disk. It does **not** contact GitHub, does **not** shell out to `git`, and does **not** care whether your repo is public, private, or never pushed anywhere.

This is asserted by a test, not just documented. `test/store/git-identity.test.ts` performs a real `.git` read while spying on every outbound channel — `net.Socket.prototype.connect`, `net.connect`, `http.request`, `http.get`, `https.request`, `https.get` — and every process-spawning function — `spawn`, `exec`, `execFile`, `spawnSync`, `execSync`. It asserts the read produced the correct remote **and** that all eleven spies recorded zero calls.

Read it yourself: [`test/store/git-identity.test.ts`](test/store/git-identity.test.ts), [`src/store/git-identity.ts`](src/store/git-identity.ts).

### Secret filtering

Before writing a **turn** to disk, Dhakira runs a regex pass that redacts common API key, password, and token formats (11 patterns covering OpenAI, Anthropic, GitHub, Slack, AWS, JWT, generic bearer tokens, and others). Matches become `[REDACTED]`. Turns are what retrieval searches and what gets injected into future prompts, so this is the path that matters for re-transmission.

**Conversation archives are not redacted.** `~/.dhakira/conversations/` holds the verbatim exchange, because extraction and consolidation need the unmodified text to work from. If you paste a secret into a conversation, it exists in that archive in plain text on your disk.

So be precise about what this buys you: redaction stops a secret you pasted once from being *injected back* into a future conversation and re-sent to a model. It is not a guarantee that no secret is ever written to your disk. It's defense in depth, not a security boundary.

For high-sensitivity work, use `incognito: true` — it stops capture entirely, so nothing is written at all. You can also delete anything in `~/.dhakira/conversations/` at any time; it's plain files, and retrieval keeps working from `turns/`.

### Incognito mode

Toggle in the dashboard or set `incognito: true`. Dhakira stops capturing and injecting — your tools work normally, but nothing is remembered.

## What You Give Up

Dhakira is local-first, and local-first has costs. They're worth knowing before you install it.

**It uses your machine's resources.** ~2.25 GB of models on first run, and Node.js 22+. Retrieval runs models locally, so it wants GPU acceleration — any Apple Silicon Mac or a machine with a modern GPU is fine. Without acceleration, an uncached search can exceed the 1.5-second hook budget, in which case the hook gives up and your tool continues without memory. No error, nothing broken — just no recall. Old CPU-only hardware is not a good fit.

**Memory quality depends on your model.** Extraction, salience, and synthesis run on a local 1.7B model by default. It's genuinely useful. A frontier model is sharper. You can point extraction at a stronger endpoint, but then that part of the pipeline isn't local anymore — that's your call to make, not ours.

**Two hook adapters, not twenty.** Claude Code and Codex are wired properly and tested. Other tools connect through base-URL routing, and some tools — the ones that only talk to their vendor's servers — can't connect at all today.

**Your memory lives on the machine that captured it.** There's no sync. Move the folder yourself, or put it in something that syncs. Back it up like anything else you'd hate to lose.

**Nobody else is watching it.** No cloud dashboard, no account recovery, no support tier. If you delete the folder, it's gone. That's the same property that means nobody can read it but you.

Dhakira is for people who use several AI tools and want their context to follow them — and who would rather own that context than rent it.

## Requirements

- **Node.js 22+**
- **~2.25 GB disk** for local models (one-time download on first run)
- macOS and Linux. Intel and ARM.
- **GPU acceleration recommended.** Retrieval runs local models; without acceleration some searches will exceed the hook's 1.5-second budget and be skipped.

## FAQ

**Do I need the proxy if I use hooks?**
No. Hooks talk to the daemon directly and your tool reaches its provider on its own. Run `dhakira start`, connect your tool, and you're done. The proxy is there for tools without a hook system.

**What happens if Dhakira is down?**
On the hook path, nothing. Each hook call times out at 1.5 seconds and returns empty, so your tool proceeds without memory. On the proxy path, your tool gets "connection refused" — restart Dhakira, or unset the base-URL variable to reach your provider directly.

**Does Dhakira slow down my AI tool?**
No. The hook path is capped at 1.5 seconds and fails open, so the worst case is a brief pause and no injected memory. Models warm up at `dhakira start`, so your first prompt doesn't wait for a download, and repeated queries are faster because expansion results are cached. Capture, consolidation, and profile synthesis are all async and never block you. If your machine has no GPU acceleration, expect some searches to miss the budget and be skipped.

**How is this different from Claude's built-in memory?**
Claude's memory only works in Claude. Codex's only works in Codex. Dhakira's memory is keyed to your project, not to a vendor — so a decision you made in Codex shows up when you open Claude Code in the same repo. Platform memory is locked in. Yours shouldn't be.

**Can I use this with Cursor?**
Not today. Cursor routes API calls through its own servers, so a localhost proxy is unreachable, and it doesn't expose hooks Dhakira can connect to. Cursor's BYOK mode accepts a custom base URL, but that URL must be publicly reachable — and Dhakira stays on localhost by design. A Cursor adapter is on the list.

**Does this work with streaming responses?**
Yes. On the proxy path, Dhakira streams responses back byte for byte and captures after the stream completes. On the hook path, streaming is between your tool and its provider — Dhakira isn't involved.

**Does Dhakira support Claude Max/Pro subscription users?**
Yes. Hooks work regardless of how you authenticate. For proxy routing, `dhakira init` offers a wildcard tool config that lets Claude Code's OAuth bearer pass through untouched.

**Why is the first download so big?**
Three local models: query expansion (~1.28 GB), embeddings (~333 MB), reranker (~639 MB). Total ~2.25 GB, one time. They enable hybrid retrieval and profile synthesis without sending a single query to a cloud service.

**Can I edit my profile by hand?**
No — it's generated from your history and would be overwritten on the next refresh. To teach Dhakira something specific, use `dhakira record "..."`. Recorded facts are real memories that flow into the profile naturally.

**What's the difference between a turn and a memory?**
A turn is a captured exchange, stored as-is. A memory is a fact extracted from turns, scored for importance, and subject to consolidation and forgetting. Retrieval searches turns; your profile is built from memories.

## Contributing

Feel free to open an issue or submit a PR. Bug reports and feature requests are welcome.

Keep PRs scoped to one change. Tests live under `test/` and run with `npx vitest run`.

## License

MIT
