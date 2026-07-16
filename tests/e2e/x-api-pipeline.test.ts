import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectXApiSource, type XApiRunUsage } from "../../scripts/fetch-x";
import { readArchivedItems } from "../../scripts/lib/archive";
import { collectAndCommitSource } from "../../scripts/lib/collection";
import type { XApiConfig } from "../../scripts/lib/config";
import { getCollectionCheckpoint, loadState } from "../../scripts/lib/state";
import type { SourceDefinition } from "../../scripts/lib/types";
import { fetchXApiPosts } from "../../scripts/lib/x-api";
import {
  appendXApiUsage,
  loadXApiPriorUsage,
} from "../../scripts/lib/x-api-ledger";
import {
  createXApiSource,
  normalizeXApiPost,
} from "../../scripts/lib/x-api-normalize";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("paid X API collection pipeline", () => {
  test("preflights, commits once, and serves reports without new requests", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-api-e2e-"));
    const now = new Date("2026-07-16T08:00:00Z");
    const source: SourceDefinition = {
      id: "openai-x",
      name: "OpenAI",
      type: "x",
      category: "official",
      weight: 1,
      handle: "OpenAI",
    };
    const ledgerPath = join(directory, "cache", "x-api-usage.jsonl");
    let requests = 0;
    const run = () =>
      collectAndCommitSource({
        dataDirectory: directory as string,
        provider: "x-api",
        source,
        initialSince: new Date("2026-07-15T08:00:00Z"),
        through: now,
        collect: async ({ since, cursor }) => {
          const result = await fetchXApiPosts({
            enabled: true,
            bearerToken: "test-token",
            sources: [
              createXApiSource(source, { sinceId: cursor, startTime: since }),
            ],
            limits: {
              maxPostReadsPerRun: 10,
              maxPostReadsPerDay: 20,
              maxPostReadsPerMonth: 100,
              maxUsdPerRun: 0.05,
              maxUsdPerDay: 0.1,
              maxUsdPerMonth: 0.5,
            },
            priorUsage: await loadXApiPriorUsage(ledgerPath, now),
            fetcher: async (input) => {
              requests += 1;
              return String(input).includes("/usage/tweets")
                ? Response.json({
                    data: { project_usage: 0, project_cap: 1_000 },
                  })
                : Response.json({
                    data: [
                      {
                        id: "200",
                        text: "Complete API post",
                        author_id: "42",
                        created_at: "2026-07-16T07:00:00Z",
                      },
                    ],
                    meta: { result_count: 1, newest_id: "200" },
                  });
            },
            clock: () => now,
          });
          await appendXApiUsage(ledgerPath, result, now);
          if (result.status !== "ok") throw new Error(result.reason);
          return {
            items: result.posts.map((post) =>
              normalizeXApiPost(post, source, now),
            ),
            cursor: result.cursors[source.id],
          };
        },
      });

    expect((await run()).status).toBe("collected");
    expect(requests).toBe(2);
    expect((await run()).status).toBe("already-covered");
    expect(requests).toBe(2);
    expect(
      await readArchivedItems(directory, {
        from: new Date("2026-07-15T08:00:00Z"),
        to: now,
      }),
    ).toHaveLength(1);
    const state = await loadState(join(directory, "state.json"));
    expect(getCollectionCheckpoint(state, "x-api", source)?.cursor).toBe("200");
    expect(await loadXApiPriorUsage(ledgerPath, now)).toMatchObject({
      postReadsToday: 1,
      usdToday: 0.005,
    });
  });

  test("shares the per-run budget across paid sources", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-api-e2e-"));
    const now = new Date("2026-07-16T08:00:00Z");
    const config: XApiConfig = {
      enabled: true,
      sourceIds: ["first", "second"],
      maxPostReadsPerRun: 15,
      maxPostReadsPerDay: 100,
      maxPostReadsPerMonth: 1_000,
      maxCostUsdPerRun: 0.075,
      maxCostUsdPerDay: 1,
      maxCostUsdPerMonth: 10,
      maxPagesPerQuery: 1,
      costPerPostReadUsd: 0.005,
      failClosed: true,
    };
    const runUsage: XApiRunUsage = { postReads: 0, usd: 0 };
    let requests = 0;
    const fetcher = async (input: string | URL | Request) => {
      requests += 1;
      if (String(input).includes("/usage/tweets")) {
        return Response.json({
          data: { project_usage: 0, project_cap: 1_000 },
        });
      }
      return Response.json({
        data: Array.from({ length: 6 }, (_, index) => ({
          id: String(300 + index),
          text: `Post ${index}`,
          author_id: "42",
          created_at: "2026-07-16T07:00:00Z",
        })),
        meta: { result_count: 6, newest_id: "305" },
      });
    };
    const source = (id: string): SourceDefinition => ({
      id,
      name: id,
      type: "x",
      category: "official",
      weight: 1,
      handle: id,
    });

    expect(
      (
        await collectXApiSource({
          source: source("first"),
          config,
          dataDirectory: directory,
          outPath: join(directory, "inbox", "x.jsonl"),
          initialSince: new Date("2026-07-15T08:00:00Z"),
          now,
          runUsage,
          bearerToken: "test-token",
          fetcher,
        })
      ).status,
    ).toBe("collected");
    expect(
      (
        await collectXApiSource({
          source: source("second"),
          config,
          dataDirectory: directory,
          outPath: join(directory, "inbox", "x.jsonl"),
          initialSince: new Date("2026-07-15T08:00:00Z"),
          now,
          runUsage,
          bearerToken: "test-token",
          fetcher,
        })
      ).status,
    ).toBe("failed");
    expect(requests).toBe(2);
    expect(runUsage.postReads).toBe(6);
    expect(runUsage.circuitOpen).toBe("budget_exceeded");
  });

  test("limits an initial collection to one page", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-api-e2e-"));
    const now = new Date("2026-07-16T08:00:00Z");
    const config: XApiConfig = {
      enabled: true,
      sourceIds: ["openai"],
      maxPostReadsPerRun: 30,
      maxPostReadsPerDay: 100,
      maxPostReadsPerMonth: 1_000,
      maxCostUsdPerRun: 0.15,
      maxCostUsdPerDay: 1,
      maxCostUsdPerMonth: 10,
      maxPagesPerQuery: 3,
      costPerPostReadUsd: 0.005,
      failClosed: true,
    };
    const source: SourceDefinition = {
      id: "openai",
      name: "OpenAI",
      type: "x",
      category: "official",
      weight: 1,
      handle: "OpenAI",
    };
    let searchRequests = 0;
    const result = await collectXApiSource({
      source,
      config,
      dataDirectory: directory,
      outPath: join(directory, "inbox", "x.jsonl"),
      initialSince: new Date("2026-07-15T08:00:00Z"),
      now,
      runUsage: { postReads: 0, usd: 0 },
      bearerToken: "test-token",
      fetcher: async (input) => {
        if (String(input).includes("/usage/tweets")) {
          return Response.json({
            data: { project_usage: 0, project_cap: 1_000 },
          });
        }
        searchRequests += 1;
        return Response.json({
          data: [
            {
              id: "400",
              text: "Initial page",
              author_id: "42",
              created_at: "2026-07-16T07:00:00Z",
            },
          ],
          meta: {
            result_count: 1,
            newest_id: "400",
            next_token: `page-${searchRequests + 1}`,
          },
        });
      },
    });

    expect(result.status).toBe("collected");
    expect(searchRequests).toBe(1);
    expect(
      getCollectionCheckpoint(
        await loadState(join(directory, "state.json")),
        "x-api",
        source,
      )?.cursor,
    ).toStartWith("x-api-continuation:v1:");
  });
});
