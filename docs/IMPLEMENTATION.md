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

One script per source category, under `scripts/`:

| Script | Category | Method |
|---|---|---|
| `fetch_rss.py` | Blogs, changelogs, podcasts | RSS/Atom via feed parsing |
| `fetch_github.py` | Releases, maintainer discussions | GitHub public REST API |
| `fetch_youtube.py` | Channels and videos | Channel RSS for discovery; yt-dlp for metadata and subtitles |
| `fetch_x.py` | X posts and topic discovery | Grok API live search over X content and topics |

Shared helpers live in `scripts/lib/` (normalization, seen-set handling,
config loading).

### Script Contract

Every connector follows the same contract:

```text
fetch_<category>.py --config ~/.signalcraft/sources.yaml \
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
budget (max episodes per run) and an opt-out.

## X Collection via Grok

`fetch_x.py` uses the Grok API's live search capability, which can search X
posts and topics broadly without scraping:

- Input: followed handles and tracked topics from `sources.yaml`.
- The script asks Grok for recent relevant posts as structured JSON with
  post URLs, authors, timestamps, and text.
- Output goes through the same normalized schema; post URLs are preserved as
  evidence links.

Grok is also the engine for topic discovery: expanding a tracked topic into
related people, products, and repositories.

## Credentials

Read from environment variables only; never stored in config files or logs:

| Variable | Used by | Required |
|---|---|---|
| `XAI_API_KEY` | `fetch_x.py` | Only for X collection |
| `DEEPGRAM_API_KEY` | transcription fallback | Only when native transcripts are missing |
| `GITHUB_TOKEN` | `fetch_github.py` | Optional, raises rate limits |

Every connector degrades gracefully: a missing key disables that capability
with a clear notice instead of failing the run.

## Dependencies

- Python 3.11+ for connector scripts
- `feedparser`, `requests`, `pyyaml`
- `yt-dlp` for YouTube metadata, subtitles, and audio extraction
- No database; state is JSONL and YAML files

## Execution Flow

When the user requests a briefing, the skill:

1. Loads `config.yaml` and `sources.yaml` (first run: conversational setup).
2. Runs the connector scripts for the user's enabled categories.
3. Reads `inbox/*.jsonl`, applies ranking, clustering, and digest prompts.
4. Writes the briefing to `digests/YYYY-MM-DD.md` and presents it.
5. Appends processed ids to `seen.jsonl` and records any feedback.

Scheduling is out of scope for the MVP; runs are user-triggered.

## Open Items

- Default source pack: a curated starter list of high-quality sources.
- Story-cluster fingerprinting details (semantic dedup across sources).
- Delivery beyond local file and terminal (email, messaging) — later phase.
