import { appendJsonLines, readJsonLines } from "./jsonl";
import { hasSeen, loadSeenRecords } from "./seen";
import { getSourceMetadata } from "./sources";
import type { NormalizedItem, SourceDefinition } from "./types";
import { createItemId, fingerprintUrl } from "./url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface FetchGitHubOptions {
  sources: readonly SourceDefinition[];
  since: Date;
  outPath: string;
  writeOutput?: boolean;
  maxPages?: number;
  seenPath: string;
  now?: Date;
  token?: string;
  fetcher?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  reportError?: (message: string) => void;
}

export interface GitHubFailure {
  source: string;
  error: string;
}

export interface FetchGitHubResult {
  items: NormalizedItem[];
  succeeded: string[];
  failed: GitHubFailure[];
}

export class AllGitHubSourcesFailedError extends AggregateError {
  constructor(readonly failed: GitHubFailure[]) {
    super(
      failed.map((failure) => new Error(`${failure.source}: ${failure.error}`)),
      "All GitHub sources failed",
    );
    this.name = "AllGitHubSourcesFailedError";
  }
}

interface Repository {
  owner: string;
  name: string;
}

interface EndpointResult {
  endpoint: "releases" | "discussions";
  items?: NormalizedItem[];
  error?: string;
}

export async function fetchGitHubSources(
  options: FetchGitHubOptions,
): Promise<FetchGitHubResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const githubSources = options.sources.filter(
    (source) => source.type === "github",
  );
  const seen = await loadSeenRecords(options.seenPath, now);
  const staged = await readJsonLines<NormalizedItem>(options.outPath);
  const knownUrls = new Set(staged.map((item) => fingerprintUrl(item.url)));

  const sourceResults = await Promise.all(
    githubSources.map(async (source) => {
      let repository: Repository;
      try {
        repository = parseRepository(source);
      } catch (error) {
        const message = errorMessage(error);
        options.reportError?.(`${source.name}: ${message}`);
        return { source, endpoints: [], setupError: message };
      }

      const endpoints = await Promise.all([
        fetchReleases(source, repository, options, fetcher, now),
        fetchDiscussions(source, repository, options, fetcher, now),
      ]);
      for (const endpoint of endpoints) {
        if (endpoint.error) {
          options.reportError?.(
            `${source.name} (${endpoint.endpoint}): ${endpoint.error}`,
          );
        }
      }
      return { source, endpoints };
    }),
  );

  const succeeded: string[] = [];
  const failed: GitHubFailure[] = [];
  const additions: NormalizedItem[] = [];
  let completedEndpointCount = 0;
  for (const result of sourceResults) {
    if (result.setupError) {
      failed.push({ source: result.source.id, error: result.setupError });
      continue;
    }
    const successfulEndpoints = result.endpoints.filter(
      (endpoint) => !endpoint.error,
    );
    const endpointErrors = result.endpoints.filter(
      (endpoint) => endpoint.error,
    );
    completedEndpointCount += successfulEndpoints.length;
    if (successfulEndpoints.length === 0) {
      failed.push({
        source: result.source.id,
        error: endpointErrors
          .map((endpoint) => `${endpoint.endpoint}: ${endpoint.error}`)
          .join("; "),
      });
      continue;
    }
    if (endpointErrors.length === 0) {
      succeeded.push(result.source.id);
    } else {
      failed.push({
        source: result.source.id,
        error: endpointErrors
          .map((endpoint) => `${endpoint.endpoint}: ${endpoint.error}`)
          .join("; "),
      });
    }
    for (const endpoint of successfulEndpoints) {
      for (const item of endpoint.items ?? []) {
        const fingerprint = fingerprintUrl(item.url);
        if (hasSeen(seen, item.url) || knownUrls.has(fingerprint)) {
          continue;
        }
        knownUrls.add(fingerprint);
        additions.push(item);
      }
    }
  }

  if (githubSources.length > 0 && completedEndpointCount === 0) {
    throw new AllGitHubSourcesFailedError(failed);
  }
  if (options.writeOutput !== false) {
    await appendJsonLines(options.outPath, additions);
  }
  return { items: additions, succeeded, failed };
}

async function fetchReleases(
  source: SourceDefinition,
  repository: Repository,
  options: FetchGitHubOptions,
  fetcher: NonNullable<FetchGitHubOptions["fetcher"]>,
  now: Date,
): Promise<EndpointResult> {
  try {
    const values = await fetchPages(
      `${API_ROOT}/repos/${repository.owner}/${repository.name}/releases?per_page=100`,
      options,
      fetcher,
      (value) => releaseTimestamp(value),
    );
    return {
      endpoint: "releases",
      items: values
        .map((value) => normalizeRelease(value, source, now))
        .filter((item) => new Date(item.published_at) > options.since),
    };
  } catch (error) {
    return {
      endpoint: "releases",
      error: errorMessage(error, options.token),
    };
  }
}

async function fetchDiscussions(
  source: SourceDefinition,
  repository: Repository,
  options: FetchGitHubOptions,
  fetcher: NonNullable<FetchGitHubOptions["fetcher"]>,
  now: Date,
): Promise<EndpointResult> {
  try {
    const values = await fetchPages(
      `${API_ROOT}/repos/${repository.owner}/${repository.name}/events?per_page=100`,
      options,
      fetcher,
      eventTimestamp,
    );
    return {
      endpoint: "discussions",
      items: values
        .map((value) => normalizeDiscussion(value, source, now))
        .filter(
          (item): item is NormalizedItem =>
            item !== undefined && new Date(item.published_at) > options.since,
        ),
    };
  } catch (error) {
    return {
      endpoint: "discussions",
      error: errorMessage(error, options.token),
    };
  }
}

async function fetchPages(
  initialUrl: string,
  options: FetchGitHubOptions,
  fetcher: NonNullable<FetchGitHubOptions["fetcher"]>,
  timestamp: (value: unknown) => string | undefined,
): Promise<unknown[]> {
  const values: unknown[] = [];
  let nextUrl: string | undefined = initialUrl;
  let pageCount = 0;
  while (
    nextUrl &&
    pageCount < (options.maxPages ?? Number.POSITIVE_INFINITY)
  ) {
    pageCount += 1;
    const response = await fetcher(nextUrl, {
      headers: requestHeaders(options.token),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const page: unknown = await response.json();
    if (!Array.isArray(page)) {
      throw new Error("GitHub API response must be an array");
    }
    values.push(...page);
    if (page.some((value) => isAtOrBefore(timestamp(value), options.since))) {
      break;
    }
    nextUrl = readNextLink(response.headers.get("link"));
  }
  return values;
}

function normalizeRelease(
  value: unknown,
  source: SourceDefinition,
  fetchedAt: Date,
): NormalizedItem {
  const release = requireRecord(value, "release");
  const publishedAt = requireTimestamp(
    release.published_at,
    "release published_at",
  );
  const url = requireUrl(release.html_url, "release html_url");
  const tagName = requireString(release.tag_name, "release tag_name");
  const name = optionalString(release.name);
  const author = requireRecord(release.author, "release author");
  return {
    id: createItemId(url, publishedAt),
    type: "release",
    source: source.name,
    author: requireString(author.login, "release author login"),
    title: name || tagName,
    url,
    published_at: publishedAt,
    fetched_at: fetchedAt.toISOString(),
    text: optionalString(release.body),
    transcript_provider: "none",
    extra: {
      ...getSourceMetadata(source),
      tag_name: tagName,
      prerelease: release.prerelease === true,
    },
  };
}

function normalizeDiscussion(
  value: unknown,
  source: SourceDefinition,
  fetchedAt: Date,
): NormalizedItem | undefined {
  const event = requireRecord(value, "event");
  if (event.type !== "DiscussionEvent") {
    return undefined;
  }
  const payload = requireRecord(event.payload, "discussion event payload");
  if (payload.action !== "created") {
    return undefined;
  }
  const discussion = requireRecord(payload.discussion, "discussion");
  const association = optionalString(discussion.author_association);
  if (!MAINTAINER_ASSOCIATIONS.has(association)) {
    return undefined;
  }
  const publishedAt = requireTimestamp(
    discussion.created_at ?? event.created_at,
    "discussion created_at",
  );
  const url = requireUrl(discussion.html_url, "discussion html_url");
  const user = requireRecord(discussion.user, "discussion user");
  return {
    id: createItemId(url, publishedAt),
    type: source.category === "official" ? "article" : "post",
    source: source.name,
    author: requireString(user.login, "discussion author login"),
    title: requireString(discussion.title, "discussion title"),
    url,
    published_at: publishedAt,
    fetched_at: fetchedAt.toISOString(),
    text: optionalString(discussion.body),
    transcript_provider: "none",
    extra: {
      ...getSourceMetadata(source),
      author_association: association,
      category: isRecord(discussion.category)
        ? optionalString(discussion.category.name)
        : "",
    },
  };
}

function parseRepository(source: SourceDefinition): Repository {
  if (!source.url) {
    throw new Error("GitHub source has no URL");
  }
  const url = new URL(source.url);
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub source URL must use github.com");
  }
  const [owner, rawName, ...rest] = url.pathname.split("/").filter(Boolean);
  const name = rawName?.replace(/\.git$/, "");
  if (!owner || !name || rest.length > 0) {
    throw new Error("GitHub source URL must identify one repository");
  }
  return { owner, name };
}

function requestHeaders(token?: string): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "SignalCraft/0.1",
    "X-GitHub-Api-Version": API_VERSION,
  });
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function readNextLink(header: string | null): string | undefined {
  for (const part of header?.split(",") ?? []) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2]?.split(/\s+/).includes("next")) {
      return match[1];
    }
  }
  return undefined;
}

function releaseTimestamp(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.published_at) : undefined;
}

function eventTimestamp(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.created_at) : undefined;
}

function isAtOrBefore(value: string | undefined, since: Date): boolean {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && timestamp <= since.getTime();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid ${label}`);
  }
  return timestamp.toISOString();
}

function requireUrl(value: unknown, label: string): string {
  return new URL(requireString(value, label)).toString();
}

function errorMessage(error: unknown, token?: string): string {
  const message =
    error instanceof Error ? error.message : "Unknown GitHub API error";
  return token ? message.replaceAll(token, "[REDACTED]") : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
