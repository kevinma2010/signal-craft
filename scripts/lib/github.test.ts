import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AllGitHubSourcesFailedError, fetchGitHubSources } from "./github";
import { appendJsonLines, readJsonLines } from "./jsonl";
import type { NormalizedItem, SourceDefinition } from "./types";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

const repository: SourceDefinition = {
  id: "example-repo",
  name: "Example Repository",
  type: "github",
  category: "release",
  weight: 1,
  url: "https://github.com/example/project",
};

const release = {
  html_url: "https://github.com/example/project/releases/tag/v2.0.0",
  tag_name: "v2.0.0",
  name: "Version 2.0.0",
  body: "Release notes",
  published_at: "2026-07-15T10:00:00Z",
  prerelease: false,
  author: { login: "maintainer" },
};

const discussionEvent = {
  type: "DiscussionEvent",
  created_at: "2026-07-15T12:00:00Z",
  payload: {
    action: "created",
    discussion: {
      html_url: "https://github.com/example/project/discussions/42",
      title: "Roadmap update",
      body: "Maintainer context",
      created_at: "2026-07-15T12:00:00Z",
      author_association: "MEMBER",
      user: { login: "project-owner" },
      category: { name: "Announcements" },
    },
  },
};

function response(body: unknown, link?: string): Response {
  return Response.json(body, {
    headers: link ? { Link: link } : undefined,
  });
}

async function makePaths() {
  directory = await mkdtemp(join(tmpdir(), "signalcraft-github-"));
  return {
    outPath: join(directory, "inbox", "github.jsonl"),
    seenPath: join(directory, "seen.jsonl"),
  };
}

describe("fetchGitHubSources", () => {
  test("normalizes releases and maintainer discussions", async () => {
    const paths = await makePaths();
    const requested: string[] = [];
    const result = await fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-14T00:00:00Z"),
      ...paths,
      now: new Date("2026-07-16T00:00:00Z"),
      fetcher: async (input) => {
        const url = String(input);
        requested.push(url);
        return response(
          url.includes("/releases?")
            ? [release]
            : [
                discussionEvent,
                {
                  ...discussionEvent,
                  payload: {
                    ...discussionEvent.payload,
                    discussion: {
                      ...discussionEvent.payload.discussion,
                      html_url:
                        "https://github.com/example/project/discussions/43",
                      author_association: "NONE",
                    },
                  },
                },
              ],
        );
      },
    });

    expect(requested).toHaveLength(2);
    expect(result.items.map((item) => item.type)).toEqual(["release", "post"]);
    expect(result.items[0]?.title).toBe("Version 2.0.0");
    expect(result.items[1]?.author).toBe("project-owner");
    expect(result.items[1]?.extra).toEqual({
      author_association: "MEMBER",
      category: "Announcements",
      source_id: "example-repo",
      source_category: "release",
      source_weight: 1,
    });
  });

  test("follows pagination and filters since deterministically", async () => {
    const paths = await makePaths();
    const staged = {
      id: "staged",
      type: "release",
      source: repository.name,
      author: "maintainer",
      title: release.name,
      url: release.html_url,
      published_at: release.published_at,
      fetched_at: "2026-07-16T00:00:00Z",
      text: release.body,
      transcript_provider: "none",
      extra: {},
    } satisfies NormalizedItem;
    await appendJsonLines(paths.outPath, [staged]);
    const calls: string[] = [];
    const result = await fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-10T00:00:00Z"),
      ...paths,
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/events?")) {
          return response([]);
        }
        if (url.includes("page=2")) {
          return response([
            {
              ...release,
              html_url:
                "https://github.com/example/project/releases/tag/v1.0.0",
              published_at: "2026-07-09T00:00:00Z",
            },
          ]);
        }
        return response(
          [release],
          '<https://api.github.com/repos/example/project/releases?per_page=100&page=2>; rel="next"',
        );
      },
    });

    expect(calls.some((url) => url.includes("page=2"))).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(await readJsonLines<NormalizedItem>(paths.outPath)).toEqual([
      staged,
    ]);
  });

  test("preserves items but fails a source when one endpoint fails", async () => {
    const paths = await makePaths();
    const errors: string[] = [];
    const result = await fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-14T00:00:00Z"),
      ...paths,
      fetcher: async (input) =>
        String(input).includes("/events?")
          ? new Response("private details", { status: 403 })
          : response([release]),
      reportError: (message) => errors.push(message),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([
      { source: repository.id, error: "discussions: HTTP 403" },
    ]);
    expect(result.items).toHaveLength(1);
    expect(errors).toEqual(["Example Repository (discussions): HTTP 403"]);
    expect(errors.join(" ")).not.toContain("private details");
  });

  test("reports all endpoint failures and rejects total failure", async () => {
    const paths = await makePaths();
    const errors: string[] = [];
    const promise = fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-14T00:00:00Z"),
      ...paths,
      fetcher: async (input) =>
        String(input).includes("/events?")
          ? new Response(null, { status: 404 })
          : new Response(null, { status: 503 }),
      reportError: (message) => errors.push(message),
    });

    const error = await promise.catch((value) => value);
    expect(error).toBeInstanceOf(AllGitHubSourcesFailedError);
    expect(error.failed).toEqual([
      {
        source: repository.id,
        error: "releases: HTTP 503; discussions: HTTP 404",
      },
    ]);
    expect(errors).toHaveLength(2);
  });

  test("adds an optional token header without leaking it", async () => {
    const paths = await makePaths();
    const token = "github_pat_secret-value";
    const authorizations: string[] = [];
    await fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-14T00:00:00Z"),
      ...paths,
      token,
      fetcher: async (_input, init) => {
        authorizations.push(
          new Headers(init?.headers).get("Authorization") ?? "",
        );
        return response([]);
      },
    });

    expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    expect(JSON.stringify(await readJsonLines(paths.outPath))).not.toContain(
      token,
    );
  });

  test("redacts the token from failures", async () => {
    const paths = await makePaths();
    const token = "github_pat_secret-value";
    const errors: string[] = [];
    const error = await fetchGitHubSources({
      sources: [repository],
      since: new Date("2026-07-14T00:00:00Z"),
      ...paths,
      token,
      fetcher: async () => {
        throw new Error(`request rejected for ${token}`);
      },
      reportError: (message) => errors.push(message),
    }).catch((value) => value);

    expect(error).toBeInstanceOf(AllGitHubSourcesFailedError);
    expect(JSON.stringify(error.failed)).not.toContain(token);
    expect(errors.join(" ")).not.toContain(token);
    expect(errors.join(" ")).toContain("[REDACTED]");
  });
});
