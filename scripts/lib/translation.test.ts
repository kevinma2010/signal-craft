import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextAtomic } from "./files";
import { getTranslationCachePath, translateMarkdown } from "./translation";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;
let directory: string | undefined;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

async function createOptions() {
  directory = await mkdtemp(join(tmpdir(), "signalcraft-translation-"));
  return {
    itemId: "article/123",
    targetLanguage: "zh-CN",
    markdown: "# Title\n\n![Diagram](https://example.com/image.png)",
    cacheDirectory: join(directory, "cache", "translations"),
  };
}

function setFetchMock(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}

describe("translateMarkdown", () => {
  test("skips translation when the API key is absent", async () => {
    const options = await createOptions();
    delete process.env.DEEPSEEK_API_KEY;
    let fetchCalled = false;
    setFetchMock(async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    });

    expect(await translateMarkdown(options)).toEqual({
      status: "skipped",
      reason: "missing_api_key",
    });
    expect(fetchCalled).toBe(false);
  });

  test("returns an immutable cached translation without calling the API", async () => {
    const options = await createOptions();
    const cachePath = getTranslationCachePath(
      options.cacheDirectory,
      options.itemId,
      options.targetLanguage,
    );
    await writeTextAtomic(cachePath, "# Cached");
    process.env.DEEPSEEK_API_KEY = "unused-secret";
    let fetchCalled = false;
    setFetchMock(async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    });

    expect(await translateMarkdown(options)).toEqual({
      status: "cached",
      markdown: "# Cached",
      cachePath,
    });
    expect(fetchCalled).toBe(false);
  });

  test("translates Markdown and caches the response", async () => {
    const options = await createOptions();
    const translated =
      "# Translated title\n\n![Diagram](https://example.com/image.png)";
    process.env.DEEPSEEK_API_KEY = "test-secret";
    let request: Request | undefined;
    setFetchMock(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        choices: [{ message: { content: translated } }],
      });
    });

    const result = await translateMarkdown(options);

    expect(result.status).toBe("translated");
    if (result.status !== "translated") {
      throw new Error("Expected a translated result");
    }
    expect(result.markdown).toBe(translated);
    expect(await readFile(result.cachePath, "utf8")).toBe(translated);
    expect(request?.headers.get("Authorization")).toBe("Bearer test-secret");
    const body = await request?.json();
    expect(body.messages[1].content).toContain(options.markdown);
    expect(body.messages[1].content).toContain(options.targetLanguage);
    expect(JSON.stringify(body)).not.toContain(options.itemId);
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  test("reports API failures without exposing the API key", async () => {
    const options = await createOptions();
    const apiKey = "do-not-log-this-secret";
    process.env.DEEPSEEK_API_KEY = apiKey;
    setFetchMock(
      async () => new Response(`Rejected ${apiKey}`, { status: 401 }),
    );

    let message = "";
    try {
      await translateMarkdown(options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("DeepSeek translation request failed with status 401");
    expect(message).not.toContain(apiKey);
  });

  test("keeps one complete immutable result during concurrent writes", async () => {
    const options = await createOptions();
    process.env.DEEPSEEK_API_KEY = "test-secret";
    setFetchMock(async () =>
      Response.json({ choices: [{ message: { content: "# Complete" } }] }),
    );

    const results = await Promise.all([
      translateMarkdown(options),
      translateMarkdown(options),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "cached",
      "translated",
    ]);
    const cachePath = getTranslationCachePath(
      options.cacheDirectory,
      options.itemId,
      options.targetLanguage,
    );
    expect(await readFile(cachePath, "utf8")).toBe("# Complete");
  });
});
