# MVP Task Plan

Execution plan for the Phase 1 MVP. Every design decision referenced here is
recorded in [IMPLEMENTATION.md](IMPLEMENTATION.md); this document only
sequences the work. Update the status column as tasks land.

## Dependency Graph

```text
#1 Scaffolding + scripts/lib
 ├─▶ #2 fetch-rss.ts (end-to-end template)
 │     ├─▶ #4 fetch-github.ts        ┐
 │     ├─▶ #5 fetch-youtube.ts       │ parallel
 │     ├─▶ #6 fetch-x.ts (Grok)      │
 │     └─▶ #8 SKILL.md execution     ┘
 ├─▶ #7 DeepSeek translation (parallel with #2)
 └─▶ #9 fixtures + rubric (parallel with #2)

#3 Default source pack (no dependencies, content work)

#1–#9 all done ─▶ #10 unified incremental ingestion + optional X API
                         └─▶ #11 end-to-end verification + packaging
```

Task #2 is the critical path: once the first connector proves the full
fetch → sanitize → dedup → archive chain, tasks #4/#5/#6/#8 unlock and run
in parallel.

## Tasks

### 1. Scaffolding and the `scripts/lib` shared library

Status: complete

- `package.json` (Bun 1.x + TypeScript), Biome (lint/format), GitHub
  Actions CI (typecheck + `bun test`)
- `scripts/lib/`: normalized item schema and types; HTML→Markdown sanitizer
  (strip scripts/styles/forms/tracking pixels; preserve all media
  references — video/audio/iframe become typed plain links); `seen.jsonl`
  handling with 90-day pruning; default-pack + user-overlay source merging;
  `signalcraft.lock`; `state.json` handling including per-source
  consecutive-failure counts; state-file `version` field with in-place
  migration framework (tested)

### 2. `fetch-rss.ts` — first connector

Status: complete

- Implements the script contract (`--config` / `--since` / `--out`) for
  RSS/Atom (blogs, changelogs, podcasts) using `fast-xml-parser`
- Proves the end-to-end chain: fetch → sanitize → dedup → archive to
  `items/`
- Fixture-driven `bun test`; this is the template every other connector
  copies

### 3. Default source pack `sources.default.yaml`

Status: complete

- 93 curated entries: 31 RSS feeds, 4 GitHub repositories, 3 YouTube
  channels, 37 X accounts, and 18 exact X topic queries
- Evaluated against the DESIGN.md source policy (proximity to the work,
  originality, technical depth, noise level)
- Kevin-curated first-hand-only policy; inactive, stale, repost, and
  marketing-heavy sources excluded
- Schema covers type, URL/handle/query, weight, category, tags, usage, tier,
  and per-topic result limits

### 4. `fetch-github.ts`

Status: complete

- Releases and maintainer discussions via the GitHub public REST API
- `GITHUB_TOKEN` optional (raises rate limits), graceful degradation
  without it

### 5. `fetch-youtube.ts` and the transcription chain

Status: complete

- Channel RSS for discovery; yt-dlp for metadata and subtitles
- Transcription chain: native subtitles / show notes first → Deepgram
  fallback (default on, 10 items per run, over-budget items degrade to
  title + description); permanent cache in `cache/transcripts/`
- Podcast audio (enclosure URL) → Deepgram path also lands here
- Missing yt-dlp: prompt with the install command, install on consent

### 6. `fetch-x.ts` — Grok Build integration

Status: complete

- Subprocess call to the Grok Build CLI in headless mode (`grok -p` with
  `--json-schema`; verified against the locally installed CLI)
- Searches X posts and topics from `sources.yaml`; topic expansion (people,
  products, repos) goes through the same channel
- Persistent per-handle/query search cursors skip completed time ranges;
  successful sources advance independently while failed sources retry
- Schema-validate the agent output with one retry
- Missing or logged-out CLI: disable the category gracefully with
  install/login instructions

### 7. DeepSeek full-text translation module

Status: complete

- DeepSeek API, native-style localized rewrite, meaning and facts preserved
- Technical terms and proper names remain unchanged; Markdown structure and
  media links are preserved
- Scope: items selected into a briefing, plus on-demand for archived items
  opened in the reading view
- Immutable cache in `cache/translations/` keyed by item id + target
  language; skipped without `DEEPSEEK_API_KEY`
- Only fetched public content is sent; user data never leaves the machine

### 8. SKILL.md execution details

Status: complete

- Upgrade SKILL.md from a descriptive spec to executable instructions:
  first-run conversational setup (writes `config.yaml` + `sources.yaml`
  overlay), session-start menu, the six-step execution flow (pre-summaries,
  novelty replay, feedback injection, Run Report, archiving), data-delimiter
  usage for injection defense, the three depth levels, lock and degradation
  notices
- Must stay portable across all three runtimes — no host-specific tools in
  the core flow

### 9. Fixtures corpus and scoring rubric

Status: complete

- `fixtures/`: sanitized samples of every item type, deliberate cross-source
  duplicates, one long transcript, prompt-injection samples
- Rubric written against the eight ranking signals in DESIGN.md
- Corpus doubles as connector unit-test input; CONTRIBUTING.md already
  requires prompt PRs to include before/after output on it

### 10. Unified incremental ingestion and optional X API

Status: complete

- Separate collection scheduling from daily, weekly, and ad-hoc report
  generation; reports read permanent archived items and never re-fetch a
  covered interval
- Preserve legacy category history without treating it as source coverage;
  migrate proven Grok search state into stable provider/source checkpoints
  with archive-then-commit before report generation
- Use stable normalized item IDs plus normalized URLs for permanent
  idempotency; preserve provider IDs as metadata and retain failed-source gaps
- Bound first-run collection to 24 hours, one page per source, and explicit
  connector budgets
- Add an opt-in X API adapter for narrow incremental searches; keep Grok Build
  as the default topic-discovery provider
- Enforce usage preflight, per-run/day/month hard budgets, no default
  pagination, tiered query scheduling, circuit breaking, and source/page cost
  audit records
- Add unit and E2E coverage listed in `docs/TESTING.md`, including daily and
  weekly archive windows with zero repeated connector calls

### 11. End-to-end verification, packaging, install docs

Status: in progress

- Produce the first real briefing against the real source pack, exercising
  the full chain: fetch → transcribe → pre-summarize → rank → cluster →
  translate → Run Report → archive
- Verify on Claude Code plus at least one other runtime
- Claude Code plugin manifest; README install guide (clone into the skills
  directory or plugin install, external binaries, API keys)
- Completed: plugin manifest validation, Grok account-search smoke, external
  binary checks, deterministic unit and E2E suite
- Remaining: one bounded real briefing across the full content pipeline when
  optional transcription and translation credentials are available
