# Changelog

All notable changes to Dhakira are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2026-05-12

- Fixed: CLI silently exited with no output when installed via npm install -g due to a symlink-resolution bug in the entry-point guard. The CLI now correctly resolves through the npm-created symlink. Affects every npm-installed user of v0.2.5; v0.2.5.1 is required.

## [0.2.5] — 2026-05-10

The Layer 2 + delivery release. Profile synthesis now runs locally by default — no API key, no network calls, no extra download. Three new CLI commands (`record`, `search`, `profile`) let you talk to your wallet directly without going through an AI tool. Dashboard Profile is now read-only and shows what built it.

### Added

- **`dhakira record "fact"`** — save a fact directly to your wallet as a first-class memory. Recorded turns are indexed, searchable, and injected like any other memory. Useful when you want to teach Dhakira something without going through a conversation.
- **`dhakira search "query"`** — run the same hybrid retrieval that powers injection, against your wallet, from the terminal. Useful for spot-checking what your AI tools are actually getting. `--limit N` (default 5, max 50).
- **`dhakira profile`** — print your generated profile (`~/.dhakira/profile.md`) with a "last updated" timestamp, plus an empty-state message if you haven't built one yet.
- **Auto-extract trigger.** Profile synthesis now runs automatically in the background as you capture conversations — first pass after ~10 captured turns, subsequent refreshes every ~50 turns. Single-flight lock with coalesced follow-up so concurrent captures never queue up overlapping extractions.
- **Local-LLM profile synthesis (default).** Layer 2 (the "About You" block in your injection) now synthesizes on a local 1.7B model that already ships with Dhakira (the same model used for query expansion). No API key, no network, no extra disk. The trade-off is quality — a 1.7B gives you a useful profile; a frontier model gives you a sharper one.
- **External LLM as opt-in upgrade.** Set `extraction.apiKey` (and optionally `extraction.baseUrl` and `extraction.model`) in `~/.dhakira/config.yaml` to route synthesis through a frontier model instead. Anything OpenAI-compatible works.
- **Dashboard — record + search panels.** "Record Memory" form and search bar both wired to the same engine functions as the CLI commands.
- **Dashboard — "Regenerate now" button on Profile.** Force a profile refresh from the UI; same effect as `dhakira extract`.
- **Dashboard — Profile metadata.** Last-updated timestamp and "Generated from X memories across Y conversations" footer below the profile body.
- **Dashboard — "Still learning about you" empty state.** Clean placeholder when there isn't enough captured history to synthesize a profile yet.
- **`POST /api/record`, `GET /api/search`, `POST /api/extract`** — dashboard API endpoints backing the new UI.

### Changed

- **Dashboard Profile is now read-only.** The old free-form textarea is gone. Your profile is built by Dhakira from your captured history; editing it by hand would just get overwritten on the next refresh. Use `dhakira record "..."` if you want to teach Dhakira something specific.
- **README rewritten.** New CLI commands documented with examples. New `## Profile synthesis (Layer 2)` configuration subsection. New `extraction:` block in the example config. Privacy section clarified to reflect the local-default synthesis path. New FAQ on editing the profile by hand.

### Removed

- **`PUT /api/profile`.** The dashboard no longer writes to the profile, so the endpoint is gone. (Internal cleanup — nothing was using it externally.)

### Notes

- **No proxy or capture-pipeline changes in this release.** v2 capture (Anthropic + OpenAI formats) from v0.2.4 is unchanged. aider classifier rules remain on the v0.2.x backlog.

### Upgrade

```bash
npm install -g dhakira@latest
```

Existing wallets and configs remain compatible. If you previously set `extraction.apiKey` to use an external model, your config keeps working unchanged — the local-default path only kicks in when no key is configured.

## [0.2.4] — 2026-05-07

The OpenAI-format capture release. aider, Continue.dev, Ollama, LM Studio, and any OpenAI-compatible tool now run through the full v2 capture pipeline, same as Claude Code.

### Added

- **OpenAI-format v2 capture adapter.** `ingestOpenAITrace()` parses both non-streaming and streaming `/v1/chat/completions` traffic, including tool_calls, tool results, and multimodal content. All OpenAI-compatible tools now benefit from classifier-driven clean capture, sanitizer rules, and tool-aware turn extraction — same pipeline Anthropic has had since v0.2.0.
- **`dhakira extract` documented in help.** The manual extraction command now appears in `dhakira help`. Long flag aliases (`-d, --daemon` and `-v, --verbose`) are also shown.

### Changed

- **Default `pipelineVersion` is now `v2`** for both new installs and existing wallets that don't explicitly set `pipelineVersion: v1`. Existing users on v1 will be migrated to v2 automatically unless their config pins v1.
- **README injection block size** corrected from "~1500 tokens" to "~1800 tokens" (the actual default).

### Fixed

- **`dhakira init` no longer falsely prints "Dhakira is running"** before the server actually starts. The CLI now relies on `main()`'s own accurate listen messages.

### Notes

- The OpenAI v2 adapter promised in v0.2.1's notes (originally planned for v0.2.2) was rescheduled. v0.2.2 shipped as a docs-only release; v0.2.3 was skipped in favor of folding alignment fixes into this release.
- Chat Completions API (`/v1/chat/completions`) only. The newer Responses API (`/v1/responses`) for o-series reasoning models remains on v1 capture — separate ticket for a future release.
- aider-specific classifier rules are deferred to v0.2.5. Repo map preamble, file fences, and SEARCH/REPLACE delimiters are documented as TODOs in `src/capture/classifier.ts` and will be addressed once we have real usage corpus to tune against.

### Upgrade

```bash
npm install -g dhakira@latest
```

Existing wallets and configs remain compatible. To stay on v1 capture, add `pipelineVersion: v1` under `capture:` in your `~/.dhakira/config.yaml`.

## [0.2.2] — 2026-05-06

Documentation-only release. No code changes.

### Changed

- **README rewritten for accuracy and structure.** Corrected tool wiring examples (`ANTHROPIC_BASE_URL` for Claude Code, `--openai-api-base` for aider, `apiBase` in YAML for Continue.dev). Added explicit Claude Max/Pro subscription setup. Updated disk-space requirement to reflect the actual ~2.25 GB local model footprint. Reworked the secret-filtering section to describe what the 11 patterns actually cover (defense-in-depth, not a security boundary). Honest framing on Cursor compatibility (needs a publicly reachable endpoint; Dhakira is localhost-only). Added explicit note that v2 capture currently covers Anthropic-format traffic while OpenAI-format uses v1, with universal v2 tracked for a future release. Added a Table of Contents, Contributing section, and clearer Requirements list.

### Upgrade

```bash
npm install -g dhakira@latest
```

No behavioral changes. Existing wallets and configs remain compatible.

## [0.2.1] — 2026-05-06

A quality-of-life release focused on onboarding and first-run experience.

### Added

- **Claude subscription (Max/Pro) support via wildcard tool config.** `dhakira init` now detects when no `ANTHROPIC_API_KEY` is present and offers to add a pass-through Anthropic tool (`apiKey: "*"`) so Claude Code subscription users can route their OAuth-authenticated traffic through Dhakira without an API key.
- **Startup model warmup.** All three search models (query expansion, embeddings, reranker) now download and load at `dhakira start`, with visible progress messages. First user prompts are no longer blocked by a ~2.25 GB download. Falls back gracefully on failure.
- **Health check handling for `/` probes.** Claude Code's `GET /` and `HEAD /` startup probes now return a clean `204 No Content` instead of a misleading "No matching tool configuration" warning.

### Fixed

- **Wrong wiring flags in post-init output.** `dhakira init` no longer prints `claude --api-base ...` (which doesn't exist as a Claude Code flag). Uses correct `ANTHROPIC_BASE_URL` env var for Claude Code and `--openai-api-base` for aider.
- **Clean Ctrl+C shutdown on Apple Silicon.** Graceful shutdown no longer trails a `GGML_ASSERT` / `Abort trap: 6` stack trace from upstream `node-llama-cpp` Metal teardown. Dhakira now force-exits cleanly after its "Stopped." message.
- **Help text no longer suggests `npm install -g dhakira` when already installed globally.** The tip now only appears when running via `npx`.

### Notes

- This release does not change the capture pipeline. v2 remains Anthropic-only; OpenAI-format tools continue to use v1 capture. Universal v2 (including `ingestOpenAITrace`) is planned for v0.2.2.

### Upgrade

```bash
npm install -g dhakira@latest
```

Existing wallets and configs are compatible — no migration needed.

## [0.2.0] — 2026-05-03

### Added

- **New capture pipeline (`pipelineVersion: v2`).** Structured multi-stage processing: classifier → sanitizer → state-machine extractor → quality gate → turn writer. Produces clean, per-turn conversation pairs with zero provider boilerplate.
- **Tool-aware turn extraction.** Multi-step tool-use flows (Write + Bash + Read chains) are collapsed into a single clean turn pair per user intent. Intermediate tool-only assistant messages are skipped automatically.
- **System-reminder sanitizer.** Corpus-backed rule that strips `<system-reminder>` blocks and similar harness boilerplate before content reaches the memory wallet.
- **Request classifier with title-gen detection.** Internal Claude Code title-generation and quota-check requests are correctly identified and excluded from capture.
- **Quality gate.** Conservative junk filter that drops empty, malformed, or low-signal turn pairs before write.
- **Golden corpus regression tests.** Two lossless corpora (`test/corpus/claude-code-baseline-v1.jsonl`, `v2.jsonl`) make pipeline behavior reproducible and auditable.

### Changed

- **Retrieval now indexes only the `turns/` and `memories/` collections.** The `conversations/` directory remains on disk as a raw audit log (used by the extraction job) but is no longer registered with the search index. This keeps provider system prompts out of retrieval results.
- **Default `pipelineVersion` is `v2` for new installs.** Existing wallets without an explicit `capture.pipelineVersion` setting continue running the v1 pipeline until you opt in.

### Removed

- Legacy `searchMemories` retrieval surface (unused by the live injection path). All retrieval now flows through `searchTurns`.

### Upgrade

```bash
npm install -g dhakira@0.2.0
```

New wallets automatically use the v2 pipeline. To upgrade an existing wallet, add the following to `~/.dhakira/config.yaml`:

```yaml
capture:
  pipelineVersion: v2
```

You can roll back to v1 at any time by setting `pipelineVersion: v1`.

## [0.1.6] — 2026-04-29

- Streaming (SSE) response capture fix for turn pair extraction.

## [0.1.5] — 2026-04-07

- Graceful "already running" message instead of EADDRINUSE crash.

## [0.1.4] — 2026-04-04

- npx-aware CLI, fixed docs URL, global install tip.

## [0.1.0] — 2026-03-30

- Initial release — local-first portable AI memory system.
