# SignalCraft

> Craft better decisions from better signals.

SignalCraft is an open-source AI intelligence agent for tracking builders, primary sources, official updates, repositories, podcasts, and frontier topics.

It collects high-signal information from multiple sources, reduces repetition, preserves evidence, and turns the result into concise daily or weekly briefings.

## Why SignalCraft

Important AI developments are scattered across:

- Builder and researcher posts
- Official blogs and changelogs
- GitHub releases and maintainer discussions
- YouTube videos and podcasts
- Product documentation
- Research publications
- Emerging topic conversations

SignalCraft helps users answer three questions:

1. What changed?
2. Why does it matter?
3. What should I examine or try next?

## Project Principles

- Stay close to primary sources.
- Follow people doing the work.
- Prefer original insight over repeated commentary.
- Merge duplicated stories.
- Preserve links and supporting evidence.
- Optimize for usefulness.
- Respect the user's attention.

See [docs/DESIGN.md](docs/DESIGN.md).

## Current Status

SignalCraft is in the early open-source MVP stage.

The initial scope includes:

- Curated AI builder updates
- Official product and company updates
- GitHub releases
- YouTube and podcast summaries
- Grok-driven X and topic discovery
- Daily and weekly digests
- Original source links
- Local preferences

See [ROADMAP.md](ROADMAP.md).

## Installation

SignalCraft is a single agent skill backed by Bun connector scripts. User data
is stored outside the checkout in `~/.signalcraft/`.

### Clone as a Claude Code skill

Clone the repository into the personal skills directory for automatic loading:

```bash
git clone https://github.com/kevinma2010/signal-craft.git ~/.claude/skills/signalcraft
cd ~/.claude/skills/signalcraft
bun install
```

Restart Claude Code after installation. The checkout appears as a
skills-directory plugin and does not require a marketplace.

### Load as a Claude Code plugin

For a local checkout, install dependencies and load the plugin directly:

```bash
git clone https://github.com/kevinma2010/signal-craft.git
cd signal-craft
bun install
claude --plugin-dir "$PWD"
```

The local plugin manifest lives at `.claude-plugin/plugin.json`. Run
`/reload-plugins` after changing the skill or manifest. Marketplace installs use
`claude plugin install signal-craft@<marketplace>` after a marketplace publishes
this repository; `claude --plugin-dir` is the supported installation path for
the current standalone repository.

## Runtime Setup

Required:

```bash
curl -fsSL https://bun.sh/install | bash
bun install
```

Install `yt-dlp` for YouTube metadata, native subtitles, and audio fallback:

```bash
brew install yt-dlp
```

Install and authenticate Grok Build for the default X collection path:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Optional credentials are read from environment variables only:

```bash
export GITHUB_TOKEN="..."
export DEEPGRAM_API_KEY="..."
export DEEPSEEK_API_KEY="..."
export X_BEARER_TOKEN="..."
```

- `GITHUB_TOKEN` raises GitHub API rate limits.
- `DEEPGRAM_API_KEY` enables ASR only when native subtitles or transcripts are
  unavailable.
- `DEEPSEEK_API_KEY` enables full-text translation.
- `X_BEARER_TOKEN` is ignored unless the paid X API adapter is also explicitly
  enabled in configuration.

Missing optional credentials or binaries degrade only the affected connector.

## Configuration

SignalCraft creates `~/.signalcraft/config.yaml` and
`~/.signalcraft/sources.yaml` during first-run setup. The source file is an
overlay on `sources.default.yaml`; use source IDs from that default pack when
selecting paid X API sources.

The X API is disabled by default. Enabling it requires explicit source IDs and
fail-closed hard budgets:

```yaml
version: 1
x_api:
  enabled: true
  source_ids:
    - openai-developers-x
    - claude-developers-x
  max_post_reads_per_run: 100
  max_post_reads_per_day: 200
  max_post_reads_per_month: 4000
  max_cost_usd_per_run: 0.50
  max_cost_usd_per_day: 1.00
  max_cost_usd_per_month: 20.00
  max_pages_per_query: 1
  cost_per_post_read_usd: 0.005
  fail_closed: true
```

Keep `source_ids` narrow. SignalCraft checks remote usage before paid requests,
does not paginate beyond the configured limit, and stops when any local budget
would be exceeded. Configure a low spending limit and disable automatic recharge
in the X Developer Console as an independent billing guard. Daily and weekly
reports reuse archived items; report generation does not fetch the same interval
again.

Connector smoke commands use the same contract:

```bash
mkdir -p ~/.signalcraft/inbox
bun scripts/fetch-rss.ts \
  --config ~/.signalcraft/sources.yaml \
  --since 2026-07-15T00:00:00Z \
  --out ~/.signalcraft/inbox/rss.jsonl
```

Replace `fetch-rss.ts` and the output filename with `fetch-github.ts`,
`fetch-youtube.ts`, or `fetch-x.ts` for the other connectors.

## Testing

Install dependencies, then run the quality gates from the repository root:

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run test:e2e
bun test
```

Tests use mocks and do not require real API credentials, a Grok login, or
`yt-dlp`. Real provider checks are manual smoke tests and may consume paid API
quota.

## Planned Workflow

```text
Sources
├── X and topic discovery
├── YouTube and podcasts
├── Official blogs and changelogs
├── GitHub
└── Research and documentation
        ↓
Normalize and extract
        ↓
Deduplicate and cluster
        ↓
Rank useful signals
        ↓
Generate an evidence-backed briefing
        ↓
Deliver to the user
```

See [docs/DESIGN.md](docs/DESIGN.md).

## Example Outputs

- [Digest and Topic Brief Examples](EXAMPLES.md)

## Repository Structure

```text
signal-craft/
├── .claude-plugin/
│   └── plugin.json
├── .github/
│   └── workflows/
│       └── ci.yml
├── .gitignore
├── AGENTS.md
├── README.md
├── LICENSE
├── NOTICE
├── package.json
├── bun.lock
├── tsconfig.json
├── biome.json
├── SKILL.md
├── ROADMAP.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── PROJECT_POLICY.md
├── FILE_MANIFEST.md
├── CLAUDE.md
├── PROMPTS.md
├── EXAMPLES.md
├── sources.default.yaml
├── fixtures/
│   ├── README.md
│   ├── SCORING_RUBRIC.md
│   ├── normalized-items.jsonl
│   ├── long-transcript.jsonl
│   └── rss/
│       └── atom.xml
├── scripts/
│   ├── fetch-rss.ts
│   ├── fetch-github.ts
│   ├── fetch-youtube.ts
│   ├── fetch-x.ts
│   ├── fetch-x.test.ts
│   └── lib/
│       ├── archive.ts
│       ├── cli.ts
│       ├── collection.ts
│       ├── config.ts
│       ├── executable.ts
│       ├── file-lock.ts
│       ├── index.ts
│       ├── files.ts
│       ├── github.ts
│       ├── jsonl.ts
│       ├── lock.ts
│       ├── rss.ts
│       ├── run-audit.ts
│       ├── sanitize.ts
│       ├── seen.ts
│       ├── sources.ts
│       ├── state.ts
│       ├── transcription.ts
│       ├── translation.ts
│       ├── types.ts
│       ├── url.ts
│       ├── versioned-file.ts
│       ├── x.ts
│       ├── x-api.ts
│       ├── x-api-ledger.ts
│       ├── x-api-normalize.ts
│       ├── youtube.ts
│       └── *.test.ts
├── tests/
│   └── e2e/
│       ├── pipeline.test.ts
│       └── x-api-pipeline.test.ts
└── docs/
    ├── DESIGN.md
    ├── IMPLEMENTATION.md
    ├── TESTING.md
    └── TASKS.md
```

Community conduct and acknowledgements are covered in [PROJECT_POLICY.md](PROJECT_POLICY.md); [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is a short pointer to that section.

## Contributing

Contributions are welcome, including:

- Source and topic proposals
- Connectors
- Prompt improvements
- Ranking and deduplication work
- Documentation
- Testing
- Real-world examples

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Creator and Maintainer

SignalCraft was created by **Kevin Ma**, founder of **PATHLINK DIGITAL LLC**.

Kevin is the founder and lead maintainer. PATHLINK DIGITAL LLC is the copyright owner and long-term operating entity behind the project.

## Acknowledgements

SignalCraft was partly inspired by the lightweight agent-based digest format of the open-source project **Follow Builders, Not Influencers**.

SignalCraft is independently designed and implemented, with a broader focus on topic discovery, primary-source intelligence, evidence-backed insights, ranking, and progressive product development.

See [PROJECT_POLICY.md](PROJECT_POLICY.md).

## License

Licensed under the Apache License 2.0.

```text
Copyright 2026 PATHLINK DIGITAL LLC
```

The SignalCraft name and visual identity are governed separately. See [PROJECT_POLICY.md](PROJECT_POLICY.md).
