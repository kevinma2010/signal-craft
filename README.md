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
├── README.md
├── LICENSE
├── NOTICE
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
└── docs/
    ├── DESIGN.md
    ├── IMPLEMENTATION.md
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
