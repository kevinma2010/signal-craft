import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDefinition } from "./types";
import { fetchXSources, type SubprocessRunner } from "./x";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

const source: SourceDefinition = {
  id: "example-x",
  name: "Example on X",
  type: "x",
  category: "builder",
  weight: 1,
  handle: "example",
};

function validOutput(publishedAt = "2026-01-15T10:00:00Z"): string {
  return JSON.stringify({
    items: [
      {
        id: "agent-generated-id",
        type: "post",
        source: "Example on X",
        author: "@example",
        title: "A useful update",
        url: "https://x.com/example/status/123?utm_source=test",
        published_at: publishedAt,
        fetched_at: "2026-01-16T00:00:00Z",
        text: "Technical details with evidence.",
        transcript_provider: "none",
        extra: { likes: 10, content_status: "complete" },
      },
    ],
  });
}

async function paths() {
  directory = await mkdtemp(join(tmpdir(), "signalcraft-x-"));
  return {
    outPath: join(directory, "inbox", "x.jsonl"),
    seenPath: join(directory, "seen.jsonl"),
  };
}

describe("fetchXSources", () => {
  test("collects normalized posts with schema arguments", async () => {
    const pathOptions = await paths();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: SubprocessRunner = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: validOutput(), stderr: "" };
    };

    const result = await fetchXSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner,
      ...pathOptions,
    });

    expect(result.items).toHaveLength(1);
    expect(result.succeeded).toEqual([source.id]);
    expect(result.items[0]?.extra.source_id).toBe(source.id);
    expect(result.items[0]?.extra.content_status).toBe("complete");
    expect(calls[0]?.command).toBe("grok");
    expect(calls[0]?.args).toContain("-p");
    expect(calls[0]?.args).toContain("--json-schema");
  });

  test("reads structured output from the Grok CLI envelope", async () => {
    const pathOptions = await paths();
    const runner: SubprocessRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        text: validOutput(),
        stopReason: "EndTurn",
        structuredOutput: JSON.parse(validOutput()),
      }),
      stderr: "",
    });

    const result = await fetchXSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner,
      ...pathOptions,
    });

    expect(result.items).toHaveLength(1);
    expect(result.succeeded).toEqual([source.id]);
  });

  test("uses an exact topic query and result limit in the prompt", async () => {
    const pathOptions = await paths();
    let prompt = "";
    const runner: SubprocessRunner = async (_command, args) => {
      const promptIndex = args.indexOf("-p");
      prompt = args[promptIndex + 1] ?? "";
      const payload = JSON.parse(validOutput()) as {
        items: Array<Record<string, unknown>>;
      };
      payload.items.push({
        ...payload.items[0],
        url: "https://x.com/example/status/456",
      });
      return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
    };

    const result = await fetchXSources({
      sources: [
        {
          id: "topic-coding-agents",
          name: "Coding agents",
          type: "x",
          category: "topic",
          weight: 1.2,
          query: '("Claude Code" OR Codex) -is:retweet lang:en',
          maxResults: 1,
        },
      ],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      ...pathOptions,
    });

    expect(prompt).toContain(
      'Use this exact X search query: ("Claude Code" OR Codex) -is:retweet lang:en',
    );
    expect(prompt).toContain("Return at most 1 item");
    expect(prompt).not.toContain("expand topic discovery");
    expect(result.items).toHaveLength(1);
  });

  test("strictly limits handle searches and requests verbatim content", async () => {
    const pathOptions = await paths();
    let prompt = "";
    const runner: SubprocessRunner = async (_command, args) => {
      prompt = args[args.indexOf("-p") + 1] ?? "";
      return { exitCode: 0, stdout: validOutput(), stderr: "" };
    };

    await fetchXSources({
      sources: [{ ...source, handle: "@ExAmPlE" }],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      ...pathOptions,
    });

    expect(prompt).toContain("only for posts authored by @example");
    expect(prompt).toContain("exact author filter from:example");
    expect(prompt).toContain("Do not include posts merely mentioning");
    expect(prompt).toContain("full verbatim post body");
    expect(prompt).toContain(
      "never silently summarize, rewrite, or paraphrase",
    );
    expect(prompt).not.toContain("related people, products, and repositories");
  });

  test("accepts normalized handle author and canonical URL casing", async () => {
    const pathOptions = await paths();
    const payload = JSON.parse(validOutput()) as {
      items: Array<Record<string, unknown>>;
    };
    payload.items[0] = {
      ...payload.items[0],
      author: "EXAMPLE",
      url: "https://x.com/ExAmPlE/status/123",
    };

    const result = await fetchXSources({
      sources: [{ ...source, handle: "@example" }],
      since: new Date("2026-01-01T00:00:00Z"),
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: "",
      }),
      ...pathOptions,
    });

    expect(result.items).toHaveLength(1);
  });

  test.each([
    ["wrong author", { author: "@other" }],
    ["wrong URL handle", { url: "https://x.com/other/status/123" }],
  ])("rejects handle posts with %s", async (_label, override) => {
    const pathOptions = await paths();
    const payload = JSON.parse(validOutput()) as {
      items: Array<Record<string, unknown>>;
    };
    payload.items[0] = { ...payload.items[0], ...override };
    let calls = 0;

    await expect(
      fetchXSources({
        sources: [source],
        since: new Date("2026-01-01T00:00:00Z"),
        runner: async () => {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify(payload),
            stderr: "",
          };
        },
        ...pathOptions,
      }),
    ).rejects.toThrow("All X sources failed");
    expect(calls).toBe(2);
  });

  test("rejects missing or invalid content status", async () => {
    const pathOptions = await paths();
    const payload = JSON.parse(validOutput()) as {
      items: Array<{ extra: Record<string, unknown> }>;
    };
    const [item] = payload.items;
    if (!item) throw new Error("Expected test fixture item");
    item.extra.content_status = "partial";

    await expect(
      fetchXSources({
        sources: [source],
        since: new Date("2026-01-01T00:00:00Z"),
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(payload),
          stderr: "",
        }),
        ...pathOptions,
      }),
    ).rejects.toThrow("All X sources failed");
  });

  test("does not repeat a completed search window", async () => {
    const pathOptions = await paths();
    let calls = 0;
    const runner: SubprocessRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: validOutput(), stderr: "" };
    };
    const options = {
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner,
      ...pathOptions,
    };

    await fetchXSources(options);
    const second = await fetchXSources(options);

    expect(calls).toBe(1);
    expect(second.items).toEqual([]);
    expect(second.succeeded).toEqual([source.id]);
  });

  test("continues from the previous successful cursor", async () => {
    const pathOptions = await paths();
    const prompts: string[] = [];
    const runner: SubprocessRunner = async (_command, args) => {
      prompts.push(args[args.indexOf("-p") + 1] ?? "");
      return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    };
    const options = {
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      ...pathOptions,
    };

    await fetchXSources({
      ...options,
      now: new Date("2026-01-16T00:00:00Z"),
    });
    await fetchXSources({
      ...options,
      now: new Date("2026-01-17T00:00:00Z"),
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "published after 2026-01-16T00:00:00.000Z and through 2026-01-17T00:00:00.000Z",
    );
  });

  test("shares a cursor between duplicate search definitions", async () => {
    const pathOptions = await paths();
    let calls = 0;
    const result = await fetchXSources({
      sources: [source, { ...source, id: "duplicate-x" }],
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ items: [] }),
          stderr: "",
        };
      },
      ...pathOptions,
    });

    expect(calls).toBe(1);
    expect(result.succeeded).toEqual([source.id, "duplicate-x"]);
  });

  test("searches again when the query configuration changes", async () => {
    const pathOptions = await paths();
    let calls = 0;
    const runner: SubprocessRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    };
    const base = {
      id: "topic-agents",
      name: "Agents",
      type: "x" as const,
      category: "topic",
      weight: 1,
      maxResults: 10,
    };
    const options = {
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner,
      ...pathOptions,
    };

    await fetchXSources({
      ...options,
      sources: [{ ...base, query: "agent engineering lang:en" }],
    });
    await fetchXSources({
      ...options,
      sources: [{ ...base, query: "coding agents lang:en" }],
    });

    expect(calls).toBe(2);
  });

  test("advances successful sources while retrying failed sources", async () => {
    const pathOptions = await paths();
    const calls = new Map<string, number>();
    const runner: SubprocessRunner = async (_command, args) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      const handle = prompt.includes("@example") ? "example" : "broken";
      calls.set(handle, (calls.get(handle) ?? 0) + 1);
      return handle === "example"
        ? { exitCode: 0, stdout: validOutput(), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "temporary failure" };
    };
    const options = {
      sources: [
        source,
        { ...source, id: "broken-x", name: "Broken", handle: "broken" },
      ],
      since: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-16T00:00:00Z"),
      runner,
      ...pathOptions,
    };

    await fetchXSources(options);
    await fetchXSources(options);

    expect(calls).toEqual(
      new Map([
        ["example", 1],
        ["broken", 2],
      ]),
    );
  });

  test("retries malformed structured output exactly once", async () => {
    const pathOptions = await paths();
    let calls = 0;
    const runner: SubprocessRunner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: calls === 1 ? "not-json" : validOutput(),
        stderr: "",
      };
    };

    const result = await fetchXSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      ...pathOptions,
    });

    expect(result.items).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("fails after two malformed structured outputs", async () => {
    const pathOptions = await paths();
    let calls = 0;
    const runner: SubprocessRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    await expect(
      fetchXSources({
        sources: [source],
        since: new Date("2026-01-01T00:00:00Z"),
        runner,
        ...pathOptions,
      }),
    ).rejects.toThrow("All X sources failed");
    expect(calls).toBe(2);
  });

  test("fails a source when the Grok query exceeds its timeout", async () => {
    const pathOptions = await paths();
    const runner: SubprocessRunner = async () =>
      await new Promise<never>(() => undefined);
    const options = {
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      grokTimeoutMs: 10,
      ...pathOptions,
    };

    await expect(fetchXSources(options)).rejects.toThrow(
      "All X sources failed",
    );
  }, 100);

  test("degrades with instructions when the CLI is missing", async () => {
    const pathOptions = await paths();
    const errors: string[] = [];
    const runner: SubprocessRunner = async () => {
      const error = new Error("spawn failed") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    };

    const result = await fetchXSources({
      sources: [source],
      since: new Date("2026-01-01T00:00:00Z"),
      runner,
      reportError: (message) => errors.push(message),
      ...pathOptions,
    });

    expect(result.degraded).toContain("x.ai/cli/install.sh");
    expect(result.failed).toEqual([
      { source: source.id, error: "Grok Build CLI is not installed" },
    ]);
    expect(errors[0]).toContain("grok login");
  });
});
