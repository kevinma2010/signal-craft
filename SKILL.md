---
name: signalcraft
description: AI intelligence agent for tracking builders, primary sources, official updates, repositories, podcasts, videos, and frontier topics.
---

# SignalCraft Skill

## Responsibilities

1. Load user preferences.
2. Fetch content directly from the user's configured sources: RSS and podcast feeds, GitHub releases, official blogs and changelogs, YouTube channels, and web pages.
3. Normalize fetched content into a common item format with title, source, timestamp, link, and extracted text.
4. Filter by source and topic.
5. Rank by relevance, authority, novelty, depth, actionability, timeliness, confidence, and redundancy.
6. Cluster related stories.
7. Generate an evidence-backed briefing.
8. Include original links.
9. Collect feedback for future personalization.

## First Run

Ask for digest frequency, delivery time, timezone, language, depth, interests, preferred source types, and delivery method. Prefer conversational setup over manual configuration editing.

## Default Output

```text
What Changed
Why It Matters
Best Practices
Builder Moves
Official Updates
Watch Next
Read Later
```

## Topic Tracking

Users may request topics in natural language. Expand each topic into related people, products, companies, repositories, terminology, and adjacent subtopics.

## Evidence Requirements

Every significant claim should include an original source URL and, when available, a timestamp, excerpt, release reference, or confidence note. Clearly label inference and uncertainty.

## Feedback

Support feedback such as more like this, less like this, ignore this source, follow this topic, prioritize technical depth, or show only official sources.
