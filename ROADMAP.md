# SignalCraft Roadmap

This roadmap describes the public product and technical direction of SignalCraft. Priorities may change based on implementation findings and community feedback.

## Phase 1: Codex-first Open Source MVP

**Status:** Technical implementation complete; product validation in progress.

### Goal

Release a useful open-source briefing agent in Codex and validate source quality,
digest quality, and recurring usage with real users.

### Delivered Foundation

- Curated builder sources
- Official blogs and changelogs
- GitHub releases
- YouTube and podcast summaries
- Grok-driven X collection
- Initial topic-based discovery
- Daily and weekly briefings
- Original source links
- Local preferences
- Local Markdown delivery and a local web reader
- Read-only installation and capability diagnostics through `bun run doctor`
- Runtime-portable skill and connector architecture

### Current Validation Scope

- Codex app as the primary supported runtime
- Daily and weekly runs through Codex Scheduled tasks
- Completion visibility and notifications through Codex Scheduled
- First-run success, briefing quality, and repeated weekly usage
- A small design-partner cohort before expanding product scope

### Current Non-goals

- Hosted central ingestion service
- A SignalCraft-owned background scheduler
- Email or messaging delivery
- Full web application
- Mobile application
- Team workspaces
- Enterprise administration
- Large-scale recommendation infrastructure
- Equal product support across multiple agent runtimes

## Phase 2: Product Beta and Personalization

### Goal

Turn the working technical foundation into a low-friction Codex-native product,
then deepen personalization around the people, products, repositories, and topics
each user cares about.

### Planned Scope

- Codex-first installation and onboarding
- Onboarding and recovery flows driven by doctor results
- A tested Scheduled-task recipe for daily and weekly briefings
- Custom people and organizations
- Custom repositories, feeds, podcasts, and channels
- Topic Scout
- Topic expansion
- Personal ranking preferences
- Feedback-driven filtering
- Interactive feedback from the local reader
- Read state, saved items, and stronger novelty detection
- Continued ranking and cross-source clustering quality evaluation

## Phase 3: Searchable Signal Archive

### Goal

Turn recurring briefings into a searchable and evidence-backed knowledge archive.

### Planned Scope

- Signal Inbox
- Topic pages
- Source pages
- Saved items
- Historical search
- Digest archive
- Evidence-backed questions and answers

## Phase 4: Shared Intelligence

### Goal

Support shared monitoring and briefing workflows for small teams.

### Possible Scope

- Shared topics
- Product and ecosystem tracking
- Research briefings
- Team review workflows
- APIs and integrations

## How Priorities Are Chosen

Roadmap decisions consider:

- User value
- Information quality
- Implementation complexity
- Source reliability
- Privacy and security
- Community feedback
- Long-term maintainability
