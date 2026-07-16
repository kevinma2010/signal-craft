import { describe, expect, test } from "bun:test";
import type { SourceDefinition } from "./types";
import { createXApiContinuationCursor } from "./x-api";
import { createXApiSource, normalizeXApiPost } from "./x-api-normalize";

const account: SourceDefinition = {
  id: "openai",
  name: "OpenAI",
  type: "x",
  category: "official",
  weight: 1,
  handle: "@OpenAI",
};

describe("X API normalization", () => {
  test("creates a strict account query with a bounded initial window", () => {
    expect(
      createXApiSource(account, {
        startTime: new Date("2026-07-15T08:00:00Z"),
      }),
    ).toEqual({
      id: "openai",
      query: "from:OpenAI -is:retweet",
      startTime: "2026-07-15T08:00:00.000Z",
      maxResults: 10,
    });
  });

  test("uses since_id after the first successful collection", () => {
    expect(
      createXApiSource(account, {
        sinceId: "123",
        startTime: new Date("2026-07-15T08:00:00Z"),
      }),
    ).toMatchObject({ sinceId: "123" });
  });

  test("restores an opaque pagination continuation", () => {
    const cursor = createXApiContinuationCursor({
      startTime: "2026-07-15T08:00:00.000Z",
      paginationToken: "page-2",
      pendingNewestId: "123",
    });

    expect(
      createXApiSource(account, {
        sinceId: cursor,
        startTime: new Date("2026-07-16T08:00:00Z"),
      }),
    ).toMatchObject({
      continuation: {
        startTime: "2026-07-15T08:00:00.000Z",
        paginationToken: "page-2",
        pendingNewestId: "123",
      },
    });
  });

  test("normalizes raw API text as complete evidence", () => {
    const item = normalizeXApiPost(
      {
        id: "123",
        text: "Full post body",
        authorId: "42",
        createdAt: "2026-07-16T07:00:00Z",
        sourceId: "openai",
      },
      account,
      new Date("2026-07-16T08:00:00Z"),
    );

    expect(item).toMatchObject({
      author: "@OpenAI",
      url: "https://x.com/OpenAI/status/123",
      text: "Full post body",
      extra: {
        content_status: "complete",
        x_post_id: "123",
        source_id: "openai",
      },
    });
  });
});
