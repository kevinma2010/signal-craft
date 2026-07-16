import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchivedItems } from "./archive";
import { collectAndCommitSource } from "./collection";
import { readJsonLines } from "./jsonl";
import { getCollectionCheckpoint, loadState } from "./state";
import type { NormalizedItem, SourceDefinition } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const source: SourceDefinition = {
  id: "feed",
  name: "Feed",
  type: "rss",
  category: "official",
  weight: 1,
  url: "https://example.com/feed.xml",
};

describe("collectAndCommitSource", () => {
  test("bounds a first collection to 24 hours", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    let receivedSince: Date | undefined;
    await collectAndCommitSource({
      dataDirectory: directory,
      provider: "rss",
      source,
      initialSince: new Date("2026-01-01T00:00:00Z"),
      through,
      collect: async ({ since }) => {
        receivedSince = since;
        return { items: [] };
      },
    });

    expect(receivedSince?.toISOString()).toBe("2026-07-15T12:00:00.000Z");
  });

  test("does not treat a category success as a new source checkpoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        version: 2,
        categories: { rss: { last_success_at: through.toISOString() } },
        sources: {},
        checkpoints: {},
      }),
    );
    let input: { since: Date; isFirstRun: boolean } | undefined;

    const result = await collectAndCommitSource({
      dataDirectory: directory,
      provider: "rss",
      source,
      initialSince: new Date("2026-01-01T00:00:00Z"),
      through,
      collect: async ({ since, isFirstRun }) => {
        input = { since, isFirstRun };
        return { items: [] };
      },
    });

    expect(result.status).toBe("collected");
    expect(input?.since.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(input?.isFirstRun).toBe(true);
  });

  test("archives items before committing a source checkpoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    const result = await collectAndCommitSource({
      dataDirectory: directory,
      provider: "rss",
      source,
      initialSince: new Date("2026-07-15T12:00:00Z"),
      through,
      collect: async () => ({ items: [item()] }),
    });

    expect(result).toMatchObject({ status: "collected", archived: 1 });
    const state = await loadState(join(directory, "state.json"));
    expect(getCollectionCheckpoint(state, "rss", source)?.covered_through).toBe(
      through.toISOString(),
    );
    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-07-16T00:00:00Z"),
        to: through,
      }),
    ).toHaveLength(1);
  });

  test("does not call the adapter for an already covered interval", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    let calls = 0;
    const run = () =>
      collectAndCommitSource({
        dataDirectory: directory as string,
        provider: "rss",
        source,
        initialSince: new Date("2026-07-15T12:00:00Z"),
        through,
        collect: async () => {
          calls += 1;
          return { items: [item()] };
        },
      });

    expect((await run()).status).toBe("collected");
    expect((await run()).status).toBe("already-covered");
    expect(calls).toBe(1);
  });

  test("keeps the checkpoint unchanged when collection fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const result = await collectAndCommitSource({
      dataDirectory: directory,
      provider: "rss",
      source,
      initialSince: new Date("2026-07-15T12:00:00Z"),
      through: new Date("2026-07-16T12:00:00Z"),
      collect: async () => {
        throw new Error("offline");
      },
    });

    expect(result).toMatchObject({ status: "failed", error: "offline" });
    const state = await loadState(join(directory, "state.json"));
    expect(getCollectionCheckpoint(state, "rss", source)).toBeUndefined();
    expect(state.sources.feed?.consecutive_failures).toBe(1);
  });

  test("merges checkpoints from concurrent connector processes", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const secondSource: SourceDefinition = {
      ...source,
      id: "second",
      url: "https://example.com/second.xml",
    };
    const through = new Date("2026-07-16T12:00:00Z");

    await Promise.all([
      collectAndCommitSource({
        dataDirectory: directory,
        provider: "rss",
        source,
        initialSince: new Date("2026-07-15T12:00:00Z"),
        through,
        collect: async () => ({ items: [item()] }),
      }),
      collectAndCommitSource({
        dataDirectory: directory,
        provider: "rss",
        source: secondSource,
        initialSince: new Date("2026-07-15T12:00:00Z"),
        through,
        collect: async () => ({
          items: [
            {
              ...item(),
              id: "item-2",
              url: "https://example.com/item-2",
            },
          ],
        }),
      }),
    ]);

    const state = await loadState(join(directory, "state.json"));
    expect(getCollectionCheckpoint(state, "rss", source)).toBeDefined();
    expect(getCollectionCheckpoint(state, "rss", secondSource)).toBeDefined();
  });

  test("recovers a pending archive before calling the provider again", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    const outPath = join(directory, "inbox", "rss.jsonl");
    await writeFile(join(directory, "items"), "blocks archive directory");
    let calls = 0;
    const run = () =>
      collectAndCommitSource({
        dataDirectory: directory as string,
        provider: "rss",
        source,
        initialSince: new Date("2026-07-15T12:00:00Z"),
        through,
        outPath,
        collect: async () => {
          calls += 1;
          return { items: [item()] };
        },
      });

    expect((await run()).status).toBe("failed");
    await unlink(join(directory, "items"));
    expect((await run()).status).toBe("already-covered");
    expect(calls).toBe(1);
    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-07-16T00:00:00Z"),
        to: through,
      }),
    ).toHaveLength(1);
  });

  test("recovers failed staging before advancing the checkpoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-collection-"));
    const through = new Date("2026-07-16T12:00:00Z");
    const inboxPath = join(directory, "inbox");
    const outPath = join(inboxPath, "rss.jsonl");
    await writeFile(inboxPath, "blocks staging directory");
    let calls = 0;
    const run = () =>
      collectAndCommitSource({
        dataDirectory: directory as string,
        provider: "rss",
        source,
        initialSince: new Date("2026-07-15T12:00:00Z"),
        through,
        outPath,
        collect: async () => {
          calls += 1;
          return { items: [item()] };
        },
      });

    expect((await run()).status).toBe("failed");
    expect(
      getCollectionCheckpoint(
        await loadState(join(directory, "state.json")),
        "rss",
        source,
      ),
    ).toBeUndefined();

    await unlink(inboxPath);
    expect((await run()).status).toBe("already-covered");
    expect(calls).toBe(1);
    expect(await readJsonLines<NormalizedItem>(outPath)).toEqual([item()]);
    expect(
      getCollectionCheckpoint(
        await loadState(join(directory, "state.json")),
        "rss",
        source,
      )?.covered_through,
    ).toBe(through.toISOString());
  });
});

function item(): NormalizedItem {
  return {
    id: "item-1",
    type: "article",
    source: "Feed",
    author: "Author",
    title: "Item",
    url: "https://example.com/item",
    published_at: "2026-07-16T10:00:00Z",
    fetched_at: "2026-07-16T12:00:00Z",
    text: "Body",
    transcript_provider: "none",
    extra: {},
  };
}
