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
        extra: { likes: 10 },
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
