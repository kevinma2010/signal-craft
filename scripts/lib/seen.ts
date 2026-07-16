import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readTextIfExists, writeTextAtomic } from "./files";
import type { SeenRecord } from "./types";
import { fingerprintUrl, normalizeUrl } from "./url";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export async function loadSeenRecords(
  path: string,
  now = new Date(),
): Promise<Map<string, SeenRecord>> {
  const text = await readTextIfExists(path);
  const records = new Map<string, SeenRecord>();
  let pruned = false;

  for (const line of text?.split("\n") ?? []) {
    if (!line.trim()) {
      continue;
    }
    const record = validateSeenRecord(JSON.parse(line));
    if (now.getTime() - Date.parse(record.first_seen) > RETENTION_MS) {
      pruned = true;
      continue;
    }
    records.set(record.id, record);
  }

  if (pruned) {
    const content = [...records.values()]
      .map((record) => JSON.stringify(record))
      .join("\n");
    await writeTextAtomic(path, content ? `${content}\n` : "");
  }
  return records;
}

export function hasSeen(
  records: ReadonlyMap<string, SeenRecord>,
  url: string,
): boolean {
  return records.has(fingerprintUrl(url));
}

export async function appendSeenUrls(
  path: string,
  records: Map<string, SeenRecord>,
  urls: readonly string[],
  now = new Date(),
): Promise<void> {
  const additions: SeenRecord[] = [];
  for (const url of urls) {
    const normalizedUrl = normalizeUrl(url);
    const id = fingerprintUrl(normalizedUrl);
    if (records.has(id)) {
      continue;
    }
    const record = {
      id,
      normalized_url: normalizedUrl,
      first_seen: now.toISOString(),
    };
    records.set(id, record);
    additions.push(record);
  }

  if (additions.length === 0) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${additions.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

function validateSeenRecord(data: unknown): SeenRecord {
  if (
    typeof data !== "object" ||
    data === null ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    !("normalized_url" in data) ||
    typeof data.normalized_url !== "string" ||
    !("first_seen" in data) ||
    typeof data.first_seen !== "string" ||
    Number.isNaN(Date.parse(data.first_seen))
  ) {
    throw new Error("Invalid seen.jsonl record");
  }
  return data as SeenRecord;
}
