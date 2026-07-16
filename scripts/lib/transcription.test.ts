import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  transcribeAudioUrl,
  transcribeYouTube,
} from "./transcription";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("transcribeYouTube", () => {
  test("uses native subtitles before Deepgram", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      stdout: new TextEncoder().encode(
        JSON.stringify({
          subtitles: {
            en: [
              { url: "https://example.com/sub.json3", ext: "json3" },
              { url: "https://example.com/sub.vtt", ext: "vtt" },
            ],
          },
        }),
      ),
      stderr: "",
    });
    const result = await transcribeYouTube({
      itemId: "video-1",
      url: "https://youtube.com/watch?v=1",
      cacheDirectory: directory,
      budget: { remaining: 1 },
      runner,
      fetcher: async (input) => {
        expect(String(input)).toBe("https://example.com/sub.vtt");
        return new Response(
          "WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nHello\nHello",
        );
      },
      deepgramApiKey: "unused",
    });
    expect(result).toEqual({ provider: "native", text: "Hello" });
  });

  test("degrades when yt-dlp is missing", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    const result = await transcribeYouTube({
      itemId: "video-2",
      url: "https://youtube.com/watch?v=2",
      cacheDirectory: directory,
      budget: { remaining: 1 },
      runner: async () => {
        throw error;
      },
    });
    expect(result.provider).toBe("none");
    expect(result.notice).toContain("brew install yt-dlp");
  });

  test("parses json3 subtitles when VTT is unavailable", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      stdout: new TextEncoder().encode(
        JSON.stringify({
          subtitles: {
            en: [{ url: "https://example.com/sub.json3", ext: "json3" }],
          },
        }),
      ),
      stderr: "",
    });
    const result = await transcribeYouTube({
      itemId: "video-json3",
      url: "https://youtube.com/watch?v=json3",
      cacheDirectory: directory,
      budget: { remaining: 0 },
      runner,
      fetcher: async () =>
        Response.json({
          events: [
            { segs: [{ utf8: "Hello " }, { utf8: "world" }] },
            { segs: [{ utf8: "Next line" }] },
          ],
        }),
    });
    expect(result).toEqual({
      provider: "native",
      text: "Hello world\nNext line",
    });
  });

  test("uses one Deepgram budget unit when subtitles are absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const budget = { remaining: 1 };
    let calls = 0;
    const result = await transcribeYouTube({
      itemId: "video-3",
      url: "https://youtube.com/watch?v=3",
      cacheDirectory: directory,
      budget,
      deepgramApiKey: "secret",
      runner: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stdout: new TextEncoder().encode("{}"), stderr: "" }
          : { exitCode: 0, stdout: new Uint8Array([1, 2, 3]), stderr: "" };
      },
      fetcher: async () =>
        Response.json({
          results: {
            channels: [{ alternatives: [{ transcript: "Deep transcript" }] }],
          },
        }),
    });
    expect(result).toEqual({ provider: "deepgram", text: "Deep transcript" });
    expect(budget.remaining).toBe(0);
  });
});

describe("transcribeAudioUrl", () => {
  test.each([
    { name: "API key", deepgramApiKey: undefined, remaining: 1 },
    { name: "budget", deepgramApiKey: "unused", remaining: 0 },
  ])("skips without $name", async (capability) => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const budget = { remaining: capability.remaining };
    let fetchCalled = false;

    const result = await transcribeAudioUrl({
      itemId: "podcast-skip",
      audioUrl: "https://example.com/episode.mp3",
      cacheDirectory: directory,
      budget,
      deepgramApiKey: capability.deepgramApiKey,
      fetcher: async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      },
    });

    expect(result).toEqual({ provider: "none", text: "" });
    expect(fetchCalled).toBe(false);
    expect(budget.remaining).toBe(capability.remaining);
  });

  test("downloads audio and sends it to Deepgram", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const budget = { remaining: 2 };
    const requests: Request[] = [];

    const result = await transcribeAudioUrl({
      itemId: "podcast-success",
      audioUrl: "https://example.com/episode.mp3",
      cacheDirectory: directory,
      budget,
      deepgramApiKey: "test-key",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return new Response(new Uint8Array([1, 2, 3]));
        }
        return Response.json({
          results: {
            channels: [{ alternatives: [{ transcript: "Episode text" }] }],
          },
        });
      },
    });

    expect(result).toEqual({ provider: "deepgram", text: "Episode text" });
    expect(budget.remaining).toBe(1);
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    const deepgramRequest = requests[1];
    if (!deepgramRequest) throw new Error("Expected a Deepgram request");
    expect(deepgramRequest.headers.get("Authorization")).toBe("Token test-key");
    expect(deepgramRequest.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await deepgramRequest.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test.each([
    {
      name: "audio download",
      responses: [new Response(null, { status: 502 })],
      message: "Audio download failed with status 502",
    },
    {
      name: "Deepgram request",
      responses: [
        new Response(new Uint8Array([1])),
        new Response(null, { status: 429 }),
      ],
      message: "Deepgram transcription failed with status 429",
    },
  ])("reports $name HTTP failures", async ({ responses, message }) => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    const budget = { remaining: 1 };
    const responseQueue = [...responses];

    await expect(
      transcribeAudioUrl({
        itemId: "podcast-failure",
        audioUrl: "https://example.com/episode.mp3",
        cacheDirectory: directory,
        budget,
        deepgramApiKey: "test-key",
        fetcher: async () => {
          const response = responseQueue.shift();
          if (!response) throw new Error("unexpected fetch");
          return response;
        },
      }),
    ).rejects.toThrow(message);
    expect(budget.remaining).toBe(0);
  });

  test("reuses cached audio transcripts without budget or network", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-transcript-"));
    await writeFile(
      join(directory, "podcast-cache.json"),
      '{"provider":"deepgram","text":"Cached episode"}\n',
    );
    const budget = { remaining: 0 };
    let fetchCalled = false;

    const result = await transcribeAudioUrl({
      itemId: "podcast-cache",
      audioUrl: "https://example.com/episode.mp3",
      cacheDirectory: directory,
      budget,
      fetcher: async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      },
    });

    expect(result).toEqual({
      provider: "deepgram",
      text: "Cached episode",
    });
    expect(fetchCalled).toBe(false);
    expect(budget.remaining).toBe(0);
  });
});
