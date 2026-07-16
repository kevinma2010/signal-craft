export const ITEM_TYPES = [
  "article",
  "post",
  "video",
  "podcast",
  "release",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export type TranscriptProvider = "native" | "deepgram" | "none";

export interface NormalizedItem {
  id: string;
  type: ItemType;
  source: string;
  author: string;
  title: string;
  url: string;
  published_at: string;
  fetched_at: string;
  text: string;
  transcript_provider: TranscriptProvider;
  extra: Record<string, unknown>;
}

export const SOURCE_TYPES = ["rss", "github", "youtube", "x"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_USAGES = ["daily", "longform", "both"] as const;

export type SourceUsage = (typeof SOURCE_USAGES)[number];

export interface SourceDefinition {
  id: string;
  name: string;
  type: SourceType;
  category: string;
  weight: number;
  url?: string;
  handle?: string;
  query?: string;
  tags?: string[];
  usage?: SourceUsage;
  tier?: 1 | 2;
  maxResults?: number;
}

export interface SourcePack {
  version: number;
  sources: SourceDefinition[];
}

export interface SourceOverlay {
  version: number;
  added?: SourceDefinition[];
  disabled?: string[];
  weights?: Record<string, number>;
}

export interface SeenRecord {
  id: string;
  normalized_url: string;
  first_seen: string;
}
