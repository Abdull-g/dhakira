# Changelog

All notable changes to Dhakira are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
