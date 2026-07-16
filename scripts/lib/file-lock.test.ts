import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("withFileLock", () => {
  test("serializes concurrent mutations", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-file-lock-"));
    const path = join(directory, "state.lock");
    const order: string[] = [];
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = withFileLock(path, async () => {
      order.push("first:start");
      signalStarted?.();
      await Bun.sleep(30);
      order.push("first:end");
    });
    await started;
    const second = withFileLock(path, async () => {
      order.push("second");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("does not take over a live lock during a long action", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-file-lock-"));
    const path = join(directory, "state.lock");
    const order: string[] = [];
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = withFileLock(
      path,
      async () => {
        order.push("first:start");
        signalStarted?.();
        await Bun.sleep(120);
        order.push("first:end");
      },
      { staleMs: 40 },
    );

    await started;
    const second = withFileLock(
      path,
      async () => {
        order.push("second");
      },
      { staleMs: 40, timeoutMs: 300 },
    );

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("does not remove a replacement lock when the old owner releases", async () => {
    directory = await mkdtemp(join(tmpdir(), "signalcraft-file-lock-"));
    const path = join(directory, "state.lock");
    const replacement = JSON.stringify({
      owner_id: "replacement",
      pid: process.pid,
      created_at: new Date().toISOString(),
    });

    const holder = withFileLock(path, async () => {
      await unlink(path);
      await writeFile(path, replacement);
    });

    await holder;
    expect(await readFile(path, "utf8")).toBe(replacement);
  });
});
