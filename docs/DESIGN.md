# SignalCraft Design

This document describes the public product philosophy, architecture, source policy, and ranking model. The concrete MVP technical design lives in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## 1. Philosophy

The volume of AI information is increasing faster than any individual can process it.

The main cost is attention, verification, prioritization, and context.

SignalCraft exists to reduce that cost.

### Stay Close to the Source

SignalCraft prefers sources close to the actual work:

- Builders
- Researchers
- Maintainers
- Product teams
- Official documentation
- Original interviews
- Primary research
- Release notes

### Follow Work, Not Visibility

A large audience does not automatically indicate useful information.

SignalCraft prioritizes people and teams publishing original work, implementation details, research findings, product changes, and verifiable decisions.

### Find What Changed

Repeated summaries, recycled opinions, and duplicated announcements should be compressed or removed.

### Explain Why It Matters

Each briefing should help the user understand:

- What changed
- Why it matters
- Who it affects
- What evidence supports it
- What to examine or try next

### Preserve Evidence

Important claims should remain traceable to their sources.

### Respect Attention

SignalCraft should optimize for information value per minute.

## 2. Architecture

### Design Goals

- Modular source connectors
- Replaceable transcription providers
- Traceable evidence
- Local-first preferences
- Clear separation between ingestion and personalization
- Minimal user setup
- Extensible ranking
- Safe handling of untrusted content

### High-level Components

```text
Source Connectors
├── X / Grok
├── YouTube
├── Podcast RSS
├── Web and Blogs
├── GitHub
├── Documentation
└── Research

Ingestion Pipeline
├── Fetch
├── Normalize
├── Extract entities
├── Extract topics
├── Detect language
├── Deduplicate
├── Cluster
└── Store

Intelligence Pipeline
├── Score authority
├── Score relevance
├── Score novelty
├── Score depth
├── Score actionability
├── Generate insights
└── Attach evidence

Delivery Layer
├── Skill
├── CLI
├── Chat
├── Email
└── Messaging integrations
```

### Local-first Execution

SignalCraft is local-first. The skill fetches sources directly, normalizes content, deduplicates, ranks, and generates the briefing on the user's machine. There is no central service, and nothing about the user's interests or reading behavior leaves the local environment.

The local skill owns source fetching, user interests, personal filtering, read history, output language, delivery preferences, prompt customization, and feedback history.

A shared ingestion service may be introduced in a later phase to handle expensive transcription, cross-user deduplication, and baseline ranking. The connector boundary below is designed so that swapping local fetching for a shared feed does not affect ranking or digest generation.

### Connector Boundary

Every connector should return normalized content so providers can be replaced without changing ranking or digest generation.

Collection and briefing generation have independent schedules. Connectors
incrementally ingest each source into the permanent local archive once; daily,
weekly, and ad-hoc briefings are views over that archive and never trigger a
second fetch for an already covered range. A briefing may request a targeted
gap repair only when the collection ledger proves that a source interval is
missing.

This rule applies to every provider, including RSS, GitHub, YouTube, podcasts,
Grok Build, and the optional paid X API. Provider-side cursors avoid requesting
known data where supported, while the local item ledger remains the final
idempotency boundary.

### Security Boundary

All fetched content is untrusted and should be isolated from operational instructions.

## 3. Source Policy

SignalCraft curates sources based on authority, originality, usefulness, and consistency.

### Preferred Sources

- Official product and company sources
- Product changelogs
- Technical documentation
- GitHub releases and maintainer discussions
- Original research
- Builders sharing direct experience
- Long-form interviews
- High-quality technical podcasts
- First-hand product demonstrations

### Evaluation Criteria

Sources may be evaluated on:

- Proximity to the work
- Originality
- Technical depth
- Historical accuracy
- Evidence quality
- Frequency of meaningful updates
- Relevance to tracked topics
- Noise level
- Promotional bias

### Exclusions

SignalCraft should reduce or exclude:

- Repeated summaries
- Engagement bait
- Unverified rumors
- Low-information promotional posts
- Automated content farms
- Sources with persistent factual errors
- Content that cannot be attributed
- Scraped reposts without original links

### Dynamic Discovery

Topic discovery may introduce temporary sources. These should become persistent only after repeated evidence of quality.

## 4. Ranking

SignalCraft ranks content to identify information that is useful, original, timely, and relevant.

### Ranking Signals

- **Relevance:** Match with user topics, sources, entities, and preferences
- **Authority:** Proximity to the underlying work or event
- **Novelty:** New information compared with previously processed content
- **Depth:** Presence of evidence, implementation details, data, or examples
- **Actionability:** Ability to inform a practical decision or experiment
- **Timeliness:** Recency and current importance
- **Confidence:** Strength of supporting evidence
- **Redundancy:** Overlap with other items or previous briefings

### Story Clustering

Multiple items about the same event should be grouped into a Story Cluster that:

- Identifies the strongest primary source
- Preserves useful supporting perspectives
- Removes repetitive summaries
- Highlights material disagreements
- Retains the sequence of meaningful updates

### Personalization

Ranking should adapt to user preferences such as:

- Prioritize implementation details
- Reduce fundraising coverage
- Prefer official sources
- Prefer open-source projects
- Ignore selected sources

Exact scoring methods may evolve over time.
