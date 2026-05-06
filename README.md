# Dhakira

[![npm version](https://img.shields.io/npm/v/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![npm downloads](https://img.shields.io/npm/dm/dhakira.svg?color=0366d6)](https://www.npmjs.com/package/dhakira)
[![license](https://img.shields.io/npm/l/dhakira.svg?color=0366d6)](LICENSE)
[![node](https://img.shields.io/node/v/dhakira.svg?color=0366d6)](package.json)

**Your AI, with memory.**

Every AI session starts from zero. Dhakira changes that.

Dhakira is a local proxy that sits between your AI tools and their APIs. It captures your conversations, learns from them, and quietly injects relevant context into future sessions — so every tool you use already knows you.

Your data never leaves your machine. No cloud. No account. Just a folder.

> **v0.2.1** adds Claude Max/Pro subscription support, fixes first-run onboarding, and eliminates the first-prompt freeze while models download. See the [changelog](CHANGELOG.md) for details.

## Table of Contents

- [Quick Start](#quick-start)
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

## Quick Start

```bash
npm install -g dhakira
dhakira init
dhakira start
```

`init` detects your API keys (or Claude Max/Pro subscription), writes `~/.dhakira/config.yaml`, and creates your wallet. `start` launches the proxy on `localhost:4100` and the dashboard on `localhost:4101`.

On first start, Dhakira downloads ~2.25 GB of local search models (query expansion, embeddings, reranker). This happens once — a progress line keeps you posted, and the proxy is ready to accept traffic the moment warmup finishes.

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
[Your AI Tool] ──→ [Dhakira :4100] ──→ [API Provider]
                         │                     │
                    ┌────┴─────┐               │
                    │ Search   │          stream back
                    │ relevant │          untouched
                    │ memories │               │
                    │ & inject │               │
                    └────┬─────┘               │
                         │                     │
                    ┌────┴─────┐               │
                    │ Capture  │               │
                    │ & embed  │               │
                    │ (async)  │               │
                    └──────────┘
```

1. Your tool sends a request through Dhakira
2. Dhakira searches your past conversations for anything relevant to the current query
3. Relevant context is injected into the system prompt — the AI reads it naturally
4. The request goes to the real API, response streams back untouched
5. After the response, Dhakira captures the conversation and embeds it for future search

Everything happens locally. Search uses hybrid retrieval (BM25 + semantic embeddings + reranking) via local GGUF models — no API calls for search or embeddings.

Dhakira auto-detects whether a request is in Anthropic or OpenAI format based on URL and headers. You don't configure the format — just point your tool at `localhost:4100` (or `:4100/v1` for OpenAI-compatible tools) and it works.

## What Gets Injected

Dhakira appends a small context block (~1500 tokens) to the end of your tool's system prompt. The block looks like this:

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

The context is different every time — tailored to what you're actually working on. If you're debugging auth, you get auth-related history. If you're designing a schema, you get schema discussions.

Dhakira also knows which project you're in. Conversations from the current project are boosted — but cross-project knowledge still surfaces when it's relevant.

## Full Local Stack

Dhakira works with cloud APIs, but it also works entirely offline with local models.

The memory engine is already 100% local — search, embeddings, and reranking all run on your machine via GGUF models. If you also run your LLM locally, nothing ever touches the internet:

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
dhakira init       Set up Dhakira for the first time
dhakira start      Start the proxy (foreground)
dhakira start -d   Start in background (daemon)
dhakira start -v   Verbose — show which memories are injected
dhakira stop       Stop a running instance
dhakira status     Show stats
dhakira reset      Delete your wallet and start fresh
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

A minimal web UI at `http://localhost:4101` — browse your captured conversations, view your profile, see what's being injected, and toggle incognito mode.

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

capture:
  pipelineVersion: v2      # v2 is used for new installs
  debug: false

incognito: false          # Pause capture and injection globally
```

API keys support `env:VAR_NAME` syntax — Dhakira reads from your environment, never stores keys in the config file.

### Wildcard matching (`apiKey: "*"`)

Wildcard tools pass the caller's original auth headers through untouched. This is how Claude Code's Max/Pro subscription (OAuth bearer) routes through Dhakira without an API key. `dhakira init` offers to set this up for you when no `ANTHROPIC_API_KEY` is detected.

### Capture Pipeline

New installs use the v2 capture pipeline for Anthropic-format traffic (Claude Code). It runs a classifier, sanitizer, tool-aware extractor, and quality gate so your wallet stores clean per-turn memories instead of harness boilerplate.

OpenAI-format traffic (aider, Continue, Ollama) uses the simpler v1 pipeline today. Extending v2 to OpenAI is on the roadmap for v0.2.2.

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
- Send data anywhere. All storage and search is local.
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
Search takes 50–400ms depending on your wallet size. Models warm up at `dhakira start`, so your first prompt doesn't wait for a download. After warmup, injection runs in parallel with your request.

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
Dhakira runs three local models — query expansion (~1.28 GB), embeddings (~333 MB), and reranker (~639 MB). Total ~2.25 GB, one-time. They enable hybrid retrieval without sending a single search query to any cloud service.

## Contributing

Feel free to open an issue or submit a PR. Bug reports and feature requests are welcome.

Keep PRs scoped to one change. Tests live under `test/` and run with `npm test`.

## License

MIT
