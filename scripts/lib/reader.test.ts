import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReaderHandler,
  InvalidDigestIdError,
  isSafeDigestId,
  isSafeItemId,
  isSafeLanguage,
  listDigests,
  listItems,
  parseReaderArgs,
  readDigest,
  readItem,
  renderDigestMarkdown,
} from "./reader";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("parseReaderArgs", () => {
  test("uses local reader defaults", () => {
    expect(parseReaderArgs([], "/home/tester")).toEqual({
      data: "/home/tester/.signalcraft",
      port: 4317,
    });
  });

  test("parses data and port options in either order", () => {
    expect(
      parseReaderArgs(["--port", "8080", "--data", "/tmp/signalcraft"]),
    ).toEqual({ data: "/tmp/signalcraft", port: 8080 });
  });

  test("rejects invalid, duplicate, and unknown options", () => {
    expect(() => parseReaderArgs(["--port", "0"])).toThrow("between 1");
    expect(() => parseReaderArgs(["--port", "1.5"])).toThrow("integer");
    expect(() => parseReaderArgs(["--data", "one", "--data", "two"])).toThrow(
      "Usage",
    );
    expect(() => parseReaderArgs(["--host", "0.0.0.0"])).toThrow("Usage");
  });
});

describe("digest filenames", () => {
  test("accepts real calendar dates only", () => {
    expect(isSafeDigestId("2026-07-16")).toBeTrue();
    expect(isSafeDigestId("2026-02-29")).toBeFalse();
    expect(isSafeDigestId("2024-02-29")).toBeTrue();
    expect(isSafeDigestId("../2026-07-16")).toBeFalse();
    expect(isSafeDigestId("2026-07-16.md")).toBeFalse();
    expect(isSafeDigestId("%2e%2e%2fsecret")).toBeFalse();
  });

  test("lists only regular YYYY-MM-DD markdown files newest first", async () => {
    directory = await createDataDirectory();
    await writeFile(
      join(directory, "digests", "2026-07-15.md"),
      "# Earlier digest\n",
    );
    await writeFile(
      join(directory, "digests", "2026-07-16.md"),
      "# **Latest** digest\n",
    );
    await writeFile(join(directory, "digests", "notes.md"), "# Notes\n");
    await writeFile(join(directory, "digests", "2026-07-14.txt"), "ignored");
    await symlink(
      join(directory, "digests", "2026-07-15.md"),
      join(directory, "digests", "2026-07-17.md"),
    );

    expect(await listDigests(directory)).toEqual([
      {
        id: "2026-07-16",
        date: "2026-07-16",
        title: "Latest digest",
        kind: "briefing",
        excerpt: "",
        wordCount: 2,
        readingMinutes: 1,
      },
      {
        id: "2026-07-15",
        date: "2026-07-15",
        title: "Earlier digest",
        kind: "briefing",
        excerpt: "",
        wordCount: 2,
        readingMinutes: 1,
      },
    ]);
  });

  test("returns an empty list when the digest directory is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-reader-"));
    expect(await listDigests(directory)).toEqual([]);
  });

  test("rejects traversal before reading the filesystem", async () => {
    directory = await createDataDirectory();
    await expect(readDigest(directory, "../secret")).rejects.toBeInstanceOf(
      InvalidDigestIdError,
    );
  });
});

describe("digest rendering", () => {
  test("renders useful Markdown and strips executable HTML", () => {
    const html = renderDigestMarkdown(`
# Daily briefing

[Source](https://example.com/post)

![Diagram](https://example.com/diagram.png)

<script>alert(1)</script>
<img src="x" onerror="alert(2)">
[Unsafe](javascript:alert(3))
`);

    expect(html).not.toContain("<h1>Daily briefing</h1>");
    expect(html).toContain(
      '<a href="https://example.com/post" target="_blank" rel="noopener noreferrer">Source</a>',
    );
    expect(html).toContain(
      '<img src="https://example.com/diagram.png" alt="Diagram" loading="lazy" />',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('href="javascript:');
  });

  test("reads and renders a digest with stable metadata", async () => {
    directory = await createDataDirectory();
    await writeFile(
      join(directory, "digests", "2026-07-16.md"),
      "# Shipping **today**\n\nBody",
    );

    expect(await readDigest(directory, "2026-07-16")).toEqual({
      id: "2026-07-16",
      date: "2026-07-16",
      title: "Shipping today",
      kind: "briefing",
      excerpt: "Body",
      wordCount: 3,
      readingMinutes: 1,
      html: "<p>Body</p>\n",
    });
  });

  test("counts CJK text once and recognizes localized digest kinds", async () => {
    directory = await createDataDirectory();
    await writeFile(
      join(directory, "digests", "2026-07-16.md"),
      "# AI 情报日报\n\n模型更新",
    );

    expect(await readDigest(directory, "2026-07-16")).toMatchObject({
      kind: "daily",
      wordCount: 9,
      html: "<p>模型更新</p>\n",
    });
  });
});

describe("archived item reading", () => {
  test("validates stable item ids and cache language tags", () => {
    expect(isSafeItemId("a".repeat(64))).toBeTrue();
    expect(isSafeItemId("A".repeat(64))).toBeFalse();
    expect(isSafeItemId(`../${"a".repeat(64)}`)).toBeFalse();
    expect(isSafeItemId("a".repeat(63))).toBeFalse();
    expect(isSafeLanguage("zh-CN")).toBeTrue();
    expect(isSafeLanguage("en")).toBeTrue();
    expect(isSafeLanguage("../secret")).toBeFalse();
    expect(isSafeLanguage("zh-CN.md")).toBeFalse();
  });

  test("renders safe item HTML without exposing archived Markdown", async () => {
    directory = await createDataDirectory();
    const id = "a".repeat(64);
    await writeArchivedItems(directory, [
      createArchivedItem(id, {
        text: "## Original\n\nBody <script>alert(1)</script>",
      }),
    ]);
    await mkdir(join(directory, "cache", "translations"), {
      recursive: true,
    });
    await writeFile(
      join(directory, "cache", "translations", `${id}.zh-CN.md`),
      "## Localized\n\nTranslated <img src=x onerror=alert(2)>",
    );

    const item = await readItem(directory, id, "zh-CN");

    expect(item.originalHtml).toContain("Body");
    expect(item.localizedHtml).toContain("Translated");
    expect(item.originalHtml).not.toContain("<script");
    expect(item.localizedHtml).not.toContain("onerror");
    expect(item).toMatchObject({
      id,
      type: "article",
      source: "Example",
      author: "Ada",
      title: "Useful article",
      url: "https://example.com/article",
      publishedAt: "2026-07-16T00:00:00.000Z",
      contentLength: 43,
      contentStatus: "archived",
      localizedLanguage: "zh-CN",
    });
    expect(item).not.toHaveProperty("text");
  });

  test("lists every valid item newest first with archive metadata", async () => {
    directory = await createDataDirectory();
    const ids = {
      complete: "a".repeat(64),
      excerpt: "b".repeat(64),
      unknown: "c".repeat(64),
      archived: "d".repeat(64),
      metadataOnly: "e".repeat(64),
      invalid: "f".repeat(64),
    };
    await writeArchivedItems(directory, [
      createArchivedItem(ids.archived, {
        published_at: "2026-07-15T00:00:00.000Z",
        text: "# Useful article\n\nArchived body",
        extra: { content_status: "summary" },
      }),
      createArchivedItem(ids.complete, {
        published_at: "2026-07-18T00:00:00.000Z",
        text: "Complete body",
        extra: { content_status: "complete" },
      }),
      createArchivedItem(ids.metadataOnly, {
        published_at: "2026-07-14T00:00:00.000Z",
        text: "  \n",
        extra: { content_status: "missing" },
      }),
      createArchivedItem(ids.unknown, {
        published_at: "2026-07-16T00:00:00.000Z",
        text: "",
        extra: { content_status: "unknown" },
      }),
      createArchivedItem(ids.excerpt, {
        published_at: "2026-07-17T00:00:00.000Z",
        text: "Excerpt body",
        extra: { content_status: "excerpt" },
      }),
      createArchivedItem(ids.invalid, {
        published_at: "not-a-date",
      }),
    ]);
    const translationsDirectory = join(directory, "cache", "translations");
    await mkdir(translationsDirectory, { recursive: true });
    await writeFile(
      join(translationsDirectory, `${ids.excerpt}.zh-CN.md`),
      "Localized excerpt",
    );
    const outside = join(directory, "outside.md");
    await writeFile(outside, "Linked translation");
    await symlink(
      outside,
      join(translationsDirectory, `${ids.complete}.zh-CN.md`),
    );

    const items = await listItems(directory, "zh-cn");

    expect(items.map((item) => item.id)).toEqual([
      ids.complete,
      ids.excerpt,
      ids.unknown,
      ids.archived,
      ids.metadataOnly,
    ]);
    expect(items.map((item) => item.contentStatus)).toEqual([
      "complete",
      "excerpt",
      "unknown",
      "archived",
      "metadata-only",
    ]);
    expect(items.map((item) => item.hasLocalization)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(items[1]).toEqual({
      id: ids.excerpt,
      type: "article",
      source: "Example",
      author: "Ada",
      title: "Useful article",
      publishedAt: "2026-07-17T00:00:00.000Z",
      excerpt: "Excerpt body",
      contentLength: 12,
      contentStatus: "excerpt",
      hasLocalization: true,
    });
    expect(items[3]?.excerpt).toBe("Archived body");
    expect(items[4]?.excerpt).toBe("");
  });

  test("omits localization when the cache entry is absent or a symlink", async () => {
    directory = await createDataDirectory();
    const id = "b".repeat(64);
    await writeArchivedItems(directory, [createArchivedItem(id)]);

    const untranslated = await readItem(directory, id, "zh-CN");
    expect(untranslated).not.toHaveProperty("localizedHtml");
    expect(untranslated).not.toHaveProperty("localizedLanguage");

    const translationsDirectory = join(directory, "cache", "translations");
    await mkdir(translationsDirectory, { recursive: true });
    const outside = join(directory, "outside.md");
    await writeFile(outside, "Secret translation");
    await symlink(outside, join(translationsDirectory, `${id}.zh-CN.md`));

    const linked = await readItem(directory, id, "zh-CN");
    expect(linked).not.toHaveProperty("localizedHtml");
  });

  test("rewrites duplicate normalized URLs deterministically", async () => {
    directory = await createDataDirectory();
    const smallerId = "1".repeat(64);
    const largerId = "f".repeat(64);
    await writeArchivedItems(directory, [
      createArchivedItem(largerId, {
        url: "https://www.example.com/article/?utm_source=digest",
      }),
      createArchivedItem(smallerId, {
        url: "https://example.com/article",
      }),
    ]);
    await writeFile(
      join(directory, "digests", "2026-07-16.md"),
      "# Briefing\n\n[Archived](https://example.com/article?utm_medium=email)",
    );

    const digest = await readDigest(directory, "2026-07-16");

    expect(digest.html).toContain(`href="/signals/${smallerId}"`);
    expect(digest.html).not.toContain(`href="#/item/${largerId}"`);
    expect((await readItem(directory, largerId)).url).toBe(
      "https://www.example.com/article/?utm_source=digest",
    );
  });

  test("returns 400 for unsafe ids and languages and 404 for missing items", async () => {
    directory = await createDataDirectory();
    const handler = createReaderHandler({ dataDirectory: directory });
    const id = "c".repeat(64);

    expect(
      (await handler(new Request("http://reader/api/items/not-an-id"))).status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request(`http://reader/api/items/${id}?language=..%2Fsecret`),
        )
      ).status,
    ).toBe(400);
    expect(
      (await handler(new Request(`http://reader/api/items/${id}`))).status,
    ).toBe(404);
  });

  test("validates list languages and serves HEAD without a body", async () => {
    directory = await createDataDirectory();
    const handler = createReaderHandler({ dataDirectory: directory });

    expect(
      (
        await handler(
          new Request("http://reader/api/items?language=..%2Fsecret"),
        )
      ).status,
    ).toBe(400);
    expect(
      (await handler(new Request("http://reader/api/items?language="))).status,
    ).toBe(400);

    const head = await handler(
      new Request("http://reader/api/items?language=zh-CN", {
        method: "HEAD",
      }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await head.text()).toBe("");
  });
});

async function createDataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "signalcraft-reader-"));
  await mkdir(join(path, "digests"), { recursive: true });
  return path;
}

async function writeArchivedItems(
  path: string,
  items: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(join(path, "items"), { recursive: true });
  await writeFile(
    join(path, "items", "2026-07.jsonl"),
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
}

function createArchivedItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
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
    ...overrides,
  };
}
