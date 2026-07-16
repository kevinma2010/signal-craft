import { join } from "node:path";
import { appendJsonLines, readJsonLines } from "./jsonl";
import { appendSeenUrls, loadSeenRecords } from "./seen";
import type { NormalizedItem } from "./types";

export async function archiveProcessedItems(
  dataDirectory: string,
  items: readonly NormalizedItem[],
  archivedAt = new Date(),
): Promise<number> {
  const archivePath = join(
    dataDirectory,
    "items",
    `${archivedAt.toISOString().slice(0, 7)}.jsonl`,
  );
  const archived = await readJsonLines<NormalizedItem>(archivePath);
  const archivedIds = new Set(archived.map((item) => item.id));
  const additions = items.filter((item) => !archivedIds.has(item.id));
  await appendJsonLines(archivePath, additions);

  const seenPath = join(dataDirectory, "seen.jsonl");
  const seen = await loadSeenRecords(seenPath, archivedAt);
  await appendSeenUrls(
    seenPath,
    seen,
    items.map((item) => item.url),
    archivedAt,
  );
  return additions.length;
}
