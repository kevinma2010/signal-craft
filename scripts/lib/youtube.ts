import { XMLParser } from "fast-xml-parser";
import { appendJsonLines, readJsonLines } from "./jsonl";
import { hasSeen, loadSeenRecords } from "./seen";
import { getSourceMetadata } from "./sources";
import {
  type CommandRunner,
  type Fetcher,
  type TranscriptionBudget,
  transcribeYouTube,
} from "./transcription";
import type { NormalizedItem, SourceDefinition } from "./types";
import { createItemId, fingerprintUrl } from "./url";

export interface FetchYouTubeResult {
  items: NormalizedItem[];
  succeeded: string[];
  failed: Array<{ source: string; error: string }>;
  notices: string[];
  transcribed: number;
}

export class AllYouTubeSourcesFailedError extends AggregateError {
  constructor(readonly failed: FetchYouTubeResult["failed"]) {
    super(
      failed.map((entry) => new Error(`${entry.source}: ${entry.error}`)),
      "All YouTube sources failed",
    );
    this.name = "AllYouTubeSourcesFailedError";
  }
}

export function resolveTranscriptionBudget(config: unknown): number {
  if (!isRecord(config) || !isRecord(config.transcription)) return 10;
  if (config.transcription.enabled === false) return 0;
  const limit = config.transcription.max_items_per_run;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 0
    ? limit
    : 10;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
});

export async function fetchYouTubeSources(options: {
  sources: readonly SourceDefinition[];
  since: Date;
  outPath: string;
  writeOutput?: boolean;
  seenPath: string;
  cacheDirectory: string;
  budget?: number;
  now?: Date;
  fetcher?: Fetcher;
  runner?: CommandRunner;
  deepgramApiKey?: string;
  reportError?: (message: string) => void;
}): Promise<FetchYouTubeResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const sources = options.sources.filter((source) => source.type === "youtube");
  const seen = await loadSeenRecords(options.seenPath, now);
  const staged = await readJsonLines<NormalizedItem>(options.outPath);
  const known = new Set(staged.map((item) => fingerprintUrl(item.url)));
  const budget: TranscriptionBudget = { remaining: options.budget ?? 10 };
  const result: FetchYouTubeResult = {
    items: [],
    succeeded: [],
    failed: [],
    notices: [],
    transcribed: 0,
  };

  for (const source of sources) {
    try {
      const response = await fetcher(channelFeedUrl(source), {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries = parseYouTubeFeed(
        await response.text(),
        source,
        now,
      ).filter((item) => new Date(item.published_at) > options.since);
      result.succeeded.push(source.id);
      for (const item of entries) {
        const fingerprint = fingerprintUrl(item.url);
        if (hasSeen(seen, item.url) || known.has(fingerprint)) continue;
        known.add(fingerprint);
        let transcript: Awaited<ReturnType<typeof transcribeYouTube>>;
        try {
          transcript = await transcribeYouTube({
            itemId: item.id,
            url: item.url,
            cacheDirectory: options.cacheDirectory,
            budget,
            runner: options.runner,
            fetcher,
            deepgramApiKey: options.deepgramApiKey,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const notice = `Transcription failed for ${item.url}: ${message}`;
          if (!result.notices.includes(notice)) result.notices.push(notice);
          options.reportError?.(`${source.name}: ${notice}`);
          result.items.push(item);
          continue;
        }
        if (transcript.notice && !result.notices.includes(transcript.notice))
          result.notices.push(transcript.notice);
        if (transcript.provider !== "none") {
          item.text = transcript.text;
          item.transcript_provider = transcript.provider;
          result.transcribed += 1;
        }
        result.items.push(item);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.reportError?.(`${source.name}: ${message}`);
      result.failed.push({ source: source.id, error: message });
    }
  }
  if (sources.length > 0 && result.succeeded.length === 0)
    throw new AllYouTubeSourcesFailedError(result.failed);
  if (options.writeOutput !== false) {
    await appendJsonLines(options.outPath, result.items);
  }
  return result;
}

export function parseYouTubeFeed(
  xml: string,
  source: SourceDefinition,
  fetchedAt = new Date(),
): NormalizedItem[] {
  const document = parser.parse(xml) as { feed?: { entry?: unknown } };
  const entries = document.feed?.entry;
  return (Array.isArray(entries) ? entries : entries ? [entries] : []).map(
    (value) => {
      if (!isRecord(value))
        throw new Error("YouTube feed entry must be an object");
      const videoId = readText(value["yt:videoId"]);
      const url =
        readLink(value.link) ||
        (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
      const published = new Date(readText(value.published));
      if (!url || Number.isNaN(published.getTime()))
        throw new Error("YouTube entry lacks URL or publication date");
      const media = isRecord(value["media:group"]) ? value["media:group"] : {};
      const title =
        readText(value.title) || readText(media["media:title"]) || "Untitled";
      const description = readText(media["media:description"]);
      const author = isRecord(value.author) ? readText(value.author.name) : "";
      return {
        id: createItemId(url, published.toISOString()),
        type: "video",
        source: source.name,
        author,
        title,
        url,
        published_at: published.toISOString(),
        fetched_at: fetchedAt.toISOString(),
        text: description,
        transcript_provider: "none",
        extra: {
          ...getSourceMetadata(source),
          ...(videoId ? { video_id: videoId } : {}),
        },
      };
    },
  );
}

function channelFeedUrl(source: SourceDefinition): string {
  if (!source.url) throw new Error("YouTube source has no URL");
  const url = new URL(source.url);
  if (
    url.hostname === "www.youtube.com" &&
    url.pathname.startsWith("/channel/")
  ) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${url.pathname.split("/")[2]}`;
  }
  return source.url;
}

function readLink(value: unknown): string {
  for (const link of Array.isArray(value) ? value : [value]) {
    if (
      isRecord(link) &&
      typeof link["@_href"] === "string" &&
      (!link["@_rel"] || link["@_rel"] === "alternate")
    ) {
      return new URL(link["@_href"]).toString();
    }
  }
  return "";
}

function readText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim();
  if (isRecord(value)) return readText(value["#text"]);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
