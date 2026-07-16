import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonLines } from "./jsonl";
import {
  appendXApiUsage,
  loadXApiPriorUsage,
  reserveXApiUsage,
} from "./x-api-ledger";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("X API usage ledger", () => {
  test("aggregates UTC daily and monthly usage across runs", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-ledger-"));
    const path = join(directory, "usage.jsonl");
    await appendJsonLines(path, [
      record("2026-07-15T23:00:00Z", 10, 0.05),
      record("2026-07-16T01:00:00Z", 20, 0.1),
      record("2026-06-30T23:00:00Z", 50, 0.25),
    ]);

    expect(
      await loadXApiPriorUsage(path, new Date("2026-07-16T08:00:00Z")),
    ).toEqual({
      postReadsToday: 20,
      postReadsThisMonth: 30,
      usdToday: 0.1,
      usdThisMonth: 0.15,
    });
  });

  test("persists degraded billable usage and audit details", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-ledger-"));
    const path = join(directory, "usage.jsonl");
    await appendXApiUsage(
      path,
      {
        status: "degraded",
        reason: "response_anomaly",
        posts: [],
        cursors: {},
        usage: { postReads: 10, usd: 0.05 },
        audit: [
          {
            at: "2026-07-16T08:00:00Z",
            event: "circuit_breaker",
            detail: "invalid response",
          },
        ],
      },
      new Date("2026-07-16T08:00:00Z"),
    );

    expect(
      await loadXApiPriorUsage(path, new Date("2026-07-16T09:00:00Z")),
    ).toMatchObject({ postReadsToday: 10, usdToday: 0.05 });
  });

  test("fails closed on a malformed ledger", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-ledger-"));
    const path = join(directory, "usage.jsonl");
    await appendJsonLines(path, [{ at: "invalid", post_reads: -1 }]);
    await expect(loadXApiPriorUsage(path)).rejects.toThrow(
      "Invalid X API usage ledger",
    );
  });

  test("counts a pending reservation and reconciles it with actual usage", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-x-ledger-"));
    const path = join(directory, "usage.jsonl");
    const now = new Date("2026-07-16T08:00:00Z");
    await reserveXApiUsage(path, {
      id: "request-1",
      postReads: 10,
      usd: 0.05,
      at: now,
    });
    expect(await loadXApiPriorUsage(path, now)).toMatchObject({
      postReadsToday: 10,
      usdToday: 0.05,
    });

    await appendXApiUsage(
      path,
      {
        status: "ok",
        posts: [],
        cursors: {},
        usage: { postReads: 2, usd: 0.01 },
        audit: [],
      },
      now,
      "request-1",
    );
    expect(await loadXApiPriorUsage(path, now)).toMatchObject({
      postReadsToday: 2,
      usdToday: 0.01,
    });
  });
});

function record(at: string, postReads: number, usd: number) {
  return {
    at,
    status: "ok",
    post_reads: postReads,
    usd,
    audit: [],
  };
}
