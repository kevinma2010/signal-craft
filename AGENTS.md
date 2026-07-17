# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

SignalCraft is an open-source AI intelligence agent that fetches high-signal AI content (builder posts, official blogs, GitHub releases, YouTube, podcasts, X topics), deduplicates and ranks it, and generates evidence-backed daily/weekly briefings. The repository itself is an agent skill with a host-neutral core. Codex in the ChatGPT desktop app is the primary product-beta runtime; other runtime compatibility is best-effort. Core instructions must never depend on host-specific tools.

**Current state:** the Phase 1 technical MVP is complete, including four connectors, incremental local archives, run audits, translation/transcription paths, deterministic tests, and a local reader. Current work is Codex-first product validation: onboarding, dependency health, a tested Scheduled-task recipe, and repeated usage with design partners. SignalCraft does not ship its own scheduler or email delivery.

## Architecture

Two layers, all running on the user's machine (local-first, no central service — this is a deliberate Phase 1 decision recorded in `docs/DESIGN.md` and `ROADMAP.md`):

1. **Connector scripts** (`scripts/`, TypeScript run with Bun, one per source category: `fetch-rss.ts`, `fetch-github.ts`, `fetch-youtube.ts`, `fetch-x.ts`). Each follows the same CLI contract (`--config`, `--since`, `--out`) and writes normalized JSONL items to `~/.signalcraft/inbox/`. Shared helpers go in `scripts/lib/`. See `docs/IMPLEMENTATION.md` for the item schema and contract details.
2. **Intelligence layer** — ranking, story clustering, and briefing generation are performed by Codex using the prompt templates in `PROMPTS.md`, not by code.

Key implementation decisions already made:

- Transcription: native transcripts first (YouTube subtitles via yt-dlp, podcast show notes); Deepgram API as fallback; cache transcripts permanently by item id.
- X collection and topic discovery: shell out to the Grok Build CLI (xAI's agent CLI) in headless mode (`grok -p` with `--json-schema`), which has native real-time X search; auth is the CLI's own local login, not an API key.
- API keys come from environment variables only (`DEEPGRAM_API_KEY`, optional `GITHUB_TOKEN`); a missing key, binary, or CLI login disables that capability gracefully rather than failing the run.
- User data lives in `~/.signalcraft/` (config, sources, seen-set, transcript cache, digests), never inside the skill directory.
- No database — state is JSONL and YAML files.

## Commands

Quality gates:

```
bun run lint
bun run typecheck
bun run test:unit
bun run test:e2e
bun test
bun run doctor
```

Connectors run as:

```
bun scripts/fetch-<category>.ts --config ~/.signalcraft/sources.yaml --since <ISO8601> --out ~/.signalcraft/inbox/<category>.jsonl
```

## Documentation Map and Sync Rules

Each document has a single owner-topic; content is deliberately not duplicated:

- `docs/DESIGN.md` — product philosophy, source policy, ranking model
- `docs/IMPLEMENTATION.md` — MVP technical design (scripts, schema, credentials)
- `docs/TASKS.md` — completed Phase 1 implementation record; current product work lives in `ROADMAP.md`
- `SKILL.md` — the skill's runtime responsibilities and output format
- `PROMPTS.md` — prompt templates for digest/social/podcast/official-update summarization
- `PROJECT_POLICY.md` — governance, community conduct, privacy, acknowledgements, trademark; `CODE_OF_CONDUCT.md` is only a thin pointer to it
- `ROADMAP.md` — phase scope; Phase 1 non-goals are authoritative

When adding, removing, or moving any file, update both `FILE_MANIFEST.md` and the repository-structure block in `README.md` — these have drifted from reality before and are checked manually.
