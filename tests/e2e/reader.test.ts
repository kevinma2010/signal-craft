import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createReaderServer } from "../../scripts/lib/reader";

let directory: string | undefined;
let server: ReturnType<typeof createReaderServer> | undefined;
let viteServer: ViteDevServer | undefined;

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  await viteServer?.close();
  viteServer = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("local reader server", () => {
  test("renders the signal archive as a grouped main-surface catalog", async () => {
    const routesDirectory = join(import.meta.dir, "..", "..", "src", "routes");
    const [shell, signals, item] = await Promise.all([
      Bun.file(
        join(import.meta.dir, "..", "..", "src", "reader", "app-shell.tsx"),
      ).text(),
      Bun.file(join(routesDirectory, "signals.index.tsx")).text(),
      Bun.file(join(routesDirectory, "signals.$itemId.tsx")).text(),
    ]);
    expect(shell).toContain('id="main-content"');
    expect(shell).toContain('id="archive-panel"');
    expect(signals).toContain('createFileRoute("/signals/")');
    expect(signals).toContain('id="signal-catalog"');
    expect(signals).toContain('id="signal-catalog-search"');
    expect(signals).toContain('id="signal-catalog-type"');
    expect(signals).toContain('id="signal-catalog-groups"');
    expect(item).toContain('createFileRoute("/signals/$itemId")');
  });

  test("serves the TanStack reader and existing digest APIs", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-reader-e2e-"));
    const dataDirectory = join(directory, "data");
    await mkdir(join(dataDirectory, "digests"), { recursive: true });
    await Promise.all([
      writeFile(
        join(dataDirectory, "digests", "2026-07-16.md"),
        "# Reader E2E\n\n## Read Later\n\n[Open](https://example.com/article)",
      ),
      mkdir(join(dataDirectory, "items"), { recursive: true }),
      mkdir(join(dataDirectory, "cache", "translations"), {
        recursive: true,
      }),
    ]);
    const itemId = "a".repeat(64);
    await Promise.all([
      writeFile(
        join(dataDirectory, "items", "2026-07.jsonl"),
        `${JSON.stringify({
          id: itemId,
          type: "article",
          source: "Example",
          author: "Ada",
          title: "Useful article",
          url: "https://example.com/article",
          published_at: "2026-07-16T00:00:00.000Z",
          fetched_at: "2026-07-16T01:00:00.000Z",
          text: "## Original\n\nPrimary source body.",
          transcript_provider: "none",
          extra: {},
        })}\n`,
      ),
      writeFile(
        join(dataDirectory, "cache", "translations", `${itemId}.zh-CN.md`),
        "## Localized\n\nNatural localized body.",
      ),
    ]);

    process.env.SIGNALCRAFT_DATA_DIRECTORY = dataDirectory;
    viteServer = await createViteServer({
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite address");
    const origin = `http://127.0.0.1:${address.port}`;

    const index = await fetch(`${origin}/signals`);
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain("SignalCraft Reader");
    expect(indexHtml).toContain("Useful article");
    expect(indexHtml).toContain('id="signal-catalog"');
    expect(indexHtml).toContain('nonce="signalcraft-reader"');
    expect(index.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");

    const [list, digest, items, item] = await Promise.all([
      fetch(`${origin}/api/digests`),
      fetch(`${origin}/api/digests/2026-07-16`),
      fetch(`${origin}/api/items?language=zh-CN`),
      fetch(`${origin}/api/items/${itemId}?language=zh-CN`),
    ]);
    expect(await list.json()).toMatchObject({
      digests: [
        {
          id: "2026-07-16",
          date: "2026-07-16",
          title: "Reader E2E",
          kind: "briefing",
          readingMinutes: 1,
        },
      ],
    });
    const digestPayload = await digest.json();
    expect(digestPayload).toMatchObject({
      digest: {
        id: "2026-07-16",
        title: "Reader E2E",
        html: expect.stringContaining(`href="/signals/${itemId}"`),
      },
    });
    expect(await item.json()).toMatchObject({
      item: {
        id: itemId,
        title: "Useful article",
        source: "Example",
        contentLength: 33,
        contentStatus: "archived",
        originalHtml: expect.stringContaining("Primary source body"),
        localizedHtml: expect.stringContaining("Natural localized body"),
        localizedLanguage: "zh-CN",
      },
    });
    expect(await items.json()).toEqual({
      items: [
        {
          id: itemId,
          type: "article",
          source: "Example",
          author: "Ada",
          title: "Useful article",
          publishedAt: "2026-07-16T00:00:00.000Z",
          excerpt: "Original Primary source body.",
          contentLength: 33,
          contentStatus: "archived",
          hasLocalization: true,
        },
      ],
    });
  });

  test("does not expose files through malformed API or static paths", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-reader-e2e-"));
    server = createReaderServer({
      dataDirectory: join(directory, "data"),
      port: 0,
    });
    const origin = `http://${server.hostname}:${server.port}`;

    const missingItemId = "a".repeat(64);
    for (const [path, expectedStatus] of [
      ["/api/digests/..%2Fsecret", 400],
      ["/api/digests/2026-07-16.md", 400],
      ["/api/items/not-an-id", 400],
      [`/api/items/${missingItemId}?language=..%2Fsecret`, 400],
      [`/api/items/${missingItemId}`, 404],
      ["/package.json", 404],
      ["/../package.json", 404],
    ] as const) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(expectedStatus);
    }
  });
});
