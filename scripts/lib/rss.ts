import { XMLParser } from "fast-xml-parser";
import { appendJsonLines, readJsonLines } from "./jsonl";
import { htmlToMarkdown } from "./sanitize";
import { hasSeen, loadSeenRecords } from "./seen";
import type { NormalizedItem, SourceDefinition } from "./types";
import { createItemId, fingerprintUrl } from "./url";

export interface FetchRssOptions {
  sources: readonly SourceDefinition[];
  since: Date;
  outPath: string;
  seenPath: string;
  now?: Date;
  fetcher?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  reportError?: (message: string) => void;
}

export interface FetchRssResult {
  items: NormalizedItem[];
  succeeded: string[];
  failed: Array<{ source: string; error: string }>;
}

export class AllRssSourcesFailedError extends AggregateError {
  constructor(readonly failed: FetchRssResult["failed"]) {
    super(
      failed.map((failure) => new Error(`${failure.source}: ${failure.error}`)),
      "All RSS sources failed",
    );
    this.name = "AllRssSourcesFailedError";
  }
}

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: false,
});

export async function fetchRssSources(
  options: FetchRssOptions,
): Promise<FetchRssResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const rssSources = options.sources.filter((source) => source.type === "rss");
  const seen = await loadSeenRecords(options.seenPath, now);
  const staged = await readJsonLines<NormalizedItem>(options.outPath);
  const knownUrls = new Set(staged.map((item) => fingerprintUrl(item.url)));

  const results = await Promise.all(
    rssSources.map(async (source) => {
      try {
        const response = await fetcher(requireSourceUrl(source), {
          headers: {
            Accept:
              "application/atom+xml, application/rss+xml, application/xml, text/xml",
            "User-Agent": "SignalCraft/0.1",
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const items = parseFeed(await response.text(), source, now).filter(
          (item) => new Date(item.published_at) > options.since,
        );
        return { source, items };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.reportError?.(`${source.name}: ${message}`);
        return { source, error: message };
      }
    }),
  );

  const succeeded: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  const additions: NormalizedItem[] = [];
  for (const result of results) {
    if ("error" in result && result.error !== undefined) {
      failed.push({ source: result.source.id, error: result.error });
      continue;
    }
    succeeded.push(result.source.id);
    for (const item of result.items) {
      const fingerprint = fingerprintUrl(item.url);
      if (hasSeen(seen, item.url) || knownUrls.has(fingerprint)) {
        continue;
      }
      knownUrls.add(fingerprint);
      additions.push(item);
    }
  }

  if (rssSources.length > 0 && succeeded.length === 0) {
    throw new AllRssSourcesFailedError(failed);
  }
  await appendJsonLines(options.outPath, additions);
  return { items: additions, succeeded, failed };
}

export function parseFeed(
  xml: string,
  source: SourceDefinition,
  fetchedAt = new Date(),
): NormalizedItem[] {
  const document = parser.parse(xml) as Record<string, unknown>;
  if (isRecord(document.rss)) {
    const channel = isRecord(document.rss.channel)
      ? document.rss.channel
      : undefined;
    if (!channel) {
      throw new Error("RSS feed has no channel");
    }
    return asArray(channel.item).map((entry) =>
      normalizeEntry(entry, source, fetchedAt, "rss"),
    );
  }
  if (isRecord(document.feed)) {
    return asArray(document.feed.entry).map((entry) =>
      normalizeEntry(entry, source, fetchedAt, "atom"),
    );
  }
  throw new Error("Unsupported feed format");
}

function normalizeEntry(
  value: unknown,
  source: SourceDefinition,
  fetchedAt: Date,
  format: "rss" | "atom",
): NormalizedItem {
  if (!isRecord(value)) {
    throw new Error("Feed entry must be an object");
  }
  const title = readText(value.title) || "Untitled";
  const url = format === "atom" ? readAtomLink(value.link) : readRssLink(value);
  const publishedAt = readDate(
    value.published ??
      value.updated ??
      value.pubDate ??
      value["dc:date"] ??
      value.date,
  );
  const content = readText(
    value["content:encoded"] ??
      value.content ??
      value.description ??
      value.summary,
  );
  const enclosure = readEnclosure(value, format);
  const itemType = inferItemType(source, enclosure?.type);

  return {
    id: createItemId(url, publishedAt),
    type: itemType,
    source: source.name,
    author: readAuthor(value.author ?? value["dc:creator"]),
    title,
    url,
    published_at: publishedAt,
    fetched_at: fetchedAt.toISOString(),
    text: htmlToMarkdown(content, url),
    transcript_provider: "none",
    extra: enclosure ? { enclosure } : {},
  };
}

function readRssLink(entry: Record<string, unknown>): string {
  const link = readText(entry.link) || readText(entry.guid);
  if (!link) {
    throw new Error("Feed entry has no link");
  }
  return new URL(link).toString();
}

function readAtomLink(value: unknown): string {
  for (const link of asArray(value)) {
    if (
      isRecord(link) &&
      typeof link["@_href"] === "string" &&
      (!link["@_rel"] || link["@_rel"] === "alternate")
    ) {
      return new URL(link["@_href"]).toString();
    }
  }
  throw new Error("Feed entry has no alternate link");
}

function readEnclosure(entry: Record<string, unknown>, format: "rss" | "atom") {
  const candidates =
    format === "atom" ? asArray(entry.link) : asArray(entry.enclosure);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (format === "atom" && candidate["@_rel"] !== "enclosure") {
      continue;
    }
    const url = candidate["@_url"] ?? candidate["@_href"];
    if (typeof url === "string") {
      return {
        url: new URL(url).toString(),
        type:
          typeof candidate["@_type"] === "string"
            ? candidate["@_type"]
            : undefined,
      };
    }
  }
  return undefined;
}

function inferItemType(
  source: SourceDefinition,
  enclosureType?: string,
): NormalizedItem["type"] {
  if (source.category === "podcast" || enclosureType?.startsWith("audio/")) {
    return "podcast";
  }
  if (["changelog", "release"].includes(source.category)) {
    return "release";
  }
  return "article";
}

function readAuthor(value: unknown): string {
  if (isRecord(value)) {
    return readText(value.name) || readText(value.email);
  }
  return readText(value);
}

function readDate(value: unknown): string {
  const text = readText(value);
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw new Error("Feed entry has no valid publication date");
  }
  return date.toISOString();
}

function readText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (isRecord(value)) {
    return readText(value["#text"] ?? value.__cdata ?? value._);
  }
  return "";
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function requireSourceUrl(source: SourceDefinition): string {
  if (!source.url) {
    throw new Error("RSS source has no URL");
  }
  return source.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
