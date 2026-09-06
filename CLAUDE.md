# CLAUDE.md — pointer

The binding architecture notes and **standing orders** for Dhakira live outside this
repository, in the project notes:

- `~/memory-wallet-notes/CLAUDE.md` — architecture (v2 RAG-first), pipeline order,
  conventions, standing orders (read this fully before writing code).
- `~/.claude/CLAUDE.md` — user-level standing orders and working discipline.
- `~/memory-wallet-notes/audits/` — engine audits and release completion reports.

Two rules every contributor must know without opening those files:

1. **Standing Order #7 — import boundary.** Engine code (`src/capture/`, `src/retrieval/`,
   `src/extraction/`, `src/injection/`, `src/store/`, `src/salience/`, `src/synthesis/`,
   `src/harness/`, `src/hooks/`, and the root verbs `src/ingest.ts` / `src/recall.ts` /
   `src/doctor.ts`) must **not** import from `src/proxy/` or `src/dashboard/`. The only
   tolerated exception is a type-only import of `Result` / `NormalizedMessage` from
   `src/proxy/types.ts`. Enforced by `test/architecture/standing-order-7.test.ts`.
2. **Reasoning over code.** Dhakira remembers *why* a choice was made, dead ends and
   conventions — never the code itself. `conversations/` is the verbatim archive (the
   mine); `turns/` is the sanitized, indexed, injected layer.

Fail-open is the law at the hooks: the 1.5 s budget in `src/hooks/shared-adapter.ts`
never increases, and every hook path exits 0 silently on any error. Deadline work is
done daemon-side (`src/retrieval/search.ts`).

Test command: `CI=true npx vitest run` (never `npm test` — watch mode hangs).
