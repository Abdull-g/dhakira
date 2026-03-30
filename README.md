# Dhakira

**Your AI, with memory.**

Every AI session starts from zero. Dhakira changes that.

Dhakira is a local proxy that sits between your AI tools and their APIs. It captures your conversations, learns from them, and quietly injects relevant context into future sessions — so every tool you use already knows you.

Your data never leaves your machine. No cloud. No account. Just a folder.

## Quick Start

```bash
npx dhakira init
```

That's it. Dhakira detects your API keys (or local models), creates a wallet at `~/.dhakira`, and starts the proxy. Point your tool at it:

```bash
# Claude Code
claude --api-base http://localhost:4100

# aider
aider --api-base http://localhost:4100

# Any OpenAI-compatible tool
export OPENAI_BASE_URL=http://localhost:4100/v1
```

Start coding. After a few sessions, you'll notice your AI remembering things you've told it before — without you repeating yourself.

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

## What Gets Injected

Dhakira injects a small context block (~1500 tokens) into every conversation:

```text
── dhakira_context ──────────────────────────

About You
- TypeScript developer, based in Riyadh
- Working on a RAG-based memory system
- Prefers functional patterns, no classes

Relevant Past Conversations
[2026-03-28] You: How should I handle connection pooling in PostgreSQL?
→ Used pgBouncer with pool_mode=transaction after testing session mode.

[2026-03-25] You: What's the best hybrid search library for Node.js?
→ Evaluated QMD, LanceDB, and ChromaDB. Chose QMD for BM25+vector combo.

─────────────────────────────────────────────
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

`dhakira init` automatically detects Ollama, LM Studio, and LocalAI if they're running. Works with any server that speaks the OpenAI API format.

**Your data. Your models. Your machine.**

## Supported Tools

Dhakira works with any tool that lets you set a custom API endpoint:

| Tool | Setup |
|------|-------|
| **Claude Code** | `claude --api-base http://localhost:4100` |
| **aider** | `aider --api-base http://localhost:4100` |
| **Continue.dev** | Set `apiBase` to `http://localhost:4100` in config |
| **Open Interpreter** | `interpreter --api-base http://localhost:4100` |
| **Ollama-backed tools** | Point to Dhakira instead of Ollama directly |
| **Any OpenAI-compatible** | Set base URL to `http://localhost:4100/v1` |

For Anthropic-format tools, Dhakira auto-detects the format from the request — no extra configuration needed.

## CLI

```
npx dhakira init       Set up Dhakira for the first time
npx dhakira start      Start the proxy (foreground)
npx dhakira start -d   Start in background (daemon)
npx dhakira start -v   Verbose — show what memories are injected
npx dhakira stop       Stop a running instance
npx dhakira status     Show stats
npx dhakira reset      Delete your wallet and start fresh
```

Or install globally for convenience: `npm install -g dhakira` — then use `dhakira` directly.

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
  # Cloud providers
  - name: Claude Code
    provider: anthropic
    apiKey: env:ANTHROPIC_API_KEY
    baseUrl: https://api.anthropic.com

  - name: OpenAI
    provider: openai
    apiKey: env:OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1

  # Local models
  - name: Ollama
    provider: openai
    apiKey: "ollama"
    baseUrl: http://localhost:11434/v1

injection:
  maxTokens: 1800        # Total injection budget
  minRelevanceScore: 0.3  # Minimum score to include a memory
  recencyBoost: 0.3       # How much to favor recent conversations
  maxTurns: 8             # Max past conversations to inject

incognito: false          # Pause capture and injection globally
```

API keys support `env:VAR_NAME` syntax — Dhakira reads from your environment, never stores keys in the config file.

Wildcard matching (`apiKey: "*"`) is available for tools that use OAuth tokens or non-standard auth.

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
- Store your API keys. Keys use `env:` references, not plaintext.
- Touch anything outside `~/.dhakira`.

**Secret filtering:** Dhakira scans for API keys, passwords, and tokens before storing conversations. Detected secrets are replaced with `[REDACTED]`.

**Incognito mode:** Toggle in the dashboard or set `incognito: true` in config. Dhakira stops capturing and injecting — your tools work normally, but nothing is remembered.

## Requirements

- **Node.js 22+** (required by the search engine)
- **~500MB disk** for search models (downloaded once on first use)
- Works on macOS and Linux. Intel and ARM.

## FAQ

**Does Dhakira slow down my AI tool?**
Search takes 50-400ms depending on your wallet size. The first request after startup is slower (~2-3 min) because the embedding model needs to load — after that, it stays warm.

**What happens if Dhakira is down?**
Your tool gets "connection refused" on localhost:4100 and won't work until you either restart Dhakira or point your tool back at the original API.

**Can I use this with Cursor?**
Not yet. Cursor routes API calls through its own servers, so the proxy can't intercept them. MCP support is on the roadmap — that would unlock Cursor, Windsurf, and other cloud-routed tools.

**How is this different from Claude's built-in memory?**
Claude's memory only works within Claude. Dhakira works across every tool that supports custom API endpoints — your memory follows you from Claude Code to aider to whatever you use next. Platform memory is locked in. Yours shouldn't be.

**Does this work with streaming responses?**
Yes. Dhakira streams responses back to your tool in real-time, byte for byte. Capture happens asynchronously after the stream completes — you never wait for Dhakira.

**Can I contribute?**
Yes. MIT licensed. PRs welcome.

## License

MIT
