import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { main } from "./fetch-x";
import { loadMergedSources } from "./lib/sources";
import type { FetchXOptions, FetchXResult } from "./lib/x";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("fetch-x connector", () => {
  test("opens a run circuit after Grok reports a login failure", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-fetch-x-"));
    const defaultPack = join(import.meta.dir, "..", "sources.default.yaml");
    const allSources = await loadMergedSources(
      defaultPack,
      join(directory, "missing.yaml"),
    );
    const xSources = allSources.filter((source) => source.type === "x");
    const enabled = xSources.slice(0, 2);
    const overlayPath = join(directory, "sources.yaml");
    await Bun.write(
      overlayPath,
      stringify({
        version: 1,
        added: [],
        disabled: xSources.slice(2).map((source) => source.id),
        weights: {},
      }),
    );
    let calls = 0;
    const fetchGrokSources = async (
      options: FetchXOptions,
    ): Promise<FetchXResult> => {
      calls += 1;
      return {
        items: [],
        succeeded: [],
        failed: [
          {
            source: options.sources[0]?.id ?? "unknown",
            error: "Grok login expired",
          },
        ],
        degraded: "Run `grok login`, then retry X collection.",
      };
    };

    await expect(
      main(
        [
          "--config",
          overlayPath,
          "--since",
          "2026-07-15T00:00:00Z",
          "--out",
          join(directory, "inbox", "x.jsonl"),
        ],
        new Date("2026-07-16T00:00:00Z"),
        { fetchGrokSources },
      ),
    ).rejects.toThrow("All X sources failed");
    expect(enabled).toHaveLength(2);
    expect(calls).toBe(1);
  });
});
