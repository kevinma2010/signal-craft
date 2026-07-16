import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_X_API_CONFIG, loadXApiConfig } from "./config";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("loadXApiConfig", () => {
  test("is disabled with conservative defaults when config is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-config-"));
    expect(await loadXApiConfig(join(directory, "config.yaml"))).toEqual(
      DEFAULT_X_API_CONFIG,
    );
  });

  test("loads explicit source routing and hard budgets", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-config-"));
    const path = join(directory, "config.yaml");
    await writeFile(
      path,
      `version: 1
x_api:
  enabled: true
  source_ids: [account, account, second]
  max_post_reads_per_run: 20
  max_post_reads_per_day: 100
  max_post_reads_per_month: 1000
  max_cost_usd_per_run: 0.1
  max_cost_usd_per_day: 0.5
  max_cost_usd_per_month: 5
  max_pages_per_query: 1
  cost_per_post_read_usd: 0.005
  fail_closed: true
`,
    );

    expect(await loadXApiConfig(path)).toMatchObject({
      enabled: true,
      sourceIds: ["account", "second"],
      maxPostReadsPerRun: 20,
      maxPostReadsPerDay: 100,
      maxPostReadsPerMonth: 1_000,
      maxCostUsdPerMonth: 5,
      failClosed: true,
    });
  });

  test("rejects attempts to disable fail-closed behavior", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-config-"));
    const path = join(directory, "config.yaml");
    await writeFile(path, "version: 1\nx_api:\n  fail_closed: false\n");
    await expect(loadXApiConfig(path)).rejects.toThrow("must be true");
  });

  test("rejects a post-read cost below the conservative floor", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-config-"));
    const path = join(directory, "config.yaml");
    await writeFile(
      path,
      "version: 1\nx_api:\n  cost_per_post_read_usd: 0.001\n",
    );
    await expect(loadXApiConfig(path)).rejects.toThrow("must be at least");
  });
});
