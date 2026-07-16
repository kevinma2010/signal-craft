import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDefinition } from "./types";
import {
  fetchYouTubeSources,
  parseYouTubeFeed,
  resolveTranscriptionBudget,
} from "./youtube";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const source: SourceDefinition = {
  id: "channel",
  name: "Channel",
  type: "youtube",
  category: "official",
  weight: 1,
  url: "https://www.youtube.com/channel/UC123",
};
const feed = `<feed><entry><yt:videoId>abc</yt:videoId><title>Demo</title><published>2026-01-10T00:00:00Z</published><author><name>Builder</name></author><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><media:group><media:description>Show notes</media:description></media:group></entry></feed>`;

async function makePaths() {
  directory = await mkdtemp(join(tmpdir(), "signalcraft-youtube-"));
  return {
    outPath: join(directory, "youtube.jsonl"),
    seenPath: join(directory, "seen.jsonl"),
    cacheDirectory: join(directory, "cache"),
  };
}

describe("YouTube connector", () => {
  test("resolves configured transcription budgets", () => {
    expect(resolveTranscriptionBudget(undefined)).toBe(10);
    expect(
      resolveTranscriptionBudget({ transcription: { max_items_per_run: 3 } }),
    ).toBe(3);
    expect(
      resolveTranscriptionBudget({
        transcription: { enabled: false, max_items_per_run: 3 },
      }),
    ).toBe(0);
  });

  test("normalizes channel feed entries", () => {
    const [item] = parseYouTubeFeed(feed, source);
    expect(item?.type).toBe("video");
    expect(item?.text).toBe("Show notes");
  });

  test("emits metadata with a missing yt-dlp notice", async () => {
    const paths = await makePaths();
    const result = await fetchYouTubeSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      ...paths,
      fetcher: async () => new Response(feed),
      runner: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.transcript_provider).toBe("none");
    expect(result.notices[0]).toContain("yt-dlp");
  });

  test("keeps successful sources when another source fails", async () => {
    const paths = await makePaths();
    const failing = {
      ...source,
      id: "failing-channel",
      name: "Failing Channel",
      url: "https://www.youtube.com/channel/UCFAIL",
    };
    const errors: string[] = [];

    const result = await fetchYouTubeSources({
      sources: [failing, source],
      since: new Date("2026-01-01T00:00:00Z"),
      ...paths,
      fetcher: async (input) =>
        String(input).includes("UCFAIL")
          ? new Response(null, { status: 503 })
          : new Response(feed),
      runner: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      reportError: (message) => errors.push(message),
    });

    expect(result.succeeded).toEqual([source.id]);
    expect(result.failed).toEqual([{ source: failing.id, error: "HTTP 503" }]);
    expect(result.items).toHaveLength(1);
    expect(errors).toEqual(["Failing Channel: HTTP 503"]);
  });

  test("rejects when every YouTube source fails", async () => {
    const paths = await makePaths();

    const error = await fetchYouTubeSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      ...paths,
      fetcher: async () => new Response(null, { status: 502 }),
    }).catch((value) => value);

    expect(error.name).toBe("AllYouTubeSourcesFailedError");
    expect(error.failed).toEqual([{ source: source.id, error: "HTTP 502" }]);
  });

  test("shares the transcription budget across videos", async () => {
    const paths = await makePaths();
    const multiEntryFeed = `<feed>
      <entry><yt:videoId>one</yt:videoId><title>One</title><published>2026-01-11T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/watch?v=one"/></entry>
      <entry><yt:videoId>two</yt:videoId><title>Two</title><published>2026-01-12T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/watch?v=two"/></entry>
    </feed>`;
    let runnerCalls = 0;

    const result = await fetchYouTubeSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      budget: 1,
      deepgramApiKey: "test-key",
      ...paths,
      fetcher: async (input) =>
        String(input).includes("api.deepgram.com")
          ? Response.json({
              results: {
                channels: [
                  { alternatives: [{ transcript: "First transcript" }] },
                ],
              },
            })
          : new Response(multiEntryFeed),
      runner: async () => {
        runnerCalls += 1;
        return runnerCalls === 2
          ? { exitCode: 0, stdout: new Uint8Array([1]), stderr: "" }
          : { exitCode: 0, stdout: new TextEncoder().encode("{}"), stderr: "" };
      },
    });

    expect(runnerCalls).toBe(3);
    expect(result.transcribed).toBe(1);
    expect(result.items.map((item) => item.transcript_provider)).toEqual([
      "deepgram",
      "none",
    ]);
    expect(result.items.map((item) => item.text)).toEqual([
      "First transcript",
      "",
    ]);
  });
});
