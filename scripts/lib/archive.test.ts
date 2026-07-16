import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProcessedItems } from "./archive";
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
});
