import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProcessedItems, readArchivedItems } from "./archive";
import { appendJsonLines } from "./jsonl";
import { loadSeenRecords } from "./seen";
import type { NormalizedItem } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("archiveProcessedItems", () => {
  test("archives items and marks urls seen idempotently", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    const item: NormalizedItem = {
      id: "item-1",
      type: "article",
      source: "Example",
      author: "Author",
      title: "Update",
      url: "https://example.com/update",
      published_at: "2026-01-10T00:00:00.000Z",
      fetched_at: "2026-01-11T00:00:00.000Z",
      text: "Body",
      transcript_provider: "none",
      extra: {},
    };
    const now = new Date("2026-01-11T00:00:00.000Z");

    expect(await archiveProcessedItems(directory, [item], now)).toBe(1);
    expect(await archiveProcessedItems(directory, [item], now)).toBe(0);
    expect(
      (await readFile(join(directory, "items", "2026-01.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(
      (await loadSeenRecords(join(directory, "seen.jsonl"), now)).size,
    ).toBe(1);
  });

  test("archives backfilled items by publication month", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    const backfilled = item(
      "backfilled",
      "https://example.com/backfilled",
      "2026-01-31T23:00:00Z",
    );

    expect(
      await archiveProcessedItems(
        directory,
        [backfilled],
        new Date("2026-02-02T00:00:00Z"),
      ),
    ).toBe(1);
    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-01-31T00:00:00Z"),
        to: new Date("2026-02-01T00:00:00Z"),
      }),
    ).toEqual([backfilled]);
  });

  test("does not archive the same normalized URL under another id", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    const first = item(
      "first",
      "https://example.com/post",
      "2026-01-01T00:00:00Z",
    );
    const duplicate = item(
      "second",
      "https://www.example.com/post/?utm_source=test",
      "2026-01-01T01:00:00Z",
    );

    expect(
      await archiveProcessedItems(
        directory,
        [first, duplicate],
        new Date("2026-01-02T00:00:00Z"),
      ),
    ).toBe(1);
    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-01-02T00:00:00Z"),
      }),
    ).toEqual([first]);
  });
});

describe("readArchivedItems", () => {
  test("reads a seven-day weekly window across month boundaries", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    await writeArchive("2026-01", [
      item("before", "https://example.com/before", "2026-01-24T23:59:59Z"),
      item("first", "https://example.com/first", "2026-01-25T00:00:00Z"),
      item("second", "https://example.com/second", "2026-01-31T12:00:00Z"),
    ]);
    await writeArchive("2026-02", [
      item("last", "https://example.com/last", "2026-02-01T23:59:59Z"),
      item("after", "https://example.com/after", "2026-02-02T00:00:00Z"),
    ]);

    const daily = await readArchivedItems(directory, {
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-02-02T00:00:00Z"),
    });
    const weekly = await readArchivedItems(directory, {
      from: new Date("2026-01-25T00:00:00Z"),
      to: new Date("2026-02-02T00:00:00Z"),
    });

    expect(daily.map(({ id }) => id)).toEqual(["last"]);
    expect(weekly.map(({ id }) => id)).toEqual(["first", "second", "last"]);
  });

  test("deduplicates stable ids and normalized urls deterministically", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    await writeArchive("2026-03", [
      item("shared-id", "https://example.com/id", "2026-03-03T12:00:00Z"),
      item("zulu", "https://example.com/zulu", "2026-03-01T13:00:00+02:00"),
      item(
        "url-copy",
        "https://www.example.com/post/?utm_source=test",
        "2026-03-02T12:00:00Z",
      ),
      item("original", "https://example.com/post", "2026-03-01T12:00:00Z"),
      item("shared-id", "https://example.com/other", "2026-03-04T12:00:00Z"),
    ]);

    const result = await readArchivedItems(directory, {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
    });

    expect(result.map(({ id }) => id)).toEqual([
      "zulu",
      "original",
      "shared-id",
    ]);
  });

  test("tolerates missing month files and an empty archive", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));
    await writeArchive("2026-05", [
      item("may", "https://example.com/may", "2026-05-01T00:00:00Z"),
    ]);

    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-04-30T00:00:00Z"),
        to: new Date("2026-06-01T00:00:00Z"),
      }),
    ).toHaveLength(1);
    expect(
      await readArchivedItems(join(directory, "missing"), {
        from: new Date("2026-05-01T00:00:00Z"),
        to: new Date("2026-05-02T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  test("rejects invalid windows", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-archive-"));

    expect(
      readArchivedItems(directory, {
        from: new Date("2026-02-02T00:00:00Z"),
        to: new Date("2026-02-01T00:00:00Z"),
      }),
    ).rejects.toThrow("from <= to");
  });
});

function item(id: string, url: string, publishedAt: string): NormalizedItem {
  return {
    id,
    type: "article",
    source: "Example",
    author: "Author",
    title: id,
    url,
    published_at: publishedAt,
    fetched_at: "2026-07-16T00:00:00Z",
    text: "Body",
    transcript_provider: "none",
    extra: {},
  };
}

async function writeArchive(
  month: string,
  items: readonly NormalizedItem[],
): Promise<void> {
  if (!directory) {
    throw new Error("Test archive directory is not initialized");
  }
  await appendJsonLines(join(directory, "items", `${month}.jsonl`), items);
}
