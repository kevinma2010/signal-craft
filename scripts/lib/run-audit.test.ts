import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createItemAuditSummary,
  type RunAudit,
  readRunAudit,
  writeRunAudit,
} from "./run-audit";
import type { NormalizedItem } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function item(
  id: string,
  type: NormalizedItem["type"],
  text: string,
  contentStatus?: string,
): NormalizedItem {
  return {
    id,
    type,
    source: "Example",
    author: "Example",
    title: `Item ${id}`,
    url: `https://example.com/${id}`,
    published_at: "2026-07-16T00:00:00Z",
    fetched_at: "2026-07-16T01:00:00Z",
    text,
    transcript_provider: "none",
    extra: contentStatus ? { content_status: contentStatus } : {},
  };
}

function audit(): RunAudit {
  return {
    version: 1,
    run_id: "2026-07-16-daily",
    kind: "daily",
    status: "partial",
    started_at: "2026-07-16T06:04:04.000Z",
    finished_at: "2026-07-16T06:45:00.000Z",
    window: {
      from: "2026-07-15T06:04:04.000Z",
      to: "2026-07-16T06:04:04.000Z",
    },
    sources: {
      configured: 93,
      covered: 69,
      failed: [{ source_id: "openai-youtube", code: "feed_failed" }],
      unattempted: 18,
    },
    items: {
      archived: 45,
      selected: 8,
      by_type: { article: 7, post: 33, release: 3, podcast: 2 },
      x_posts: {
        total: 33,
        with_text: 33,
        content_status: { complete: 31, excerpt: 1, unknown: 1 },
      },
    },
    processing: {
      transcribed: 0,
      translated: 8,
      translation_cache_hits: 0,
      pre_summarized: 0,
    },
    paid_x_api: { requests: 0, post_reads: 0, estimated_usd: 0 },
    artifacts: { digest: "digests/2026-07-16.md" },
    degradation_codes: ["youtube_feed_failed", "grok_login_required"],
  };
}

describe("run audit", () => {
  test("summarizes X body completeness without copying content", () => {
    const summary = createItemAuditSummary([
      item("1", "post", "Complete body", "complete"),
      item("2", "post", "Partial body", "excerpt"),
      item("3", "post", "", "unknown"),
      item("4", "article", "Article body"),
    ]);

    expect(summary).toEqual({
      by_type: { article: 1, post: 3 },
      x_posts: {
        total: 3,
        with_text: 2,
        content_status: { complete: 1, excerpt: 1, unknown: 1 },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("Complete body");
  });

  test("writes an immutable validated audit record", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-run-audit-"));
    const record = audit();
    const path = await writeRunAudit(directory, record);

    expect(path).toBe(join(directory, "runs", `${record.run_id}.json`));
    expect(await readRunAudit(path)).toEqual(record);
    await expect(writeRunAudit(directory, record)).rejects.toThrow(
      "already exists",
    );
  });

  test("rejects unsafe ids and program-log fields", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-run-audit-"));
    await expect(
      writeRunAudit(directory, { ...audit(), run_id: "../escape" }),
    ).rejects.toThrow("run_id");
    await expect(
      writeRunAudit(directory, {
        ...audit(),
        stdout: "process details",
      } as RunAudit),
    ).rejects.toThrow("fields");
  });
});
