import { getSourceMetadata } from "./sources";
import type { NormalizedItem, SourceDefinition } from "./types";
import { createItemId } from "./url";
import type { XApiPost, XApiSource } from "./x-api";
import { parseXApiContinuationCursor } from "./x-api";

export function createXApiSource(
  source: SourceDefinition,
  options: { sinceId?: string; startTime: Date },
): XApiSource {
  if (source.type !== "x") {
    throw new Error(`X API source must have type x: ${source.id}`);
  }
  const query = source.query ?? accountQuery(source);
  const continuation = options.sinceId
    ? parseXApiContinuationCursor(options.sinceId)
    : undefined;
  return {
    id: source.id,
    query,
    ...(continuation
      ? { continuation }
      : options.sinceId
        ? { sinceId: options.sinceId }
        : { startTime: options.startTime.toISOString() }),
    maxResults: Math.min(100, Math.max(10, source.maxResults ?? 10)),
  };
}

export function normalizeXApiPost(
  post: XApiPost,
  source: SourceDefinition,
  fetchedAt = new Date(),
): NormalizedItem {
  const url = source.handle
    ? `https://x.com/${normalizeHandle(source.handle)}/status/${post.id}`
    : `https://x.com/i/web/status/${post.id}`;
  return {
    id: createItemId(url, post.createdAt),
    type: "post",
    source: source.name,
    author: source.handle
      ? `@${normalizeHandle(source.handle)}`
      : (post.authorId ?? "unknown"),
    title: titleFromPost(post.text),
    url,
    published_at: new Date(post.createdAt).toISOString(),
    fetched_at: fetchedAt.toISOString(),
    text: post.text,
    transcript_provider: "none",
    extra: {
      content_status: "complete",
      x_post_id: post.id,
      ...(post.authorId ? { x_author_id: post.authorId } : {}),
      ...getSourceMetadata(source),
    },
  };
}

function accountQuery(source: SourceDefinition): string {
  if (!source.handle) {
    throw new Error(`X API source requires a handle or query: ${source.id}`);
  }
  return `from:${normalizeHandle(source.handle)} -is:retweet`;
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "");
}

function titleFromPost(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 140 ? compact : `${compact.slice(0, 137)}...`;
}
