import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonLines } from "./jsonl";
import { fetchRssSources, parseFeed } from "./rss";
import type { NormalizedItem, SourceDefinition } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

const blog: SourceDefinition = {
  id: "example-blog",
  name: "Example Blog",
  type: "rss",
  category: "official",
  weight: 1,
  url: "https://example.com/feed.xml",
};

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title><item>
  <title>New model</title>
  <link>https://example.com/model?utm_source=feed</link>
  <pubDate>Thu, 15 Jan 2026 10:00:00 GMT</pubDate>
  <dc:creator>Builder</dc:creator>
  <description><![CDATA[<p>Details</p><script>ignore()</script><img src="/chart.png" alt="Chart">]]></description>
</item></channel></rss>`;

const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>Episode 1</title>
  <link rel="alternate" href="https://example.com/episode-1" />
  <link rel="enclosure" href="https://cdn.example.com/episode-1.mp3" type="audio/mpeg" />
  <published>2026-01-16T10:00:00Z</published>
  <author><name>Host</name></author>
  <summary type="html">Show notes</summary>
</entry></feed>`;

describe("parseFeed", () => {
  test("normalizes RSS and sanitizes HTML", () => {
    const [item] = parseFeed(rss, blog, new Date("2026-01-17T00:00:00Z"));
    expect(item?.type).toBe("article");
    expect(item?.author).toBe("Builder");
    expect(item?.text).toContain("![Chart](https://example.com/chart.png)");
    expect(item?.text).not.toContain("script");
  });

  test("normalizes Atom podcast enclosures", () => {
    const [item] = parseFeed(atom, { ...blog, category: "podcast" });
    expect(item?.type).toBe("podcast");
    expect(item?.extra).toEqual({
      enclosure: {
        url: "https://cdn.example.com/episode-1.mp3",
        type: "audio/mpeg",
      },
    });
  });

  test("parses the shared Atom fixture", async () => {
    const xml = await readFile(
      new URL("../../fixtures/rss/atom.xml", import.meta.url),
      "utf8",
    );
    const [item] = parseFeed(xml, blog);
    expect(item?.title).toBe(
      "Northstar publishes deterministic cache reuse results",
    );
    expect(item?.text).not.toContain("fixtureTracker");
    expect(item?.text).not.toContain("tracker.gif");
  });
});

describe("fetchRssSources", () => {
  test("keeps partial successes and writes output idempotently", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-rss-"));
    const outPath = join(directory, "inbox", "rss.jsonl");
    const errors: string[] = [];
    const failing = {
      ...blog,
      id: "failing",
      name: "Failing",
      url: "https://fail.example/feed",
    };
    const fetcher = async (input: string | URL | Request) =>
      String(input).includes("fail.example")
        ? new Response("unavailable", { status: 503 })
        : new Response(rss, { status: 200 });
    const options = {
      sources: [blog, failing],
      since: new Date("2026-01-01T00:00:00Z"),
      outPath,
      seenPath: join(directory, "seen.jsonl"),
      now: new Date("2026-01-17T00:00:00Z"),
      fetcher,
      reportError: (message: string) => errors.push(message),
    };

    const first = await fetchRssSources(options);
    const second = await fetchRssSources(options);
    expect(first.items).toHaveLength(1);
    expect(first.failed).toEqual([{ source: "failing", error: "HTTP 503" }]);
    expect(second.items).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(await readJsonLines<NormalizedItem>(outPath)).toHaveLength(1);
  });

  test("fails when every configured RSS source fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-rss-"));
    await expect(
      fetchRssSources({
        sources: [blog],
        since: new Date("2026-01-01T00:00:00Z"),
        outPath: join(directory, "rss.jsonl"),
        seenPath: join(directory, "seen.jsonl"),
        fetcher: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("All RSS sources failed");
  });
});
