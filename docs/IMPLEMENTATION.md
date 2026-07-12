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
├── state.json         # last successful run timestamp per source category
├── signalcraft.lock   # transient run lock (pid + started_at)
├── seen.jsonl         # processed item fingerprints (id, normalized url, first_seen)
├── feedback.jsonl     # user feedback events
├── inbox/             # per-run staging written by connector scripts
│   └── <category>.jsonl
├── items/             # permanent archive of all processed items
│   └── YYYY-MM.jsonl
├── cache/
│   ├── transcripts/   # transcripts and pre-summaries, keyed by item id
│   └── translations/  # full-text translations, keyed by item id + language
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

### Data Lifecycle

All content data persists locally — it feeds the future local reading view
and the Phase 3 searchable archive. Retention is per type:

- `inbox/` — per-run staging only. After a successful run, processed items
  are appended to the `items/` archive; the staging area is cleared at the
  start of the next run.
- `items/` — permanent. Monthly JSONL files holding every processed item in
  full (original text included).
- `seen.jsonl` — pruned: fingerprints older than 90 days are dropped (the
  fetch lookback cap is 30 days, so older fingerprints can never match).
- `cache/` (transcripts, pre-summaries, translations) — permanent. These
  cost money or tokens to produce and are immutable; never regenerate them.
- `digests/` — permanent.

### State Versioning

Every state and config file carries a `version` field. When a newer skill
loads an older file, it migrates the file in place after writing a backup
next to it. Migration logic lives in `scripts/lib/` and is covered by tests.

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
| `fetch-x.ts` | X posts and topic discovery | Grok API live search over X content and topics |

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

`--since` is the category's last successful run from `state.json`, so a
briefing always covers the gap since the previous one — no items are lost
when the user skips days. Lookback is capped at 30 days. A connector's
timestamp advances only when it succeeds, so a failed category re-covers
its own gap on the next run. First run defaults to the digest frequency
window (1 day for daily, 7 for weekly).

### Content Sanitization

Fetched content is untrusted (see DESIGN.md's security boundary). The
defense is layered:

- **Connectors emit Markdown only.** All fetched HTML is converted to
  Markdown at the script layer; scripts, styles, forms, embeds, and tracking
  pixels are stripped in the conversion. The `text` field never contains raw
  HTML.
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
- **Claude: semantic, in context.** Cross-source story clustering — multiple
  items covering the same event — is judged by Claude during briefing
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

## X Collection via Grok Build

`fetch-x.ts` shells out to the **Grok Build CLI** (xAI's agentic
command-line tool), whose Grok backend has native real-time access to X and
can search posts and topics broadly without scraping:

- Input: followed handles and tracked topics from `sources.yaml`.
- The script runs Grok Build in headless print mode (`grok -p`) with a
  search prompt and `--json-schema` so the results come back as validated
  JSON matching our normalized item schema.
- Post URLs, authors, and timestamps are preserved as evidence links.

Grok Build is also the engine for topic discovery: expanding a tracked topic
into related people, products, and repositories.

Authentication is handled by the CLI itself (`grok-build login`, a browser
sign-in with a SuperGrok or X Premium+ account; the token is stored
locally). SignalCraft never sees or stores these credentials.

## Credentials

API keys are read from environment variables only; never stored in config
files or logs:

| Variable | Used by | Required |
|---|---|---|
| `DEEPGRAM_API_KEY` | transcription fallback | Only when native transcripts are missing |
| `GITHUB_TOKEN` | `fetch-github.ts` | Optional, raises rate limits |

X collection needs no API key: it relies on the Grok Build CLI's own local
login session (see above).

Every connector degrades gracefully: a missing key, missing binary, or
logged-out CLI disables that capability with a clear notice instead of
failing the run.

## Dependencies

- Bun 1.x runs the TypeScript connector scripts directly; HTTP uses the
  built-in `fetch`
- npm packages: `yaml` for config parsing, `fast-xml-parser` for RSS/Atom
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
2. Runs the connector scripts for the user's enabled categories, passing
   each category's `--since` from `state.json`.
3. Pre-summarizes any long items that lack a cached summary (see Context
   Budget).
4. Reads `inbox/*.jsonl`, recent entries from `feedback.jsonl`, and the last
   7 days of digest headlines (see Novelty Memory), then applies ranking,
   clustering, and digest prompts. Feedback is consumed immediately: recent
   feedback events are injected into the ranking prompt as soft preferences,
   so "less like this" takes effect on the very next briefing.
5. Writes the briefing to `digests/YYYY-MM-DD.md` and presents it. The
   briefing ends with a short Run Report footer: sources succeeded and
   failed, new item count, and transcription count.
6. Archives processed items into `items/`, appends their ids to
   `seen.jsonl`, advances `state.json`, and records any new feedback.

Scheduling is out of scope for the MVP; runs are user-triggered. When the
skill is invoked without a specific request, it asks the user what to do
(briefing now, catch up, manage sources or topics, feedback).

## Distribution

- Primary: clone the repository into the host runtime's skills directory
  (for Claude Code, `~/.claude/skills/signalcraft`; Codex CLI and Grok Build
  use their own skills directories); update via `git pull`.
- Claude Code plugin packaging (manifest in-repo) for marketplace install.

## Engineering Conventions

Configured when the first script lands, in the same change:

- Biome for lint and format
- GitHub Actions CI: typecheck and `bun test`

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
