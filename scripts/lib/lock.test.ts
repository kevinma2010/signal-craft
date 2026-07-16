import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, LockHeldError } from "./lock";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("run lock", () => {
  test("rejects an active lock", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-lock-"));
    const path = join(directory, "signalcraft.lock");
    const lock = await acquireRunLock(path, {
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(
      acquireRunLock(path, { now: new Date("2026-01-01T00:10:00.000Z") }),
    ).rejects.toBeInstanceOf(LockHeldError);
    await lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test("takes over a stale lock", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-lock-"));
    const path = join(directory, "signalcraft.lock");
    await writeFile(
      path,
      '{"pid":1,"started_at":"2026-01-01T00:00:00.000Z"}\n',
    );
    const lock = await acquireRunLock(path, {
      now: new Date("2026-01-01T00:31:00.000Z"),
    });
    await lock.release();
    expect(existsSync(path)).toBe(false);
  });
});
