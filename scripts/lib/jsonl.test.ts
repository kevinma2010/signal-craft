import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonLines } from "./jsonl";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("readJsonLines", () => {
  test("reports the exact malformed JSONL line", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-jsonl-"));
    const path = join(directory, "items.jsonl");
    await writeFile(path, '{"id":"valid"}\n\n{"id":\n');

    const error = await readJsonLines(path).catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Invalid JSONL at ${path}:3`);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });
});
