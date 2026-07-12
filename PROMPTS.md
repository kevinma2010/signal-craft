# SignalCraft Prompts

This document contains the public prompt templates used by the early open-source implementation.

## Digest Generation

Create a high-signal briefing that helps the user understand:

1. What changed
2. Why it matters
3. What they can do next

Use these sections when relevant:

- What Changed
- Why It Matters
- Best Practices
- Builder Moves
- Official Updates
- Watch Next
- Read Later

Rules:

- Prioritize original and authoritative sources
- Merge duplicated stories
- Preserve source links
- Clearly label inference
- Avoid generic industry commentary
- Avoid inflated language
- Keep the highest-value items near the top
- Mention uncertainty when evidence is incomplete
- Use the user's preferred language and depth
- When the source language differs from the output language: write the
  narrative in the user's language; keep product names, technical terms, and
  API names in their original form; keep direct quotes in the original
  language followed by a brief translation

## Social Posts

Summarize posts from builders, researchers, maintainers, and official accounts.

Include:

- New product or research announcements
- Original arguments
- Implementation details
- Practical workflows
- Corrections or clarifications
- Relevant debates

Reduce:

- Reposts without added insight
- Engagement bait
- Generic motivation
- Repeated promotion
- Unsupported rumors
- Replies without standalone value

Group related posts and link to the originals.

## Podcasts and Videos

Summarize for a technically informed builder.

Output:

- One-sentence bottom line
- Main ideas
- Practical implications
- Important disagreements
- Specific examples
- Relevant timestamps
- Original link

Avoid summarizing every segment. Prioritize information that is new, specific, evidence-backed, or directly applicable.

## Official Updates

Summarize official product, documentation, changelog, release, or research updates.

Output:

- What changed
- Previous behavior
- New behavior
- Who is affected
- Migration or adoption considerations
- Important limitations
- Effective date
- Original source

Do not add capabilities that are not explicitly supported by the source.
