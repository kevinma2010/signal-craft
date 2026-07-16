# SignalCraft MVP Implementation Design

This document describes the technical design of the Phase 1 open-source MVP.
Product philosophy, source policy, and ranking are covered in [DESIGN.md](DESIGN.md).

## Overview

The MVP has two layers:

1. **Connector scripts** — one script per source category. Each script fetches
   content, normalizes it into a common item format, and writes JSONL to the
   local inbox. Scripts are deterministic and independently testable.
2. **Intelligence layer** — the host agent, driven by the skill instructions
   and the prompts in [PROMPTS.md](../PROMPTS.md), reads the normalized items
   and performs filtering, ranking, story clustering, and briefing generation.

Everything runs on the user's machine. There is no central service.

## Runtime Portability

SignalCraft targets multiple agent runtimes, not only Claude Code. Claude
Code, Codex CLI, and Grok Build all support the skill format natively, so a
single `SKILL.md` serves every runtime — no per-runtime adapter files.

The rest of the core is equally runtime-neutral: connector scripts,
`PROMPTS.md`, and the config and data layout under `~/.signalcraft/`.

Instructions must degrade gracefully across runtimes: use the structured
question UI where the host provides one, otherwise fall back to plain
conversational prompts; never depend on host-specific tools for core flow.

## Runtime Layout

```text
~/.signalcraft/
├── config.yaml        # preferences: frequency, language, depth, interests, delivery
├── sources.yaml       # user overlay over the default source pack (see below)
├── state.json         # collection checkpoints and source health
├── signalcraft.lock   # transient run lock (pid + started_at)
├── collection-state.lock # serializes archive/checkpoint commits
├── x-api.lock         # serializes paid X API collection
├── seen.jsonl         # processed item fingerprints (id, normalized url, first_seen)
├── feedback.jsonl     # user feedback events
├── inbox/             # per-run staging written by connector scripts
│   └── <category>.jsonl
├── items/             # permanent archive of all processed items
│   └── YYYY-MM.jsonl
├── cache/
│   ├── x-search-state.json # legacy Grok search high-water marks; migrates into state.json
│   ├── x-api-usage.jsonl   # paid request reservations and reconciliations
│   ├── collection-pending/ # crash-recovery records for archive/checkpoint commits
│   ├── transcripts/        # transcripts and pre-summaries, keyed by item id
│   └── translations/       # full-text translations, keyed by item id + language
└── digests/           # generated briefings, YYYY-MM-DD.md
```

User data lives outside the skill directory so skill updates never touch it.

### Source Pack Layering

The curated default source pack ships in the repository as
`sources.default.yaml` and is updated via `git pull`. The user's
`sources.yaml` stores only a diff: added sources, disabled defaults, and
weight overrides. Connectors merge the two at load time, so pack
improvements reach existing users automatically while user intent is never
overwritten.

The default pack stores ranking metadata (`weight`, `tier`, `tags`, and
`usage`) alongside connector coordinates. X entries use either `handle` for
account monitoring or an exact `query` plus `max_results` for topic search.
Connectors copy ranking metadata into each normalized item's `extra` object.

### Data Lifecycle

All content data persists locally — it feeds the future local reading view
and the Phase 3 searchable archive. Retention is per type:

- `inbox/` — collection staging only. Successful connector output is appended
  to the `items/` archive and committed to collection state before report
  generation starts; the staging area is then cleared.
- `items/` — permanent. Monthly JSONL files holding every processed item in
  full (original text included).
- `seen.jsonl` — pruned: fingerprints older than 90 days are dropped (the
  fetch lookback cap is 30 days, so older fingerprints can never match).
- Durable cache entries (X usage, transcripts, pre-summaries, translations) —
  permanent. Pending collection records are removed after recovery or commit.
- `digests/` — permanent.

### Collection Ledger and Briefing Windows

Collection is independent from report generation. A scheduled or manual
collection run appends newly discovered normalized items to the permanent
archive. Daily, weekly, and ad-hoc briefings then select an event-time window
from `items/`; they do not invoke connectors themselves. In particular, a
weekly briefing re-ranks and re-clusters the previous seven days of archived
items rather than concatenating daily prose or fetching the sources again.

`state.json` stores a checkpoint for every provider and stable source identity,
not only one timestamp per category. A checkpoint contains the covered-through
time, an optional provider cursor such as an X `since_id`, and the last
successful collection time. Ranking metadata, schedule, page size, and result
limit changes do not reset collection progress. Changing retrieval coordinates,
such as an exact query, creates a new source identity with a bounded initial
window while retaining the old ledger entry for audit.

Connectors follow these rules:

1. Ask the provider only for data after the committed source checkpoint when
   the provider supports a cursor or time filter.
2. Write a pending recovery record, durably archive normalized items, and then
   atomically advance the checkpoint before report generation. Recovery
   completes this sequence without another provider request. A report, model,
   or process failure therefore cannot skip data or repeat paid collection.
3. Keep a stable normalized item ID as the primary identity and the normalized
   URL fingerprint as a fallback. Provider-native IDs remain in item metadata
   where available. Archive and staging data are checked before appending.
4. Never advance a failed source because another source in the category
   succeeded. Retry only that source's uncovered interval.
5. Perform a targeted, explicitly bounded gap repair only when the ledger
   contains a missing interval. Routine report generation never backfills.

The first collection run is a special bounded backfill. It defaults to 24
hours, one page per source, and connector-specific item and cost ceilings.
Expanding the lookback or enabling pagination requires an explicit user action.

### State Versioning

Every state and config file carries a `version` field and rejects unsupported
future versions. `state.json` v1 is migrated in place after writing a backup;
the currently single-version config and source schemas require no migration.

### Source Health

`state.json` tracks a consecutive-failure count per source, reset on
success. At 3 or more consecutive failures, the Run Report escalates from a
one-line mention to a recommendation to disable the source; one user
confirmation writes the disable into the `sources.yaml` overlay. Sources are
never disabled automatically — transient outages must not silently shrink
coverage.

### Concurrency

A run takes `signalcraft.lock` (pid + started-at timestamp) before touching
shared state. If the lock is already held, the skill tells the user another
briefing run is in progress instead of proceeding. A stale lock older than
30 minutes is taken over. This keeps concurrent sessions in different
runtimes (e.g. Claude Code and Grok Build at once) from corrupting
`state.json` or double-reporting items.

## Connector Scripts

Connectors are TypeScript scripts run with Bun, one per source category,
under `scripts/`:

| Script | Category | Method |
|---|---|---|
| `fetch-rss.ts` | Blogs, changelogs, podcasts | RSS/Atom via feed parsing |
| `fetch-github.ts` | Releases, maintainer discussions | GitHub public REST API |
| `fetch-youtube.ts` | Channels and videos | Channel RSS for discovery; yt-dlp for metadata and subtitles |
| `fetch-x.ts` | X posts and topic discovery | Grok Build CLI live search over X content and topics |

Shared helpers live in `scripts/lib/` (normalization, seen-set handling,
config loading).

### Script Contract

Every connector follows the same contract:

```text
bun scripts/fetch-<category>.ts --config ~/.signalcraft/sources.yaml \
                                --since <ISO8601> \
                                --out ~/.signalcraft/inbox/<category>.jsonl
```

- Fetch only items newer than `--since`, skipping ids already in `seen.jsonl`.
- Write one normalized item per line; append-safe and idempotent.
- Never write secrets to output or logs.
- Exit non-zero on total failure; partial source failures are reported on
  stderr and do not abort the run.

`--since` is a safety lower bound supplied by the collection scheduler. Each
connector combines it with its source-specific committed checkpoint and uses
the later value. Lookback is capped at 30 days. Report frequency never changes
collection lookback: the first run defaults to 24 hours, including when the
first requested report is weekly.

### Content Sanitization

Fetched content is untrusted (see DESIGN.md's security boundary). The
defense is layered:

- **Connectors emit Markdown only.** All fetched HTML is converted to
  Markdown at the script layer. Stripped: scripts, styles, forms, and
  tracking pixels — executable and surveillance content only. Preserved:
  every media reference in the body. Images (figures, screenshots) become
  Markdown image links; video, audio, and iframe embeds become plain links
  labeled with their media type (e.g. `[Video: <title>](url)`), so the
  future reading view can restore them as players. When and how to load
  media is the renderer's decision. The `text` field never contains raw
  HTML, and archived Markdown is what the reading view renders — no
  re-fetching at display time.
- **Item text is data, never instructions.** The intelligence layer wraps
  each item's text in explicit data delimiters. Instructions found inside
  fetched content are treated as content to report on, never obeyed. During
  briefing generation the agent performs no writes or network requests
  beyond the steps in the execution flow.

### Deduplication and Clustering

Deduplication is split across the two layers:

- **Scripts: URL-level, deterministic.** Normalize the URL (strip tracking
  parameters, unify hosts), fingerprint it, and skip anything already in
  `seen.jsonl`.
- **Intelligence layer: semantic, in context.** Cross-source story clustering — multiple
  items covering the same event — is judged by the active runtime during briefing
  generation, per the story-cluster rules in DESIGN.md. The MVP deliberately
  uses no embeddings; if item volume outgrows the context window, embedding
  pre-clustering is a Phase 2 optimization.

### Context Budget

Long items must not blow up the ranking context:

- Items whose text exceeds roughly 3,000 words (typically podcast and video
  transcripts) get a **pre-summary pass** using the podcast/video template in
  PROMPTS.md. The summary is cached in `cache/` next to the transcript, keyed
  by item id, so each item is summarized at most once.
- Pre-summarization runs in the session, item by item — portable across all
  runtimes. When the host supports subagents, items are summarized in
  parallel, which also isolates long untrusted text from the main context.
- The main ranking pass reads short items in full and long items via their
  cached pre-summaries; the full transcript is consulted only when a specific
  claim needs verification.

### Novelty Memory

`seen.jsonl` catches exact re-fetches but not the same story republished by
a different source. For the novelty signal, the ranking context also
includes the item titles and story topics from the last 7 days of briefings
in `digests/` — the agent then judges "already covered unless there is a
material new development" directly. No separate state file is needed; the
digest archive is the memory.

### Normalized Item Schema

```json
{
  "id": "sha256(url + published_at)",
  "type": "article | post | video | podcast | release",
  "source": "source name from sources.yaml",
  "author": "author or account",
  "title": "item title",
  "url": "original link",
  "published_at": "ISO8601",
  "fetched_at": "ISO8601",
  "text": "extracted text or transcript",
  "transcript_provider": "native | deepgram | none",
  "extra": {}
}
```

## Transcription Strategy

Applies to YouTube videos and podcast episodes:

1. **Native first.** Use the resource's own transcript when available:
   YouTube subtitles/auto-captions via yt-dlp, podcast show notes or
   published transcripts.
2. **Deepgram fallback.** When no native transcript exists, download the
   audio (yt-dlp for YouTube, the enclosure URL for podcasts) and send it to
   the Deepgram prerecorded transcription API.
3. **Cache aggressively.** Transcripts are immutable; cache them in
   `cache/transcripts/` keyed by item id so no audio is ever transcribed twice.

Deepgram calls cost money, so `config.yaml` supports a per-run transcription
budget and an opt-out. Default: transcription is enabled when
`DEEPGRAM_API_KEY` is present, capped at **10 items per run**; items beyond
the budget fall back to title, description, and show notes only.

## Translation

The digest narrative is always written in the user's language by the host
agent (language rules live in PROMPTS.md). Separately, **full-text
localization** powers the original/translated side-by-side reading in the
planned local reading view. It preserves the source meaning while rewriting
it in natural native phrasing, so it is offloaded to the DeepSeek API — far
cheaper than host-agent tokens:

- Scope: only items selected into a briefing are translated; ranked-out
  items cost nothing. Archived items without a translation are translated on
  demand when opened in the reading view.
- Technical terms, product and model names, APIs, libraries, companies, and
  people's names remain in their original form.
- Translations are cached in `cache/translations/` keyed by item id and
  target language; they are immutable and produced at most once.
- Without `DEEPSEEK_API_KEY`, full-text translation is skipped and the
  reading view shows originals only.
- Only fetched public content is ever sent to DeepSeek; user preferences,
  feedback, and reading history never leave the machine.

Pre-summarization deliberately stays in-session with the host agent:
summary quality directly drives ranking and briefing quality, so it is a
core intelligence task, not mechanical work to outsource.

## X Collection

X collection has two replaceable providers. Grok Build remains the default.
The paid X API is disabled unless the user explicitly enables it and sets hard
budgets.

### Grok Build

`fetch-x.ts` shells out to the **Grok Build CLI** (xAI's agentic
command-line tool), whose Grok backend has native real-time access to X and
can search posts and topics broadly without scraping:

- Input: followed handles and tracked topics from `sources.yaml`.
- The script runs Grok Build in headless print mode (`grok -p`) with a
  search prompt and `--json-schema`. The script also validates returned JSON
  locally and retries malformed output once.
- Each Grok query has a 120-second hard timeout. A login failure opens a
  run-level circuit so remaining sources retain gaps without repeated CLI
  attempts.
- Each handle or exact query has a configuration fingerprint and persistent
  `searched_through` cursor. A later run searches only the uncovered time
  range; an already completed range does not start Grok again. Successful
  sources advance independently and failed sources retry. Handle or exact-query
  changes create a new identity; result limits and schedule changes retain the
  existing checkpoint.
- Search results enter the same pending-record, archive, and checkpoint commit
  flow as every other provider. Crash recovery does not invoke Grok again.
- Post URLs, authors, and timestamps are preserved as evidence links.

Grok Build is also the engine for topic discovery: expanding a tracked topic
into related people, products, and repositories.

Authentication is handled by the CLI itself (`grok login`, a browser
sign-in with a SuperGrok or X Premium+ account; the token is stored
locally). SignalCraft never sees or stores these credentials.

### Optional X API

The X API is intended for narrow, deterministic incremental collection, not
broad topic discovery. Account and exact-query searches keep independent
`since_id` checkpoints. Daily and weekly reports consume their archived posts
without making X requests.

The adapter is fail-closed and enforces all of the following before a billable
request:

- `enabled` is false by default and requires explicit opt-in.
- `/2/usage/tweets` must succeed; unavailable usage data disables the provider
  for that run.
- Worst-case reads for the next request must fit
  `max_post_reads_per_run`, `max_cost_usd_per_run`,
  `max_cost_usd_per_day`, and `max_cost_usd_per_month`.
- Initial backfill is limited to 24 hours, one page per query, and the same
  global run budget. Pagination is disabled by default.
- Queries are scheduled by tier instead of all running every cycle. Overlapping
  account and topic queries should be consolidated or alternated.
- Optional user, media, and other billable expansions are omitted unless a
  feature explicitly needs them and budgets for them.
- Authentication failures, authorization failures, rate limits, unexpected
  usage growth, or a projected budget overflow open a circuit breaker. A
  successful billable response is never retried.

The local budget ledger records source/page request metadata, returned-resource
counts, estimated cost, and X-reported project usage. It durably
reserves the worst-case cost before each request and reconciles after the
response; an interrupted request retains its conservative reservation.
Multi-page collection stores a continuation token without advancing the
covered-through time until the final page is archived.
Budget exhaustion skips remaining queries and is reported as a coverage gap,
not as an absence of news. Console-side spending limits and disabled automatic
recharge are required as a second, independent guard; local controls do not
assume provider deduplication or billing guarantees.

Example conservative defaults:

```yaml
x_api:
  enabled: false
  max_post_reads_per_run: 100
  max_post_reads_per_day: 200
  max_post_reads_per_month: 4000
  max_cost_usd_per_run: 0.50
  max_cost_usd_per_day: 1.00
  max_cost_usd_per_month: 20.00
  max_pages_per_query: 1
  fail_closed: true
```

## Credentials

API keys are read from environment variables only; never stored in config
files or logs:

| Variable | Used by | Required |
|---|---|---|
| `DEEPGRAM_API_KEY` | transcription fallback | Only when native transcripts are missing |
| `DEEPSEEK_API_KEY` | full-text translation | Only for bilingual reading |
| `GITHUB_TOKEN` | `fetch-github.ts` | Optional, raises rate limits |
| `X_BEARER_TOKEN` | optional X API provider | Only after explicit X API opt-in |

Default X collection needs no API key: it relies on the Grok Build CLI's own
local login session. `X_BEARER_TOKEN` does not enable the paid adapter by
itself; configuration opt-in and budgets are also required.

Every connector degrades gracefully: a missing key, missing binary, or
logged-out CLI disables that capability with a clear notice instead of
failing the run.

## Dependencies

- Bun 1.x runs the TypeScript connector scripts directly; HTTP uses the
  built-in `fetch`
- npm packages: `yaml` for config parsing, `fast-xml-parser` for RSS/Atom,
  `linkedom` and `turndown` for safe HTML-to-Markdown conversion
- `yt-dlp` as an external binary for YouTube metadata, subtitles, and audio
  extraction
- Grok Build CLI as an external binary for X collection and topic discovery
- No database; state is JSONL and YAML files

When an external binary is missing, the skill shows the install command,
asks for consent, and installs it on the user's approval. It never installs
software silently, and declining only disables that source category.

## Execution Flow

When the user requests a briefing, the skill:

1. Loads `config.yaml` and `sources.yaml` (first run: conversational setup).
2. Checks the collection ledger. For due sources and proven gaps only, runs
   connector scripts from their source checkpoints, archives new items, then
   commits `seen.jsonl` and checkpoints before model work starts.
3. Pre-summarizes any long items that lack a cached summary (see Context
   Budget).
4. Reads the requested time window from `items/`, recent entries from
   `feedback.jsonl`, and the last 7 days of digest headlines (see Novelty
   Memory), then applies ranking, clustering, and digest prompts. Weekly and
   repeated reports reuse the archive without fetching covered intervals.
   Feedback is consumed immediately: recent feedback events are injected into
   the ranking prompt as soft preferences, so "less like this" takes effect on
   the very next briefing.
5. Writes the briefing to `digests/YYYY-MM-DD.md` and presents it. The
   briefing ends with a short Run Report footer: sources succeeded and
   failed, new item count, and transcription count.
6. Records source health and new feedback, then clears committed staging data.

Background scheduling is out of scope for the MVP; collection checks are
user-triggered. When the skill is invoked without a specific request, it asks
the user what to do (briefing now, catch up, manage sources or topics,
feedback).

## Distribution

- Primary: clone the repository into the host runtime's skills directory
  (for Claude Code, `~/.claude/skills/signalcraft`; Codex CLI and Grok Build
  use their own skills directories); update via `git pull`.
- Claude Code plugin packaging (manifest in-repo) for marketplace install.

## Engineering Conventions

Configured in the repository:

- Biome for lint and format
- GitHub Actions CI: lint, typecheck, unit tests, E2E tests, and the full suite

## Quality Evaluation

Briefing quality must be checkable without relying on any one reviewer's
eyes:

- `fixtures/` holds a small sanitized corpus: a few items of every type,
  including deliberate duplicates across sources, a long transcript, and
  prompt-injection samples.
- A scoring rubric derived from the eight ranking signals in DESIGN.md lives
  next to the corpus.
- A pull request that changes prompts must include before/after briefing
  output on the same corpus. Reviewers may use an agent to score both
  against the rubric; the score assists judgment, it does not gate the PR.

## Open Items

- Default source pack: a curated starter list of high-quality,
  primarily English-language sources.
- Delivery beyond local file and terminal (email, messaging) — later phase.
