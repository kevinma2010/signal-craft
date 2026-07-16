import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "./files";

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;

interface LockData {
  pid: number;
  started_at: string;
}

export class LockHeldError extends Error {
  constructor(readonly lock: LockData) {
    super(
      `SignalCraft run already started at ${lock.started_at} by process ${lock.pid}`,
    );
    this.name = "LockHeldError";
  }
}

export interface RunLock {
  release(): Promise<void>;
}

export async function acquireRunLock(
  path: string,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<RunLock> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = { pid: process.pid, started_at: now.toISOString() };
    try {
      const file = await open(path, "wx");
      await file.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await file.close();
      return {
        async release() {
          const current = await readLock(path);
          if (
            current &&
            current.pid === data.pid &&
            current.started_at === data.started_at
          ) {
            await unlink(path);
          }
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const existing = await readLock(path);
      if (
        !existing ||
        now.getTime() - Date.parse(existing.started_at) <= staleAfterMs
      ) {
        throw new LockHeldError(existing ?? { pid: -1, started_at: "unknown" });
      }
      await unlink(path);
    }
  }
  throw new Error(`Unable to acquire lock: ${path}`);
}

async function readLock(path: string): Promise<LockData | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof data !== "object" ||
      data === null ||
      !("pid" in data) ||
      typeof data.pid !== "number" ||
      !("started_at" in data) ||
      typeof data.started_at !== "string" ||
      Number.isNaN(Date.parse(data.started_at))
    ) {
      return undefined;
    }
    return data as LockData;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
