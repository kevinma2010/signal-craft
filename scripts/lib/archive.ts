import { join } from "node:path";
import { appendJsonLines, readJsonLines } from "./jsonl";
import { appendSeenUrls, hasSeen, loadSeenRecords } from "./seen";
import type { NormalizedItem } from "./types";
import { normalizeUrl } from "./url";

export interface ArchiveWindow {
  from: Date;
  to: Date;
}

export async function readArchivedItems(
  dataDirectory: string,
  window: ArchiveWindow,
): Promise<NormalizedItem[]> {
  assertValidWindow(window);

  const items = (
    await Promise.all(
      archiveMonths(window).map((month) =>
        readJsonLines<NormalizedItem>(
          join(dataDirectory, "items", `${month}.jsonl`),
        ),
      ),
    )
  )
    .flat()
    .filter((item) => {
      const publishedAt = new Date(item.published_at).getTime();
      return (
        publishedAt >= window.from.getTime() &&
        publishedAt < window.to.getTime()
      );
    })
    .sort(compareArchivedItems);

  const ids = new Set<string>();
  const urls = new Set<string>();
  return items.filter((item) => {
    const url = normalizeUrl(item.url);
    const duplicate = ids.has(item.id) || urls.has(url);
    ids.add(item.id);
    urls.add(url);
    return !duplicate;
  });
}

export async function archiveProcessedItems(
  dataDirectory: string,
  items: readonly NormalizedItem[],
  archivedAt = new Date(),
): Promise<number> {
  const seenPath = join(dataDirectory, "seen.jsonl");
  const seen = await loadSeenRecords(seenPath, archivedAt);
  const unseenItems = items.filter((item) => !hasSeen(seen, item.url));
  let additionCount = 0;
  for (const [month, monthlyItems] of groupItemsByPublishedMonth(unseenItems)) {
    const archivePath = join(dataDirectory, "items", `${month}.jsonl`);
    const archived = await readJsonLines<NormalizedItem>(archivePath);
    const archivedIds = new Set(archived.map((item) => item.id));
    const archivedUrls = new Set(
      archived.map((item) => normalizeUrl(item.url)),
    );
    const additions = monthlyItems.filter((item) => {
      const url = normalizeUrl(item.url);
      if (archivedIds.has(item.id) || archivedUrls.has(url)) return false;
      archivedIds.add(item.id);
      archivedUrls.add(url);
      return true;
    });
    await appendJsonLines(archivePath, additions);
    additionCount += additions.length;
  }

  await appendSeenUrls(
    seenPath,
    seen,
    items.map((item) => item.url),
    archivedAt,
  );
  return additionCount;
}

function groupItemsByPublishedMonth(
  items: readonly NormalizedItem[],
): Map<string, NormalizedItem[]> {
  const groups = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const publishedAt = new Date(item.published_at);
    if (Number.isNaN(publishedAt.getTime())) {
      throw new Error(`Invalid item published_at: ${item.id}`);
    }
    const month = publishedAt.toISOString().slice(0, 7);
    const group = groups.get(month) ?? [];
    group.push(item);
    groups.set(month, group);
  }
  return groups;
}

function assertValidWindow(window: ArchiveWindow): void {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error("Archive window must contain valid dates with from <= to");
  }
}

function archiveMonths(window: ArchiveWindow): string[] {
  if (window.from.getTime() === window.to.getTime()) return [];
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), 1),
  );
  const inclusiveEnd = new Date(window.to.getTime() - 1);
  const end = Date.UTC(
    inclusiveEnd.getUTCFullYear(),
    inclusiveEnd.getUTCMonth(),
    1,
  );

  while (cursor.getTime() <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function compareArchivedItems(
  left: NormalizedItem,
  right: NormalizedItem,
): number {
  return (
    new Date(left.published_at).getTime() -
      new Date(right.published_at).getTime() ||
    compareStrings(left.id, right.id) ||
    compareStrings(normalizeUrl(left.url), normalizeUrl(right.url))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
