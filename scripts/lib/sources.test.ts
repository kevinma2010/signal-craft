import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMergedSources, mergeSources } from "./sources";
import type { SourcePack } from "./types";

const pack: SourcePack = {
  version: 1,
  sources: [
    {
      id: "blog",
      name: "Blog",
      type: "rss",
      category: "official",
      weight: 1,
      url: "https://example.com",
    },
    {
      id: "repo",
      name: "Repo",
      type: "github",
      category: "release",
      weight: 1,
      url: "https://github.com/a/b",
    },
  ],
};

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("mergeSources", () => {
  test("applies additions, disables, and weight overrides", () => {
    expect(
      mergeSources(pack, {
        version: 1,
        added: [
          {
            id: "person",
            name: "Person",
            type: "x",
            category: "builder",
            weight: 1,
            handle: "person",
          },
        ],
        disabled: ["repo"],
        weights: { blog: 1.5 },
      }),
    ).toEqual([
      {
        id: "blog",
        name: "Blog",
        type: "rss",
        category: "official",
        weight: 1.5,
        url: "https://example.com",
      },
      {
        id: "person",
        name: "Person",
        type: "x",
        category: "builder",
        weight: 1,
        handle: "person",
      },
    ]);
  });

  test("rejects added ids that shadow defaults", () => {
    expect(() =>
      mergeSources(pack, {
        version: 1,
        added: [
          {
            id: "blog",
            name: "Other",
            type: "rss",
            category: "blog",
            weight: 1,
            url: "https://other.test",
          },
        ],
      }),
    ).toThrow("conflicts");
  });
});

describe("loadMergedSources", () => {
  test("loads YAML files and applies the user overlay", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-sources-"));
    const defaultPath = join(directory, "sources.default.yaml");
    const overlayPath = join(directory, "sources.yaml");
    await writeFile(
      defaultPath,
      `version: 1
sources:
  - id: blog
    name: Blog
    type: rss
    category: official
    weight: 1
    url: https://example.com/feed.xml
  - id: repo
    name: Repo
    type: github
    category: release
    weight: 1
    url: https://github.com/example/repo
`,
    );
    await writeFile(
      overlayPath,
      `version: 1
disabled: [repo]
weights:
  blog: 2
added:
  - id: builder
    name: Builder
    type: x
    category: builder
    weight: 1.25
    handle: builder
`,
    );

    expect(await loadMergedSources(defaultPath, overlayPath)).toEqual([
      {
        id: "blog",
        name: "Blog",
        type: "rss",
        category: "official",
        weight: 2,
        url: "https://example.com/feed.xml",
      },
      {
        id: "builder",
        name: "Builder",
        type: "x",
        category: "builder",
        weight: 1.25,
        handle: "builder",
      },
    ]);
  });

  test("uses an empty overlay when the user file is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-sources-"));
    const defaultPath = join(directory, "sources.default.yaml");
    await writeFile(
      defaultPath,
      `version: 1
sources:
  - id: blog
    name: Blog
    type: rss
    category: official
    weight: 1
    url: https://example.com/feed.xml
`,
    );

    expect(
      await loadMergedSources(defaultPath, join(directory, "missing.yaml")),
    ).toEqual([
      {
        id: "blog",
        name: "Blog",
        type: "rss",
        category: "official",
        weight: 1,
        url: "https://example.com/feed.xml",
      },
    ]);
  });

  test("loads topic queries and ranking metadata", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-sources-"));
    const defaultPath = join(directory, "sources.default.yaml");
    await writeFile(
      defaultPath,
      `version: 1
sources:
  - id: topic-coding-agents
    name: Coding agents
    type: x
    category: topic
    weight: 1.2
    query: '("Claude Code" OR Codex) -is:retweet lang:en'
    tags: [ai-coding, agent]
    usage: both
    tier: 1
    max_results: 20
`,
    );

    expect(
      await loadMergedSources(defaultPath, join(directory, "missing.yaml")),
    ).toEqual([
      {
        id: "topic-coding-agents",
        name: "Coding agents",
        type: "x",
        category: "topic",
        weight: 1.2,
        query: '("Claude Code" OR Codex) -is:retweet lang:en',
        tags: ["ai-coding", "agent"],
        usage: "both",
        tier: 1,
        maxResults: 20,
      },
    ]);
  });

  test("rejects invalid sources from a YAML overlay", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-sources-"));
    const defaultPath = join(directory, "sources.default.yaml");
    const overlayPath = join(directory, "sources.yaml");
    await writeFile(defaultPath, "version: 1\nsources: []\n");
    await writeFile(
      overlayPath,
      `version: 1
added:
  - id: invalid
    name: Invalid
    type: unsupported
    category: official
    weight: 1
    url: https://example.com
`,
    );

    await expect(loadMergedSources(defaultPath, overlayPath)).rejects.toThrow(
      "Unsupported source type: unsupported",
    );
  });
});

describe("default source pack", () => {
  test("loads the approved active sources and exact topic queries", async () => {
    const defaultPath = new URL("../../sources.default.yaml", import.meta.url)
      .pathname;
    const sources = await loadMergedSources(
      defaultPath,
      join(tmpdir(), "signalcraft-no-default-overlay.yaml"),
    );

    expect(sources).toHaveLength(93);
    expect(
      sources.reduce<Record<string, number>>((counts, source) => {
        counts[source.type] = (counts[source.type] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ rss: 31, github: 4, youtube: 3, x: 55 });
    expect(sources.filter((source) => source.query)).toHaveLength(18);
    expect(sources.some((source) => source.handle === "ClaudeDevs")).toBe(true);
    expect(sources.some((source) => source.handle === "AnthropicAI")).toBe(
      false,
    );
    expect(sources.some((source) => source.handle === "GoogleDeepMind")).toBe(
      false,
    );
  });
});
