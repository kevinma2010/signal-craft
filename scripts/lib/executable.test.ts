import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "./executable";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("resolveExecutable", () => {
  test("finds executable tools outside the inherited PATH", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-executable-"));
    const executable = join(directory, "tool");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    expect(
      resolveExecutable("tool", {
        pathLookup: () => null,
        fallbackDirectories: [directory],
      }),
    ).toBe(executable);
  });

  test("returns undefined for a missing executable", () => {
    expect(
      resolveExecutable("missing", {
        pathLookup: () => null,
        fallbackDirectories: [],
      }),
    ).toBeUndefined();
  });
});
