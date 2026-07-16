import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createState,
  loadState,
  recordCategorySuccess,
  recordSourceFailure,
  recordSourceSuccess,
} from "./state";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("state", () => {
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

  test("migrates legacy state in place with a backup", async () => {
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
    expect(state.version).toBe(1);
    expect(state.sources.blog?.consecutive_failures).toBe(3);
    expect(existsSync(`${path}.v0.bak`)).toBe(true);
  });

  test("rejects state files from a future version", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-state-"));
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({ version: 2, categories: {}, sources: {} }),
    );

    await expect(loadState(path)).rejects.toThrow(
      `Unsupported version 2 in ${path}; expected at most 1`,
    );
    expect(existsSync(`${path}.v2.bak`)).toBe(false);
  });
});
