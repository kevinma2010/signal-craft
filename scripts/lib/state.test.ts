import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitCollectionSuccess,
  createCollectionCheckpointKey,
  createState,
  getCollectionCheckpoint,
  loadState,
  recordCategorySuccess,
  recordSourceFailure,
  recordSourceSuccess,
  saveState,
} from "./state";
import type { SourceDefinition } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("state", () => {
  const source: SourceDefinition = {
    id: "openai-x",
    name: "OpenAI",
    type: "x",
    category: "builder",
    weight: 1,
    handle: "OpenAI",
    tier: 1,
    maxResults: 10,
  };

  test("tracks category success and consecutive source failures", () => {
    const state = createState();
    const now = new Date("2026-01-01T00:00:00.000Z");
    recordCategorySuccess(state, "rss", now);
    expect(recordSourceFailure(state, "blog", "timeout", now)).toBe(1);
    expect(recordSourceFailure(state, "blog", "timeout", now)).toBe(2);
    recordSourceSuccess(state, "blog");
    expect(state.categories.rss?.last_success_at).toBe(now.toISOString());
    expect(state.sources.blog?.consecutive_failures).toBe(0);
  });

  test("creates stable checkpoint keys from retrieval coordinates", () => {
    const original = createCollectionCheckpointKey("grok", source);
    const metadataChangedSource: SourceDefinition = {
      ...source,
      name: "Ignored by Pick",
      category: "official",
      weight: 5,
      tier: 2,
      maxResults: 100,
    };
    const metadataChanged = createCollectionCheckpointKey(
      "grok",
      metadataChangedSource,
    );
    const coordinatesChanged = createCollectionCheckpointKey("grok", {
      ...source,
      handle: "xai",
    });

    expect(metadataChanged).toBe(original);
    expect(coordinatesChanged).not.toBe(original);
  });

  test("normalizes equivalent URL and handle coordinates", () => {
    const urlSource = {
      id: "feed",
      url: "https://WWW.Example.com/feed/?utm_source=x",
    };
    expect(createCollectionCheckpointKey("rss", urlSource)).toBe(
      createCollectionCheckpointKey("rss", {
        id: "feed",
        url: "https://example.com/feed",
      }),
    );
    expect(createCollectionCheckpointKey("grok", source)).toBe(
      createCollectionCheckpointKey("grok", {
        ...source,
        handle: "@openai",
      }),
    );
  });

  test("keeps provider checkpoints independent", () => {
    const state = createState();
    const first = { ...source, id: "first", handle: "first" };
    const second = { ...source, id: "second", handle: "second" };
    commitCollectionSuccess(state, "grok", first, {
      coveredThrough: "2026-01-01T01:00:00.000Z",
      cursor: "cursor-1",
      succeededAt: "2026-01-01T01:01:00.000Z",
    });

    expect(getCollectionCheckpoint(state, "grok", first)).toEqual({
      covered_through: "2026-01-01T01:00:00.000Z",
      cursor: "cursor-1",
      last_success_at: "2026-01-01T01:01:00.000Z",
    });
    expect(getCollectionCheckpoint(state, "x-api", first)).toBeUndefined();
    expect(getCollectionCheckpoint(state, "grok", second)).toBeUndefined();
  });

  test("preserves or explicitly clears an existing cursor", () => {
    const state = createState();
    commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T01:00:00.000Z",
      cursor: "123",
    });
    const preserved = commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T02:00:00.000Z",
    });
    const cleared = commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T03:00:00.000Z",
      cursor: null,
    });

    expect(preserved.cursor).toBe("123");
    expect(cleared.cursor).toBeUndefined();
  });

  test("does not move a checkpoint backwards", () => {
    const state = createState();
    const latest = commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T03:00:00.000Z",
      cursor: "300",
      succeededAt: "2026-01-01T03:01:00.000Z",
    });
    const stale = commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T02:00:00.000Z",
      cursor: "200",
      succeededAt: "2026-01-01T03:02:00.000Z",
    });

    expect(stale).toEqual(latest);
    expect(getCollectionCheckpoint(state, "x-api", source)?.cursor).toBe("300");
  });

  test("persists collection checkpoints", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    const state = createState();
    commitCollectionSuccess(state, "x-api", source, {
      coveredThrough: "2026-01-01T02:00:00.000Z",
      cursor: "456",
      succeededAt: "2026-01-01T02:01:00.000Z",
    });

    await saveState(path, state);
    const loaded = await loadState(path);

    expect(getCollectionCheckpoint(loaded, "x-api", source)).toEqual({
      covered_through: "2026-01-01T02:00:00.000Z",
      cursor: "456",
      last_success_at: "2026-01-01T02:01:00.000Z",
    });
  });

  test("rejects sources without retrieval coordinates", () => {
    expect(() =>
      createCollectionCheckpointKey("rss", { id: "missing" }),
    ).toThrow("Collection source has no retrieval coordinates: missing");
  });

  test("migrates unversioned legacy state through v2 with a backup", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        last_success: { rss: "2026-01-01T00:00:00.000Z" },
        source_failures: { blog: 3 },
      }),
    );
    const state = await loadState(path);
    expect(state.version).toBe(2);
    expect(state.sources.blog?.consecutive_failures).toBe(3);
    expect(state.categories.rss?.last_success_at).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(state.checkpoints).toEqual({});
    expect(existsSync(`${path}.v0.bak`)).toBe(true);
  });

  test("migrates v1 categories and source health without inventing checkpoints", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        categories: { rss: { last_success_at: "2026-01-01T00:00:00.000Z" } },
        sources: {
          blog: {
            consecutive_failures: 2,
            last_failure_at: "2026-01-01T00:01:00.000Z",
            last_error: "timeout",
          },
        },
      }),
    );

    const state = await loadState(path);
    expect(state).toEqual({
      version: 2,
      categories: { rss: { last_success_at: "2026-01-01T00:00:00.000Z" } },
      sources: {
        blog: {
          consecutive_failures: 2,
          last_failure_at: "2026-01-01T00:01:00.000Z",
          last_error: "timeout",
        },
      },
      checkpoints: {},
    });
    expect(existsSync(`${path}.v1.bak`)).toBe(true);
  });

  test("rejects invalid persisted checkpoints", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        categories: {},
        sources: {},
        checkpoints: {
          broken: {
            covered_through: "not-a-date",
            last_success_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    await expect(loadState(path)).rejects.toThrow(
      "Invalid timestamp: broken.covered_through",
    );
  });

  test("rejects state files from a future version", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        categories: {},
        sources: {},
        checkpoints: {},
      }),
    );

    await expect(loadState(path)).rejects.toThrow(
      `Unsupported version 3 in ${path}; expected at most 2`,
    );
    expect(existsSync(`${path}.v3.bak`)).toBe(false);
  });
});
