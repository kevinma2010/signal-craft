import { describe, expect, test } from "bun:test";
import {
  createXApiContinuationCursor,
  DEFAULT_X_API_COST_PER_POST_USD,
  type FetchXApiOptions,
  fetchXApiPosts,
  isXApiContinuationCursor,
  parseXApiContinuationCursor,
  type XApiBudgetLimits,
  type XApiFetcher,
} from "./x-api";

const limits: XApiBudgetLimits = {
  maxPostReadsPerRun: 20,
  maxPostReadsPerDay: 40,
  maxPostReadsPerMonth: 200,
  maxUsdPerRun: 0.1,
  maxUsdPerDay: 0.2,
  maxUsdPerMonth: 1,
};

const source = {
  id: "openai",
  query: "from:OpenAI -is:retweet",
  sinceId: "100",
  maxResults: 10,
};

function usage(projectUsage = 20, projectCap = 1_000): Response {
  return Response.json({
    data: { project_usage: projectUsage, project_cap: projectCap },
  });
}

function search(
  ids: readonly string[],
  meta: Record<string, unknown> = {},
): Response {
  return Response.json({
    data: ids.map((id) => ({
      id,
      text: `Post ${id}`,
      author_id: "42",
      created_at: "2026-07-16T00:00:00Z",
    })),
    meta: { result_count: ids.length, ...meta },
  });
}

function options(
  fetcher: XApiFetcher,
  overrides: Partial<FetchXApiOptions> = {},
): FetchXApiOptions {
  return {
    enabled: true,
    bearerToken: "secret-token",
    sources: [source],
    limits,
    fetcher,
    clock: () => new Date("2026-07-16T08:00:00Z"),
    ...overrides,
  };
}

describe("fetchXApiPosts", () => {
  test("rejects malformed or backwards continuation cursors", () => {
    expect(isXApiContinuationCursor("x-api-continuation:v1:not-base64")).toBe(
      false,
    );
    expect(() =>
      createXApiContinuationCursor({
        sinceId: "100",
        paginationToken: "page-2",
        pendingNewestId: "99",
      }),
    ).toThrow("pendingNewestId cannot precede sinceId");
  });

  test("is disabled by default without making a request", async () => {
    let calls = 0;
    const result = await fetchXApiPosts({
      sources: [source],
      limits,
      fetcher: async () => {
        calls += 1;
        throw new Error("unexpected request");
      },
    });

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("disabled");
    expect(result.cursors).toEqual({ openai: "100" });
    expect(calls).toBe(0);
  });

  test("requires X_BEARER_TOKEN without making a request", async () => {
    let calls = 0;
    const previous = process.env.X_BEARER_TOKEN;
    delete process.env.X_BEARER_TOKEN;
    try {
      const result = await fetchXApiPosts(
        options(
          async () => {
            calls += 1;
            throw new Error("unexpected request");
          },
          { bearerToken: undefined },
        ),
      );
      expect(result.reason).toBe("missing_token");
      expect(calls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.X_BEARER_TOKEN;
      else process.env.X_BEARER_TOKEN = previous;
    }
  });

  test("fails closed when options are invalid", async () => {
    let calls = 0;
    const result = await fetchXApiPosts(
      options(
        async () => {
          calls += 1;
          throw new Error("unexpected request");
        },
        { maxPages: 0 },
      ),
    );

    expect(result.reason).toBe("invalid_options");
    expect(calls).toBe(0);
  });

  test("requires a successful usage preflight before search", async () => {
    const urls: string[] = [];
    const result = await fetchXApiPosts(
      options(async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 503 });
      }),
    );

    expect(result.reason).toBe("preflight_failed");
    expect(urls).toEqual(["https://api.x.com/2/usage/tweets"]);
  });

  test("circuits on malformed or over-cap usage", async () => {
    for (const response of [
      Response.json({ data: { project_usage: "20", project_cap: 100 } }),
      usage(101, 100),
    ]) {
      let calls = 0;
      const result = await fetchXApiPosts(
        options(async () => {
          calls += 1;
          return response.clone();
        }),
      );
      expect(result.reason).toBe("usage_anomaly");
      expect(calls).toBe(1);
    }
  });

  test("reserves worst-case reads and rejects every local budget guard", async () => {
    const cases: Array<Partial<FetchXApiOptions>> = [
      { limits: { ...limits, maxPostReadsPerRun: 9 } },
      {
        priorUsage: { postReadsToday: 35, postReadsThisMonth: 35 },
        limits: { ...limits, maxPostReadsPerDay: 40 },
      },
      {
        priorUsage: { postReadsToday: 0, postReadsThisMonth: 195 },
      },
      { limits: { ...limits, maxUsdPerRun: 0.049 } },
      {
        priorUsage: { usdToday: 0.16, usdThisMonth: 0.16 },
      },
      {
        priorUsage: { usdToday: 0, usdThisMonth: 0.96 },
      },
    ];

    for (const overrides of cases) {
      let calls = 0;
      const result = await fetchXApiPosts(
        options(async () => {
          calls += 1;
          return usage();
        }, overrides),
      );
      expect(result.reason).toBe("budget_exceeded");
      expect(result.usage.postReads).toBe(0);
      expect(calls).toBe(1);
    }
  });

  test("rejects a request that could exceed the X project cap", async () => {
    let calls = 0;
    const result = await fetchXApiPosts(
      options(async () => {
        calls += 1;
        return usage(95, 100);
      }),
    );

    expect(result.reason).toBe("budget_exceeded");
    expect(calls).toBe(1);
  });

  test("uses since_id, omits expansions, reconciles reads, and updates cursor", async () => {
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const result = await fetchXApiPosts(
      options(async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return url.pathname.endsWith("/usage/tweets")
          ? usage()
          : search(["101", "102"], { newest_id: "102" });
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.posts.map((post) => post.id)).toEqual(["101", "102"]);
    expect(result.cursors).toEqual({ openai: "102" });
    expect(result.usage).toEqual({
      postReads: 2,
      usd: 2 * DEFAULT_X_API_COST_PER_POST_USD,
    });
    expect(requests).toHaveLength(2);
    const searchRequest = requests[1];
    expect(searchRequest?.url.searchParams.get("since_id")).toBe("100");
    expect(searchRequest?.url.searchParams.get("max_results")).toBe("10");
    expect(searchRequest?.url.searchParams.has("expansions")).toBe(false);
    expect(searchRequest?.authorization).toBe("Bearer secret-token");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("uses a bounded start_time before the first cursor exists", async () => {
    let searchUrl: URL | undefined;
    const result = await fetchXApiPosts(
      options(
        async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/usage/tweets")) return usage();
          searchUrl = url;
          return search(["101"], { newest_id: "101" });
        },
        {
          sources: [
            {
              id: "openai",
              query: "from:OpenAI -is:retweet",
              startTime: "2026-07-15T08:00:00Z",
              maxResults: 10,
            },
          ],
        },
      ),
    );

    expect(result.status).toBe("ok");
    expect(searchUrl?.searchParams.has("since_id")).toBe(false);
    expect(searchUrl?.searchParams.get("start_time")).toBe(
      "2026-07-15T08:00:00.000Z",
    );
    expect(result.cursors).toEqual({ openai: "101" });
  });

  test("defaults to one page even when X returns a next token", async () => {
    let calls = 0;
    const result = await fetchXApiPosts(
      options(async (input) => {
        calls += 1;
        return String(input).includes("/usage/tweets")
          ? usage()
          : search(["101"], { newest_id: "101", next_token: "next" });
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.posts).toHaveLength(1);
    const cursor = result.cursors.openai ?? "";
    expect(isXApiContinuationCursor(cursor)).toBe(true);
    expect(parseXApiContinuationCursor(cursor)).toEqual({
      sinceId: "100",
      paginationToken: "next",
      pendingNewestId: "101",
    });
    expect(calls).toBe(2);
  });

  test("resumes an unfinished page without advancing since_id", async () => {
    const continuation = createXApiContinuationCursor({
      sinceId: "100",
      paginationToken: "page-2",
      pendingNewestId: "110",
    });
    let searchUrl: URL | undefined;
    const result = await fetchXApiPosts(
      options(
        async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/usage/tweets")) return usage();
          searchUrl = url;
          return search(["105"], { newest_id: "105" });
        },
        {
          sources: [
            {
              ...source,
              sinceId: undefined,
              continuation: parseXApiContinuationCursor(continuation),
            },
          ],
        },
      ),
    );

    expect(searchUrl?.searchParams.get("since_id")).toBe("100");
    expect(searchUrl?.searchParams.get("pagination_token")).toBe("page-2");
    expect(result.posts.map((post) => post.id)).toEqual(["105"]);
    expect(result.cursors).toEqual({ openai: "110" });
  });

  test("preserves paid posts and continuation when a later page fails", async () => {
    let searchCalls = 0;
    const result = await fetchXApiPosts(
      options(
        async (input) => {
          if (String(input).includes("/usage/tweets")) return usage();
          searchCalls += 1;
          if (searchCalls === 1) {
            return search(["101", "102"], {
              newest_id: "102",
              next_token: "page-2",
            });
          }
          return new Response(null, { status: 429 });
        },
        {
          maxPages: 2,
          limits: {
            ...limits,
            maxPostReadsPerRun: 30,
            maxUsdPerRun: 0.2,
          },
        },
      ),
    );

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("rate_limited");
    expect(result.posts.map((post) => post.id)).toEqual(["101", "102"]);
    expect(parseXApiContinuationCursor(result.cursors.openai ?? "")).toEqual({
      sinceId: "100",
      paginationToken: "page-2",
      pendingNewestId: "102",
    });
  });

  test("resumes again after a partial failure without skipping pages", async () => {
    const firstRun = await fetchXApiPosts(
      options(async (input) => {
        if (String(input).includes("/usage/tweets")) return usage();
        return search(["110"], {
          newest_id: "110",
          next_token: "page-2",
        });
      }),
    );
    const continuation = parseXApiContinuationCursor(
      firstRun.cursors.openai ?? "",
    );
    const requestedTokens: Array<string | null> = [];
    const secondRun = await fetchXApiPosts(
      options(
        async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/usage/tweets")) return usage();
          requestedTokens.push(url.searchParams.get("pagination_token"));
          return search(["109"], { newest_id: "109" });
        },
        {
          sources: [{ ...source, sinceId: undefined, continuation }],
        },
      ),
    );

    expect(requestedTokens).toEqual(["page-2"]);
    expect(secondRun.cursors.openai).toBe("110");
  });

  test("degrades when pagination does not advance", async () => {
    const continuation = createXApiContinuationCursor({
      sinceId: "100",
      paginationToken: "page-2",
      pendingNewestId: "110",
    });
    const result = await fetchXApiPosts(
      options(
        async (input) =>
          String(input).includes("/usage/tweets")
            ? usage()
            : search(["109"], {
                newest_id: "109",
                next_token: "page-2",
              }),
        {
          sources: [
            {
              ...source,
              sinceId: undefined,
              continuation: parseXApiContinuationCursor(continuation),
            },
          ],
        },
      ),
    );

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("response_anomaly");
    expect(result.cursors.openai).toBe(continuation);
  });

  test("uses bounded pagination and reserves before every page", async () => {
    const urls: string[] = [];
    const result = await fetchXApiPosts(
      options(
        async (input) => {
          const url = String(input);
          urls.push(url);
          if (url.includes("/usage/tweets")) return usage();
          if (url.includes("pagination_token")) {
            return search(["102"], { newest_id: "102", next_token: "ignored" });
          }
          return search(["101"], { newest_id: "101", next_token: "page-2" });
        },
        {
          maxPages: 2,
          limits: {
            ...limits,
            maxPostReadsPerRun: 30,
            maxUsdPerRun: 0.2,
          },
        },
      ),
    );

    expect(result.status).toBe("ok");
    expect(result.posts.map((post) => post.id)).toEqual(["101", "102"]);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[2] ?? "").searchParams.get("pagination_token")).toBe(
      "page-2",
    );
    expect(
      result.audit.filter((entry) => entry.event === "reservation"),
    ).toHaveLength(2);
  });

  test("does not request a second page when its reservation exceeds budget", async () => {
    let calls = 0;
    const result = await fetchXApiPosts(
      options(
        async (input) => {
          calls += 1;
          return String(input).includes("/usage/tweets")
            ? usage()
            : search(
                Array.from({ length: 6 }, (_, index) => String(101 + index)),
                { newest_id: "106", next_token: "page-2" },
              );
        },
        {
          maxPages: 2,
          limits: { ...limits, maxPostReadsPerRun: 15 },
        },
      ),
    );

    expect(result.reason).toBe("budget_exceeded");
    expect(result.usage.postReads).toBe(6);
    expect(parseXApiContinuationCursor(result.cursors.openai ?? "")).toEqual({
      sinceId: "100",
      paginationToken: "page-2",
      pendingNewestId: "106",
    });
    expect(calls).toBe(2);
  });

  test("circuits on auth and rate-limit responses without retrying", async () => {
    for (const [status, reason] of [
      [401, "auth_failed"],
      [403, "auth_failed"],
      [429, "rate_limited"],
    ] as const) {
      let calls = 0;
      const result = await fetchXApiPosts(
        options(async (input) => {
          calls += 1;
          return String(input).includes("/usage/tweets")
            ? usage()
            : new Response(null, { status });
        }),
      );
      expect(result.reason).toBe(reason);
      expect(calls).toBe(2);
    }
  });

  test("conservatively reserves reads when search transport fails", async () => {
    let calls = 0;
    const result = await fetchXApiPosts(
      options(async (input) => {
        calls += 1;
        if (String(input).includes("/usage/tweets")) return usage();
        throw new Error("connection reset after request");
      }),
    );

    expect(result.reason).toBe("search_failed");
    expect(result.usage).toEqual({ postReads: 10, usd: 0.05 });
    expect(calls).toBe(2);
  });

  test("circuits on response anomalies and does not advance the cursor", async () => {
    const anomalousResponses = [
      Response.json({
        data: [{ id: "101", text: "Post" }],
        meta: { result_count: 2 },
      }),
      Response.json({
        data: [{ id: "bad", text: "Post" }],
        meta: { result_count: 1 },
      }),
      search(["101"], { newest_id: "99" }),
      search(["101"], { next_token: "page-2" }),
    ];

    for (const response of anomalousResponses) {
      let calls = 0;
      const result = await fetchXApiPosts(
        options(async (input) => {
          calls += 1;
          return String(input).includes("/usage/tweets")
            ? usage()
            : response.clone();
        }),
      );
      expect(result.reason).toBe("response_anomaly");
      expect(result.cursors).toEqual({ openai: "100" });
      expect(result.usage.postReads).toBe(1);
      expect(calls).toBe(2);
    }
  });

  test("does not retry a successful billable response", async () => {
    let searchCalls = 0;
    const result = await fetchXApiPosts(
      options(async (input) => {
        if (String(input).includes("/usage/tweets")) return usage();
        searchCalls += 1;
        return search(["101"], { newest_id: "101" });
      }),
    );

    expect(result.status).toBe("ok");
    expect(searchCalls).toBe(1);
  });
});
