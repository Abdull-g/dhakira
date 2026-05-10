# Dhakira

[![npm version](https://img.shields.io/npm/v/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![npm downloads](https://img.shields.io/npm/dm/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![license](https://img.shields.io/npm/l/dhakira.svg?color=0366d6)](LICENSE)
[![node](https://img.shields.io/node/v/dhakira.svg?color=0366d6)](package.json)

**Your AI, with memory.**

Every AI session starts from zero. Dhakira changes that.

Dhakira is a local memory engine for your AI tools. It captures your conversations, learns from them over time, and quietly injects relevant context into future sessions — so every tool you use already knows you.

Your data never leaves your machine. No cloud. No account. Just a folder.


## Table of Contents

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
- [Requirements](#requirements)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install -g dhakira
dhakira init
```

`dhakira init` detects your API keys (or Claude Max/Pro subscription), writes `~/.dhakira/config.yaml`, and creates your wallet at `~/.dhakira`. Requires Node.js 22+.

On first launch, Dhakira downloads ~2.25 GB of local search models (query expansion, embeddings, reranker). This happens once — a progress line keeps you posted, and the proxy is ready to accept traffic the moment warmup finishes.

## Usage

Start Dhakira:

```bash
dhakira start
```

The proxy comes up on `localhost:4100` and the dashboard on `localhost:4101`.

Point your AI tool at Dhakira:

```bash
# Claude Code (API key or Max/Pro subscription)
export ANTHROPIC_BASE_URL=http://localhost:4100
claude

# aider
aider --openai-api-base http://localhost:4100/v1

# Any OpenAI-compatible tool
export OPENAI_BASE_URL=http://localhost:4100/v1
```

Start working. After a few sessions, you'll notice your AI remembering things you've told it before — without you repeating yourself.

Want to teach it something explicitly? `dhakira record "I prefer functional patterns, no classes"` and that fact is in your wallet immediately.

## Supported Tools

| Tool | Setup |
|------|-------|
| **Claude Code (API key)** | `export ANTHROPIC_API_KEY=...` then `export ANTHROPIC_BASE_URL=http://localhost:4100` |
| **Claude Code (Max/Pro subscription)** | `dhakira init` offers a subscription option when no API key is found. Then `export ANTHROPIC_BASE_URL=http://localhost:4100` |
| **aider** | `aider --openai-api-base http://localhost:4100/v1` |
| **Continue.dev** | Set `apiBase: http://localhost:4100/v1` on your model in `~/.continue/config.yaml` |
| **Any OpenAI-compatible tool** | Set the tool's base URL to `http://localhost:4100/v1` |
| **Ollama-backed tools** | Point at Dhakira; configure Ollama as the upstream in `config.yaml` |

> **Cursor, Copilot, ChatGPT, Claude.ai web/app:** these route API calls through their vendors' own servers, so a local proxy on `localhost` can't intercept them. Cursor's BYOK mode lets you set a custom base URL, but it needs a publicly reachable endpoint — Dhakira ships as localhost only, so this path isn't supported today.

## How It Works

```
[Your AI Tool] ──→ [Dhakira proxy :4100] ──→ [API Provider]
                          │                         │
                     ┌────┴─────┐                   │
                     │ Search   │              stream back
                     │ relevant │              untouched
                     │ memories │                   │
                     │ & inject │                   │
                     └────┬─────┘                   │
                          │                         │
                     ┌────┴─────┐
                     │ Capture  │   ──→  every 10 turns (first run)
                     │ & embed  │        every 50 turns (after that)
                     │ (async)  │        Layer 2 profile synthesis runs
                     └──────────┘        in the background, locally
```

1. Your tool sends a request through Dhakira
2. Dhakira searches your past conversations for anything relevant to the current query (Layer 1: hybrid retrieval over your captured turns)
3. Relevant context plus a generated profile (Layer 2: synthesized from your history) is injected into the system prompt
4. The request goes to the real API, response streams back untouched
5. After the response, Dhakira captures the conversation and embeds it for future search
6. Every so often, a background extraction pass updates your profile based on what you've been working on

Everything happens locally. Search uses hybrid retrieval (BM25 + semantic embeddings + reranking) via local GGUF models — no API calls for search, embeddings, or profile synthesis by default.

Dhakira auto-detects whether a request is in Anthropic or OpenAI format based on URL and headers. You don't configure the format — just point your tool at `localhost:4100` (or `:4100/v1` for OpenAI-compatible tools) and it works.

## What Gets Injected

Dhakira appends a small context block (~1800 tokens) to the end of your tool's system prompt. The block looks like this:

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

The "About You" section is your **profile** — synthesized from your history by a local LLM, refreshed automatically as you work. The "Relevant Past Conversations" section is different every time, tailored to what you're actually working on right now. If you're debugging auth, you get auth-related history. If you're designing a schema, you get schema discussions.

Dhakira also knows which project you're in. Conversations from the current project are boosted — but cross-project knowledge still surfaces when it's relevant.

## Full Local Stack

Dhakira works with cloud APIs, but it also works entirely offline with local models.

The memory engine is already 100% local — search, embeddings, reranking, **and profile synthesis** all run on your machine. Profile synthesis uses the same local 1.7B model that already ships for query expansion, in-process, no extra download. If you also run your LLM locally for inference, nothing ever touches the internet:

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
dhakira init        Set up Dhakira for the first time
dhakira start       Start the proxy (foreground)
dhakira start -d    Start in background (daemon)
dhakira start -v    Verbose — show which memories are injected
dhakira stop        Stop a running instance
dhakira status      Show stats
dhakira record      Save a fact directly to your memory
dhakira search      Search your captured memories
dhakira profile     Show your generated memory profile
dhakira extract     Regenerate your profile from captured conversations
dhakira reset       Delete your wallet and start fresh
```

The proxy runs entirely in the background once you've started it — these commands let you talk to your wallet directly, without going through an AI tool.

### Record a memory

Sometimes you want to teach Dhakira something without going through a conversation:

```bash
$ dhakira record "I'm a TypeScript developer, based in Riyadh"
✓ Recorded as turn 8f3a2c1d (turn #1 in user-records).

$ dhakira record "I prefer functional patterns over classes"
✓ Recorded as turn b7e1a9f0 (turn #2 in user-records).
```

Recorded facts are first-class memories — they get indexed, searched, and pulled into your context block alongside captured conversation turns.

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

This is the same search that runs during injection — useful for spot-checking what your AI tools are actually getting.

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

### Verbose Mode

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

The Profile page is **read-only** — your profile is built by Dhakira, not edited by hand. The page shows when it was last refreshed, how many memories went into it ("Generated from X memories across Y conversations"), and a "Regenerate now" button if you want to force an update. If you haven't built up enough history yet, you'll see an empty state ("Still learning about you") instead.

You can also record new memories and run searches directly from the dashboard, with the same wiring as the CLI commands above.

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
  maxTokens: 1800        # Total injection budget
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
  pipelineVersion: v2      # v2 is used for new installs
  debug: false

incognito: false          # Pause capture and injection globally
```

API keys support `env:VAR_NAME` syntax — Dhakira reads from your environment, never stores keys in the config file.

### Wildcard matching (`apiKey: "*"`)

Wildcard tools pass the caller's original auth headers through untouched. This is how Claude Code's Max/Pro subscription (OAuth bearer) routes through Dhakira without an API key. `dhakira init` offers to set this up for you when no `ANTHROPIC_API_KEY` is detected.

### Profile synthesis (Layer 2)

Your profile is the "About You" block injected into every prompt. It's built by an LLM that summarizes patterns from your captured turns.

By default, this runs **locally** on a 1.7B model that ships with Dhakira (the same one used for query expansion). No API key, no network calls, no extra download. The trade-off is quality — a 1.7B model gives you a useful profile, but a frontier model gives you a sharper one.

If you want to upgrade, set `extraction.apiKey` (and optionally `extraction.baseUrl` and `extraction.model`) and Dhakira will use that endpoint instead. Anything OpenAI-compatible works.

The synthesis runs automatically in the background — the first pass kicks in after ~10 captured turns, and subsequent refreshes happen every ~50 turns. You can also force a regeneration with `dhakira extract` or the dashboard's "Regenerate now" button.

### Capture Pipeline

New installs use the v2 capture pipeline. It runs a classifier, sanitizer, tool-aware extractor, and quality gate so your wallet stores clean per-turn memories instead of harness boilerplate.

v2 capture runs for both Anthropic-format traffic (Claude Code) and OpenAI-format traffic (aider, Continue.dev, Ollama, LM Studio, any OpenAI-compatible tool). Classifier rules for each tool family are tuned over time based on real usage.

Switch behavior with:

```yaml
capture:
  pipelineVersion: v2   # or v1 to roll back
```

## Your Wallet

Everything lives in `~/.dhakira`:

```
~/.dhakira/
├── config.yaml          # Your configuration
├── wallet.sqlite        # Search index (BM25 + embeddings)
├── profile.md           # Generated user profile (builds over time)
├── turns/               # Individual conversation turns
│   └── 2026-03-28/
│       ├── sess_abc-0.md
│       └── sess_abc-1.md
├── conversations/       # Full conversation backups
└── .pid                 # Process ID (when running)
```

It's just files. Back them up. Sync them. Move them to another machine. Grep them. They're yours.

## Privacy

**What Dhakira sees:**
- Every request and response that flows through the proxy

**What Dhakira stores:**
- Conversation turns as markdown files (in `~/.dhakira/turns/`)
- Full conversation backups (in `~/.dhakira/conversations/`)
- A search index with embeddings (in `wallet.sqlite`)
- A generated profile (in `profile.md`)

**What Dhakira doesn't do:**
- Send data anywhere by default. Storage, search, and profile synthesis are all local. The only network calls Dhakira makes are forwarding your AI requests to whichever provider you configured (and an external profile-synthesis endpoint, if you opt in).
- Phone home. No telemetry, no analytics, no update checks.
- Store your API keys in config. Keys use `env:` references.
- Touch anything outside `~/.dhakira`.

### Secret filtering

Before writing any turn to disk, Dhakira runs a regex pass that redacts common API key, password, and token formats (11 known patterns covering OpenAI, Anthropic, GitHub, Slack, AWS, JWT, generic bearer tokens, and a few others). Matches get replaced with `[REDACTED]`.

This is defense in depth, not a security boundary. Its real purpose is to prevent a secret you pasted in one conversation from being injected back into a future conversation (and re-transmitted to an LLM). If you want guaranteed coverage for high-sensitivity workflows, use `incognito: true` and handle the sensitive work outside Dhakira.

### Incognito mode

Toggle in the dashboard or set `incognito: true` in config. Dhakira stops capturing and injecting — your tools work normally, but nothing is remembered.

## Requirements

- **Node.js 22+**
- **~2.25 GB disk** for local search models (one-time download on first run)
- macOS and Linux. Intel and ARM.

## FAQ

**Does Dhakira slow down my AI tool?**
Search takes 50–400ms depending on your wallet size. Models warm up at `dhakira start`, so your first prompt doesn't wait for a download. After warmup, injection runs in parallel with your request. Profile synthesis is async and never blocks a user-facing request.

**What happens if Dhakira is down?**
Your tool gets "connection refused" on localhost:4100. Either restart Dhakira, or unset `ANTHROPIC_BASE_URL` (or whatever you set) to fall back to the provider directly.

**Can I use this with Cursor?**
Not today. Cursor routes API calls through its own servers, so Dhakira on `localhost` is unreachable. Cursor's BYOK mode accepts a custom base URL, but that URL has to be publicly reachable — and Dhakira is designed to stay on `localhost` for privacy. Bridging that gap means exposing Dhakira over the internet (tunnel / VPS), which we don't ship.

**How is this different from Claude's built-in memory?**
Claude's memory only works within Claude. Dhakira works across every tool with a custom API endpoint — your memory follows you from Claude Code to aider to whatever you use next. Platform memory is locked in. Yours shouldn't be.

**Does this work with streaming responses?**
Yes. Dhakira streams responses back to your tool in real-time, byte for byte. Capture happens asynchronously after the stream completes — you never wait for Dhakira.

**Does Dhakira support Claude Max/Pro subscription users?**
Yes, as of v0.2.1. `dhakira init` offers a wildcard tool config that lets Claude Code's OAuth bearer pass through to Anthropic untouched. No API key needed.

**Why is the first download so big?**
Dhakira runs three local models — query expansion (~1.28 GB), embeddings (~333 MB), and reranker (~639 MB). Total ~2.25 GB, one-time. They enable hybrid retrieval — and now profile synthesis — without sending a single search query to any cloud service.

**Can I edit my profile by hand?**
Not through the dashboard, no. The profile is generated from your captured history; editing it manually would just get overwritten on the next refresh. If you want to teach Dhakira something specific, use `dhakira record "..."` — recorded facts are real memories that flow into the profile naturally.

## Contributing

Feel free to open an issue or submit a PR. Bug reports and feature requests are welcome.

Keep PRs scoped to one change. Tests live under `test/` and run with `npm test`.

## License

MIT
