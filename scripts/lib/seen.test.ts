import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSeenUrls, hasSeen, loadSeenRecords } from "./seen";
import { fingerprintUrl, normalizeUrl } from "./url";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("seen records", () => {
  test("prunes old records and appends new urls idempotently", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-seen-"));
    const path = join(directory, "seen.jsonl");
    const oldUrl = "https://example.com/old";
    await writeFile(
      path,
      `${JSON.stringify({
        id: fingerprintUrl(oldUrl),
        normalized_url: normalizeUrl(oldUrl),
        first_seen: "2025-01-01T00:00:00.000Z",
      })}\n`,
    );

    const now = new Date("2026-01-01T00:00:00.000Z");
    const records = await loadSeenRecords(path, now);
    expect(records.size).toBe(0);

    const newUrl = "https://example.com/new?utm_source=test";
    await appendSeenUrls(path, records, [newUrl, newUrl], now);
    expect(hasSeen(records, "https://www.example.com/new")).toBe(true);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
