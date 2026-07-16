import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveProcessedItems,
  readArchivedItems,
} from "../../scripts/lib/archive";
import { collectAndCommitSource } from "../../scripts/lib/collection";
import { writeTextAtomic } from "../../scripts/lib/files";
import { fetchGitHubSources } from "../../scripts/lib/github";
import { readJsonLines } from "../../scripts/lib/jsonl";
import { acquireRunLock, LockHeldError } from "../../scripts/lib/lock";
import { fetchRssSources } from "../../scripts/lib/rss";
import { loadSeenRecords } from "../../scripts/lib/seen";
import { loadMergedSources } from "../../scripts/lib/sources";
import {
  createState,
  loadState,
  recordCategorySuccess,
  recordSourceSuccess,
  saveState,
} from "../../scripts/lib/state";
import {
  getTranslationCachePath,
  translateMarkdown,
} from "../../scripts/lib/translation";
import type { NormalizedItem, SourceDefinition } from "../../scripts/lib/types";
import { fetchXSources } from "../../scripts/lib/x";
import { fetchYouTubeSources } from "../../scripts/lib/youtube";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("SignalCraft pipeline", () => {
  test("fetches all categories, commits state, and deduplicates the next run", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-e2e-"));
    const now = new Date("2026-01-17T00:00:00.000Z");
    const since = new Date("2026-01-01T00:00:00.000Z");
    const defaultPackPath = join(directory, "sources.default.yaml");
    const overlayPath = join(directory, "sources.yaml");
    await writeFile(defaultPackPath, defaultSourcesYaml());
    await writeFile(overlayPath, "version: 1\n");
    const sources = await loadMergedSources(defaultPackPath, overlayPath);
    const inbox = {
      rss: join(directory, "inbox", "rss.jsonl"),
      github: join(directory, "inbox", "github.jsonl"),
      youtube: join(directory, "inbox", "youtube.jsonl"),
      x: join(directory, "inbox", "x.jsonl"),
    };
    const seenPath = join(directory, "seen.jsonl");
    const lock = await acquireRunLock(join(directory, "signalcraft.lock"), {
      now,
    });
    await expect(
      acquireRunLock(join(directory, "signalcraft.lock"), { now }),
    ).rejects.toBeInstanceOf(LockHeldError);

    const fetchers = createAdapters();
    const results = await Promise.all([
      fetchRssSources({
        sources,
        since,
        outPath: inbox.rss,
        seenPath,
        now,
        fetcher: fetchers.rss,
      }),
      fetchGitHubSources({
        sources,
        since,
        outPath: inbox.github,
        seenPath,
        now,
        fetcher: fetchers.github,
      }),
      fetchYouTubeSources({
        sources,
        since,
        outPath: inbox.youtube,
        seenPath,
        cacheDirectory: join(directory, "cache", "transcripts"),
        now,
        fetcher: fetchers.youtube,
        runner: fetchers.ytDlp,
      }),
      fetchXSources({
        sources,
        since,
        outPath: inbox.x,
        seenPath,
        now,
        runner: fetchers.grok,
      }),
    ]);
    const items = results.flatMap((result) => result.items);
    expect(items).toHaveLength(5);
    expect(new Set(items.map((item) => item.type))).toEqual(
      new Set(["article", "release", "post", "video"]),
    );

    const selected = items[0];
    if (!selected) throw new Error("Expected a selected item");
    const translationDirectory = join(directory, "cache", "translations");
    const translationPath = getTranslationCachePath(
      translationDirectory,
      selected.id,
      "zh-CN",
    );
    await writeTextAtomic(translationPath, "# Cached translation");
    expect(
      await translateMarkdown({
        itemId: selected.id,
        targetLanguage: "zh-CN",
        markdown: selected.text,
        cacheDirectory: translationDirectory,
      }),
    ).toMatchObject({ status: "cached", markdown: "# Cached translation" });

    expect(await archiveProcessedItems(directory, items, now)).toBe(5);
    const state = createState();
    for (const category of ["rss", "github", "youtube", "x"]) {
      recordCategorySuccess(state, category, now);
    }
    for (const source of sources) recordSourceSuccess(state, source.id);
    await saveState(join(directory, "state.json"), state);
    expect(
      Object.keys((await loadState(join(directory, "state.json"))).categories),
    ).toHaveLength(4);
    expect((await loadSeenRecords(seenPath, now)).size).toBe(5);
    expect(
      await readJsonLines<NormalizedItem>(
        join(directory, "items", "2026-01.jsonl"),
      ),
    ).toHaveLength(5);

    await Promise.all(Object.values(inbox).map((path) => writeFile(path, "")));
    const secondRun = await Promise.all([
      fetchRssSources({
        sources,
        since,
        outPath: inbox.rss,
        seenPath,
        now,
        fetcher: fetchers.rss,
      }),
      fetchGitHubSources({
        sources,
        since,
        outPath: inbox.github,
        seenPath,
        now,
        fetcher: fetchers.github,
      }),
      fetchYouTubeSources({
        sources,
        since,
        outPath: inbox.youtube,
        seenPath,
        cacheDirectory: join(directory, "cache", "transcripts"),
        now,
        fetcher: fetchers.youtube,
        runner: fetchers.ytDlp,
      }),
      fetchXSources({
        sources,
        since,
        outPath: inbox.x,
        seenPath,
        now,
        runner: fetchers.grok,
      }),
    ]);
    expect(secondRun.flatMap((result) => result.items)).toHaveLength(0);
    await lock.release();
    expect(await readFile(join(directory, "state.json"), "utf8")).toContain(
      '"version": 2',
    );
  });

  test("commits successful categories when another category fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-e2e-failure-"));
    const now = new Date("2026-01-17T00:00:00.000Z");
    const since = new Date("2026-01-01T00:00:00.000Z");
    const sources: SourceDefinition[] = [
      {
        id: "broken-blog",
        name: "Broken Blog",
        type: "rss",
        category: "official",
        weight: 1,
        url: "https://feeds.example/broken.xml",
      },
      {
        id: "repo",
        name: "Repo",
        type: "github",
        category: "release",
        weight: 1,
        url: "https://github.com/example/repo",
      },
    ];
    const seenPath = join(directory, "seen.jsonl");
    const settled = await Promise.allSettled([
      fetchRssSources({
        sources,
        since,
        outPath: join(directory, "inbox", "rss.jsonl"),
        seenPath,
        now,
        fetcher: async () => new Response(null, { status: 503 }),
      }),
      fetchGitHubSources({
        sources,
        since,
        outPath: join(directory, "inbox", "github.jsonl"),
        seenPath,
        now,
        fetcher: async (input) =>
          Response.json(
            String(input).includes("/releases?") ? [githubRelease()] : [],
          ),
      }),
    ]);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("fulfilled");
    const githubResult = settled[1];
    if (githubResult?.status !== "fulfilled")
      throw new Error("Expected GitHub success");
    await archiveProcessedItems(directory, githubResult.value.items, now);
    const state = createState();
    recordCategorySuccess(state, "github", now);
    recordSourceSuccess(state, "repo");
    await saveState(join(directory, "state.json"), state);

    const saved = await loadState(join(directory, "state.json"));
    expect(saved.categories.github?.last_success_at).toBe(now.toISOString());
    expect(saved.categories.rss).toBeUndefined();
    expect((await loadSeenRecords(seenPath, now)).size).toBe(1);
  });

  test("reuses one collection for daily and weekly report windows", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-e2e-reuse-"));
    const now = new Date("2026-01-17T00:00:00Z");
    const source: SourceDefinition = {
      id: "blog",
      name: "Blog",
      type: "rss",
      category: "official",
      weight: 1,
      url: "https://feeds.example/blog.xml",
    };
    let connectorCalls = 0;
    const collect = () =>
      collectAndCommitSource({
        dataDirectory: directory as string,
        provider: "rss",
        source,
        initialSince: new Date("2026-01-10T00:00:00Z"),
        through: now,
        collect: async () => {
          connectorCalls += 1;
          return {
            items: [
              {
                id: "weekly-item",
                type: "article",
                source: "Blog",
                author: "Author",
                title: "Weekly Item",
                url: "https://blog.example/weekly-item",
                published_at: "2026-01-16T12:00:00Z",
                fetched_at: now.toISOString(),
                text: "Evidence",
                transcript_provider: "none",
                extra: {},
              },
            ],
          };
        },
      });

    expect((await collect()).status).toBe("collected");
    const daily = await readArchivedItems(directory, {
      from: new Date("2026-01-16T00:00:00Z"),
      to: now,
    });
    const weekly = await readArchivedItems(directory, {
      from: new Date("2026-01-10T00:00:00Z"),
      to: now,
    });
    expect((await collect()).status).toBe("already-covered");
    expect(daily).toHaveLength(1);
    expect(weekly).toEqual(daily);
    expect(connectorCalls).toBe(1);
  });
});

function createAdapters() {
  const rss = async () => new Response(rssXml());
  const github = async (input: string | URL | Request) =>
    Response.json(
      String(input).includes("/releases?")
        ? [githubRelease()]
        : [githubDiscussion()],
    );
  const youtube = async (input: string | URL | Request) =>
    new Response(
      String(input).includes("subtitles")
        ? "WEBVTT\n\n00:00 --> 00:01\nNative transcript"
        : youtubeXml(),
    );
  const ytDlp = async () => ({
    exitCode: 0,
    stdout: new TextEncoder().encode(
      JSON.stringify({
        subtitles: {
          en: [{ url: "https://media.example/subtitles.vtt", ext: "vtt" }],
        },
      }),
    ),
    stderr: "",
  });
  const grok = async () => ({ exitCode: 0, stdout: xOutput(), stderr: "" });
  return { rss, github, youtube, ytDlp, grok };
}

function defaultSourcesYaml(): string {
  return `version: 1
sources:
  - { id: blog, name: Blog, type: rss, category: official, weight: 1, url: https://feeds.example/blog.xml }
  - { id: repo, name: Repo, type: github, category: release, weight: 1, url: https://github.com/example/repo }
  - { id: channel, name: Channel, type: youtube, category: official, weight: 1, url: https://www.youtube.com/channel/UC123 }
  - { id: account, name: Account, type: x, category: builder, weight: 1, handle: example }
`;
}

function rssXml(): string {
  return `<rss><channel><item><title>Article</title><link>https://blog.example/article</link><pubDate>2026-01-10T00:00:00Z</pubDate><description><![CDATA[<p>Evidence</p>]]></description></item></channel></rss>`;
}

function githubRelease() {
  return {
    html_url: "https://github.com/example/repo/releases/tag/v1",
    tag_name: "v1",
    name: "Version 1",
    body: "Release notes",
    published_at: "2026-01-11T00:00:00Z",
    prerelease: false,
    author: { login: "maintainer" },
  };
}

function githubDiscussion() {
  return {
    type: "DiscussionEvent",
    created_at: "2026-01-12T00:00:00Z",
    payload: {
      action: "created",
      discussion: {
        html_url: "https://github.com/example/repo/discussions/1",
        title: "Roadmap",
        body: "Maintainer details",
        created_at: "2026-01-12T00:00:00Z",
        author_association: "MEMBER",
        user: { login: "maintainer" },
        category: { name: "Announcements" },
      },
    },
  };
}

function youtubeXml(): string {
  return `<feed><entry><yt:videoId>video1</yt:videoId><title>Video</title><published>2026-01-13T00:00:00Z</published><author><name>Creator</name></author><link rel="alternate" href="https://www.youtube.com/watch?v=video1"/><media:group><media:description>Notes</media:description></media:group></entry></feed>`;
}

function xOutput(): string {
  return JSON.stringify({
    items: [
      {
        id: "ignored",
        type: "post",
        source: "Account",
        author: "@example",
        title: "Post",
        url: "https://x.com/example/status/1",
        published_at: "2026-01-14T00:00:00Z",
        fetched_at: "2026-01-17T00:00:00Z",
        text: "Primary evidence",
        transcript_provider: "none",
        extra: { content_status: "complete" },
      },
    ],
  });
}
