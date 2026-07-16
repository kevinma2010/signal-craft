import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface FileLockData {
  owner_id: string;
  pid: number;
  created_at: string;
}

export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const ownerId = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(path, "wx");
      await handle.writeFile(
        JSON.stringify({
          owner_id: ownerId,
          pid: process.pid,
          created_at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStale(path, staleMs)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file lock: ${path}`);
      }
      await Bun.sleep(20);
    }
  }

  let heartbeatRunning = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      const now = new Date();
      void handle
        .utimes(now, now)
        .catch(() => undefined)
        .finally(() => {
          heartbeatRunning = false;
        });
    },
    Math.max(1, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();

  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await handle.close();
    if ((await readLock(path))?.owner_id === ownerId) {
      await unlink(path).catch(() => undefined);
    }
  }
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<FileLockData | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof data !== "object" ||
      data === null ||
      !("owner_id" in data) ||
      typeof data.owner_id !== "string" ||
      !("pid" in data) ||
      typeof data.pid !== "number" ||
      !("created_at" in data) ||
      typeof data.created_at !== "string"
    ) {
      return undefined;
    }
    return data as FileLockData;
  } catch {
    return undefined;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
