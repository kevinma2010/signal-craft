# SignalCraft MVP Implementation Design

This document describes the technical design of the Phase 1 open-source MVP.
Product philosophy, source policy, and ranking are covered in [DESIGN.md](DESIGN.md).

## Overview

The MVP has two layers:

1. **Connector scripts** — one script per source category. Each script fetches
   content, normalizes it into a common item format, and writes JSONL to the
   local inbox. Scripts are deterministic and independently testable.
2. **Intelligence layer** — Claude, driven by the skill and the prompts in
   [PROMPTS.md](../PROMPTS.md), reads the normalized items and performs
   filtering, ranking, story clustering, and briefing generation.

Everything runs on the user's machine. There is no central service.

## Runtime Layout

```text
~/.signalcraft/
├── config.yaml        # preferences: frequency, language, depth, interests, delivery
├── sources.yaml       # subscribed sources: type, URL/handle, weight
├── seen.jsonl         # processed item fingerprints (id, url, first_seen)
├── feedback.jsonl     # user feedback events
├── inbox/             # normalized items written by connector scripts
│   └── <category>.jsonl
├── cache/
│   └── transcripts/   # cached transcripts keyed by item id
└── digests/           # generated briefings, YYYY-MM-DD.md
```

User data lives outside the skill directory so skill updates never touch it.

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
2. Runs the connector scripts for the user's enabled categories.
3. Reads `inbox/*.jsonl`, applies ranking, clustering, and digest prompts.
4. Writes the briefing to `digests/YYYY-MM-DD.md` and presents it.
5. Appends processed ids to `seen.jsonl` and records any feedback.

Scheduling is out of scope for the MVP; runs are user-triggered.

## Open Items

- Default source pack: a curated starter list of high-quality,
  primarily English-language sources.
- Story-cluster fingerprinting details (semantic dedup across sources).
- Delivery beyond local file and terminal (email, messaging) — later phase.
