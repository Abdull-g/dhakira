# Changelog

All notable changes to Dhakira are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
