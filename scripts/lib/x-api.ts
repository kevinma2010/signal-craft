const API_ROOT = "https://api.x.com/2";

export const DEFAULT_X_API_COST_PER_POST_USD = 0.005;

export interface XApiSource {
  id: string;
  query: string;
  sinceId?: string;
  startTime?: string;
  continuation?: XApiContinuation;
  maxResults?: number;
}

export interface XApiContinuation {
  sinceId?: string;
  startTime?: string;
  paginationToken: string;
  pendingNewestId: string;
}

export interface XApiBudgetLimits {
  maxPostReadsPerRun: number;
  maxPostReadsPerDay: number;
  maxPostReadsPerMonth: number;
  maxUsdPerRun: number;
  maxUsdPerDay: number;
  maxUsdPerMonth: number;
}

export interface XApiPriorUsage {
  postReadsToday: number;
  postReadsThisMonth: number;
  usdToday: number;
  usdThisMonth: number;
}

export interface XApiPost {
  id: string;
  text: string;
  authorId?: string;
  createdAt: string;
  sourceId: string;
}

export type XApiDegradedReason =
  | "disabled"
  | "missing_token"
  | "invalid_options"
  | "preflight_failed"
  | "usage_anomaly"
  | "budget_exceeded"
  | "auth_failed"
  | "rate_limited"
  | "search_failed"
  | "response_anomaly";

export interface XApiAuditRecord {
  at: string;
  event:
    | "disabled"
    | "preflight"
    | "budget_rejected"
    | "reservation"
    | "search"
    | "circuit_breaker";
  sourceId?: string;
  page?: number;
  reservedPostReads?: number;
  returnedPostReads?: number;
  estimatedUsd?: number;
  detail?: string;
}

export interface XApiUsageDelta {
  postReads: number;
  usd: number;
}

export interface XApiFetchResult {
  status: "ok" | "degraded";
  reason?: XApiDegradedReason;
  posts: XApiPost[];
  cursors: Record<string, string>;
  usage: XApiUsageDelta;
  audit: XApiAuditRecord[];
}

export type XApiFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchXApiOptions {
  enabled?: boolean;
  bearerToken?: string;
  sources: readonly XApiSource[];
  limits: XApiBudgetLimits;
  priorUsage?: Partial<XApiPriorUsage>;
  costPerPostUsd?: number;
  maxPages?: number;
  fetcher?: XApiFetcher;
  clock?: () => Date;
}

interface ProjectUsage {
  projectUsage: number;
  projectCap: number;
}

interface SearchPage {
  posts: Array<Omit<XApiPost, "sourceId">>;
  newestId?: string;
  nextToken?: string;
}

interface MutableRunState {
  posts: XApiPost[];
  cursors: Record<string, string>;
  audit: XApiAuditRecord[];
  postReads: number;
  usd: number;
}

const ZERO_PRIOR_USAGE: XApiPriorUsage = {
  postReadsToday: 0,
  postReadsThisMonth: 0,
  usdToday: 0,
  usdThisMonth: 0,
};

const CONTINUATION_PREFIX = "x-api-continuation:v1:";

export function isXApiContinuationCursor(cursor: string): boolean {
  return parseXApiContinuationCursor(cursor) !== undefined;
}

export function parseXApiContinuationCursor(
  cursor: string,
): XApiContinuation | undefined {
  if (!cursor.startsWith(CONTINUATION_PREFIX)) return undefined;
  try {
    const encoded = cursor.slice(CONTINUATION_PREFIX.length);
    const payload = record(JSON.parse(decodeBase64Url(encoded)) as unknown);
    const sinceId = optionalNumericString(payload?.since_id);
    const startTime = optionalString(payload?.start_time);
    const paginationToken = optionalString(payload?.pagination_token);
    const pendingNewestId = optionalNumericString(payload?.pending_newest_id);
    if (
      (payload?.since_id !== undefined && sinceId === undefined) ||
      (payload?.start_time !== undefined &&
        (startTime === undefined || Number.isNaN(Date.parse(startTime)))) ||
      (sinceId === undefined) === (startTime === undefined) ||
      paginationToken === undefined ||
      pendingNewestId === undefined
    ) {
      return undefined;
    }
    const continuation: XApiContinuation = {
      ...(sinceId ? { sinceId } : { startTime }),
      paginationToken,
      pendingNewestId,
    };
    return validateContinuation(continuation) ? undefined : continuation;
  } catch {
    return undefined;
  }
}

export function createXApiContinuationCursor(
  continuation: XApiContinuation,
): string {
  const validationError = validateContinuation(continuation);
  if (validationError) throw new Error(validationError);
  return `${CONTINUATION_PREFIX}${encodeBase64Url(
    JSON.stringify({
      ...(continuation.sinceId
        ? { since_id: continuation.sinceId }
        : { start_time: continuation.startTime }),
      pagination_token: continuation.paginationToken,
      pending_newest_id: continuation.pendingNewestId,
    }),
  )}`;
}

export async function fetchXApiPosts(
  options: FetchXApiOptions,
): Promise<XApiFetchResult> {
  const clock = options.clock ?? (() => new Date());
  const now = clock().toISOString();
  const state: MutableRunState = {
    posts: [],
    cursors: Object.fromEntries(
      options.sources.flatMap((source) =>
        source.continuation
          ? [[source.id, createXApiContinuationCursor(source.continuation)]]
          : source.sinceId
            ? [[source.id, source.sinceId]]
            : [],
      ),
    ),
    audit: [],
    postReads: 0,
    usd: 0,
  };

  if (options.enabled !== true) {
    state.audit.push({ at: now, event: "disabled" });
    return degraded(state, "disabled");
  }

  const token = options.bearerToken ?? process.env.X_BEARER_TOKEN;
  if (!token) {
    state.audit.push({
      at: now,
      event: "circuit_breaker",
      detail: "X_BEARER_TOKEN is required",
    });
    return degraded(state, "missing_token");
  }

  const costPerPost = options.costPerPostUsd ?? DEFAULT_X_API_COST_PER_POST_USD;
  const maxPages = options.maxPages ?? 1;
  const priorUsage = { ...ZERO_PRIOR_USAGE, ...options.priorUsage };
  const validationError = validateOptions(
    options.sources,
    options.limits,
    priorUsage,
    costPerPost,
    maxPages,
  );
  if (validationError) {
    state.audit.push({
      at: now,
      event: "circuit_breaker",
      detail: validationError,
    });
    return degraded(state, "invalid_options");
  }

  const fetcher = options.fetcher ?? fetch;
  const preflight = await fetchProjectUsage(fetcher, token);
  if (!preflight.ok) {
    state.audit.push({
      at: now,
      event: "circuit_breaker",
      detail: preflight.detail,
    });
    return degraded(state, preflight.reason);
  }
  state.audit.push({
    at: now,
    event: "preflight",
    detail: `${preflight.value.projectUsage}/${preflight.value.projectCap}`,
  });

  for (const source of options.sources) {
    let nextToken = source.continuation?.paginationToken;
    let pendingNewestId = source.continuation?.pendingNewestId;
    for (let page = 1; page <= maxPages; page += 1) {
      const requestedReads = source.maxResults ?? 10;
      const rejection = budgetRejection(
        requestedReads,
        state,
        options.limits,
        priorUsage,
        costPerPost,
        preflight.value,
      );
      if (rejection) {
        state.audit.push({
          at: clock().toISOString(),
          event: "budget_rejected",
          sourceId: source.id,
          page,
          reservedPostReads: requestedReads,
          estimatedUsd: money(requestedReads * costPerPost),
          detail: rejection,
        });
        return degraded(state, "budget_exceeded");
      }

      state.audit.push({
        at: clock().toISOString(),
        event: "reservation",
        sourceId: source.id,
        page,
        reservedPostReads: requestedReads,
        estimatedUsd: money(requestedReads * costPerPost),
      });

      const search = await fetchSearchPage(
        fetcher,
        token,
        source,
        requestedReads,
        nextToken,
      );
      if (!search.ok) {
        if (search.chargedPostReads !== undefined) {
          state.postReads += search.chargedPostReads;
          state.usd = money(state.usd + search.chargedPostReads * costPerPost);
        }
        state.audit.push({
          at: clock().toISOString(),
          event: "circuit_breaker",
          sourceId: source.id,
          page,
          reservedPostReads: requestedReads,
          returnedPostReads: search.chargedPostReads,
          estimatedUsd:
            search.chargedPostReads === undefined
              ? undefined
              : money(search.chargedPostReads * costPerPost),
          detail: search.detail,
        });
        return degraded(state, search.reason);
      }

      const returnedReads = search.value.posts.length;
      state.postReads += returnedReads;
      state.usd = money(state.usd + returnedReads * costPerPost);
      state.posts.push(
        ...search.value.posts.map((post) => ({
          ...post,
          sourceId: source.id,
        })),
      );
      if (search.value.newestId) {
        pendingNewestId = pendingNewestId
          ? greatestId(pendingNewestId, search.value.newestId)
          : search.value.newestId;
      }
      state.audit.push({
        at: clock().toISOString(),
        event: "search",
        sourceId: source.id,
        page,
        reservedPostReads: requestedReads,
        returnedPostReads: returnedReads,
        estimatedUsd: money(returnedReads * costPerPost),
      });

      nextToken = search.value.nextToken;
      if (nextToken && pendingNewestId) {
        state.cursors[source.id] = createXApiContinuationCursor({
          ...sourceContext(source),
          paginationToken: nextToken,
          pendingNewestId,
        });
      } else if (!nextToken) {
        if (pendingNewestId) state.cursors[source.id] = pendingNewestId;
        break;
      }
    }
  }

  return result(state, "ok");
}

function validateOptions(
  sources: readonly XApiSource[],
  limits: XApiBudgetLimits,
  priorUsage: XApiPriorUsage,
  costPerPost: number,
  maxPages: number,
): string | undefined {
  if (!positiveFinite(costPerPost)) return "costPerPostUsd must be positive";
  if (!positiveInteger(maxPages)) return "maxPages must be a positive integer";

  for (const [name, value] of Object.entries(limits)) {
    if (!positiveFinite(value)) return `${name} must be positive`;
  }
  for (const [name, value] of Object.entries(priorUsage)) {
    if (!nonNegativeFinite(value)) return `${name} must be non-negative`;
  }
  if (priorUsage.postReadsToday > priorUsage.postReadsThisMonth) {
    return "daily post reads cannot exceed monthly post reads";
  }
  if (priorUsage.usdToday > priorUsage.usdThisMonth) {
    return "daily USD usage cannot exceed monthly USD usage";
  }

  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.id.trim() || ids.has(source.id)) {
      return "source ids must be non-empty and unique";
    }
    ids.add(source.id);
    if (!source.query.trim()) return `source ${source.id} has no query`;
    if (source.continuation) {
      const continuationError = validateContinuation(source.continuation);
      if (continuationError) return `source ${source.id}: ${continuationError}`;
    }
    if (source.sinceId !== undefined && !/^\d+$/.test(source.sinceId)) {
      return `source ${source.id} requires a numeric sinceId`;
    }
    if (
      source.startTime !== undefined &&
      Number.isNaN(Date.parse(source.startTime))
    ) {
      return `source ${source.id} requires a valid startTime`;
    }
    if (!source.sinceId && !source.startTime && !source.continuation) {
      return `source ${source.id} requires sinceId or startTime`;
    }
    if (
      source.continuation &&
      (source.sinceId !== undefined || source.startTime !== undefined)
    ) {
      return `source ${source.id} continuation cannot be combined with sinceId or startTime`;
    }
    const maxResults = source.maxResults ?? 10;
    if (!Number.isInteger(maxResults) || maxResults < 10 || maxResults > 100) {
      return `source ${source.id} maxResults must be between 10 and 100`;
    }
  }
  return undefined;
}

async function fetchProjectUsage(
  fetcher: XApiFetcher,
  token: string,
): Promise<
  | { ok: true; value: ProjectUsage }
  | {
      ok: false;
      reason:
        | "preflight_failed"
        | "auth_failed"
        | "rate_limited"
        | "usage_anomaly";
      detail: string;
    }
> {
  let response: Response;
  try {
    response = await fetcher(`${API_ROOT}/usage/tweets`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return {
      ok: false,
      reason: "preflight_failed",
      detail: "usage preflight request failed",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: statusReason(response.status, "preflight_failed"),
      detail: `usage preflight returned HTTP ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: "usage_anomaly",
      detail: "usage preflight returned invalid JSON",
    };
  }
  const data = record(body)?.data;
  const usage = record(data);
  const projectUsage = usageInteger(usage?.project_usage);
  const projectCap = usageInteger(usage?.project_cap);
  if (
    projectUsage === undefined ||
    projectCap === undefined ||
    !Number.isInteger(projectUsage) ||
    !Number.isInteger(projectCap) ||
    projectUsage < 0 ||
    projectCap <= 0 ||
    projectUsage > projectCap
  ) {
    return {
      ok: false,
      reason: "usage_anomaly",
      detail: "usage preflight returned invalid project usage",
    };
  }
  return { ok: true, value: { projectUsage, projectCap } };
}

async function fetchSearchPage(
  fetcher: XApiFetcher,
  token: string,
  source: XApiSource,
  maxResults: number,
  nextToken?: string,
): Promise<
  | { ok: true; value: SearchPage }
  | {
      ok: false;
      reason:
        | "auth_failed"
        | "rate_limited"
        | "search_failed"
        | "response_anomaly";
      detail: string;
      chargedPostReads?: number;
    }
> {
  const url = new URL(`${API_ROOT}/tweets/search/recent`);
  url.searchParams.set("query", source.query);
  const context = source.continuation ?? source;
  if (context.sinceId) url.searchParams.set("since_id", context.sinceId);
  else if (context.startTime)
    url.searchParams.set(
      "start_time",
      new Date(context.startTime).toISOString(),
    );
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("tweet.fields", "author_id,created_at");
  if (nextToken) url.searchParams.set("pagination_token", nextToken);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return {
      ok: false,
      reason: "search_failed",
      detail: "recent search request failed",
      chargedPostReads: maxResults,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: statusReason(response.status, "search_failed"),
      detail: `recent search returned HTTP ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return anomaly("recent search returned invalid JSON", maxResults);
  }
  const root = record(body);
  const rawPosts = root?.data ?? [];
  const meta = record(root?.meta);
  if (!Array.isArray(rawPosts) || rawPosts.length > maxResults) {
    return anomaly(
      "recent search returned an invalid resource count",
      maxResults,
    );
  }
  const resultCount = number(meta?.result_count);
  if (
    resultCount !== undefined &&
    (!Number.isInteger(resultCount) || resultCount !== rawPosts.length)
  ) {
    return anomaly(
      "recent search result_count does not match returned resources",
      rawPosts.length,
    );
  }

  const posts: Array<Omit<XApiPost, "sourceId">> = [];
  for (const value of rawPosts) {
    const post = record(value);
    if (!post || !numericString(post.id) || typeof post.text !== "string") {
      return anomaly(
        "recent search returned an invalid post resource",
        rawPosts.length,
      );
    }
    if (post.author_id !== undefined && !numericString(post.author_id)) {
      return anomaly(
        "recent search returned an invalid author_id",
        rawPosts.length,
      );
    }
    if (
      typeof post.created_at !== "string" ||
      Number.isNaN(Date.parse(post.created_at))
    ) {
      return anomaly(
        "recent search returned an invalid created_at",
        rawPosts.length,
      );
    }
    posts.push({
      id: post.id,
      text: post.text,
      ...(post.author_id === undefined ? {} : { authorId: post.author_id }),
      createdAt: post.created_at,
    });
  }

  const newestId = optionalNumericString(meta?.newest_id);
  const next = optionalString(meta?.next_token);
  if (meta?.newest_id !== undefined && newestId === undefined) {
    return anomaly(
      "recent search returned an invalid newest_id",
      rawPosts.length,
    );
  }
  if (meta?.next_token !== undefined && next === undefined) {
    return anomaly(
      "recent search returned an invalid next_token",
      rawPosts.length,
    );
  }
  if (next && next === nextToken) {
    return anomaly(
      "recent search pagination token did not advance",
      rawPosts.length,
    );
  }
  if (next && !newestId && !source.continuation?.pendingNewestId) {
    return anomaly(
      "recent search returned pagination without a newest_id",
      rawPosts.length,
    );
  }
  if (
    newestId &&
    context.sinceId &&
    BigInt(newestId) < BigInt(context.sinceId)
  ) {
    return anomaly("recent search cursor moved backwards", rawPosts.length);
  }
  return {
    ok: true,
    value: { posts, newestId, nextToken: next },
  };
}

function budgetRejection(
  reserveReads: number,
  state: MutableRunState,
  limits: XApiBudgetLimits,
  prior: XApiPriorUsage,
  costPerPost: number,
  project: ProjectUsage,
): string | undefined {
  const reserveUsd = reserveReads * costPerPost;
  if (state.postReads + reserveReads > limits.maxPostReadsPerRun) {
    return "run post-read limit would be exceeded";
  }
  if (
    prior.postReadsToday + state.postReads + reserveReads >
    limits.maxPostReadsPerDay
  ) {
    return "daily post-read limit would be exceeded";
  }
  if (
    prior.postReadsThisMonth + state.postReads + reserveReads >
    limits.maxPostReadsPerMonth
  ) {
    return "monthly post-read limit would be exceeded";
  }
  if (state.usd + reserveUsd > limits.maxUsdPerRun) {
    return "run USD limit would be exceeded";
  }
  if (prior.usdToday + state.usd + reserveUsd > limits.maxUsdPerDay) {
    return "daily USD limit would be exceeded";
  }
  if (prior.usdThisMonth + state.usd + reserveUsd > limits.maxUsdPerMonth) {
    return "monthly USD limit would be exceeded";
  }
  if (
    project.projectUsage + state.postReads + reserveReads >
    project.projectCap
  ) {
    return "X project cap would be exceeded";
  }
  return undefined;
}

function degraded(
  state: MutableRunState,
  reason: XApiDegradedReason,
): XApiFetchResult {
  return { ...result(state, "degraded"), reason };
}

function result(
  state: MutableRunState,
  status: XApiFetchResult["status"],
): XApiFetchResult {
  return {
    status,
    posts: state.posts,
    cursors: state.cursors,
    usage: { postReads: state.postReads, usd: state.usd },
    audit: state.audit,
  };
}

function statusReason<T extends XApiDegradedReason>(
  status: number,
  fallback: T,
): T | "auth_failed" | "rate_limited" {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  return fallback;
}

function anomaly(
  detail: string,
  chargedPostReads: number,
): {
  ok: false;
  reason: "response_anomaly";
  detail: string;
  chargedPostReads: number;
} {
  return {
    ok: false,
    reason: "response_anomaly",
    detail,
    chargedPostReads,
  };
}

function greatestId(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function sourceContext(
  source: XApiSource,
): Pick<XApiContinuation, "sinceId" | "startTime"> {
  const context = source.continuation ?? source;
  return context.sinceId
    ? { sinceId: context.sinceId }
    : { startTime: context.startTime };
}

function validateContinuation(
  continuation: XApiContinuation,
): string | undefined {
  if (
    (continuation.sinceId === undefined) ===
    (continuation.startTime === undefined)
  ) {
    return "continuation requires exactly one sinceId or startTime";
  }
  if (
    continuation.sinceId !== undefined &&
    !/^\d+$/.test(continuation.sinceId)
  ) {
    return "continuation requires a numeric sinceId";
  }
  if (
    continuation.startTime !== undefined &&
    Number.isNaN(Date.parse(continuation.startTime))
  ) {
    return "continuation requires a valid startTime";
  }
  if (!continuation.paginationToken) {
    return "continuation requires a paginationToken";
  }
  if (!/^\d+$/.test(continuation.pendingNewestId)) {
    return "continuation requires a numeric pendingNewestId";
  }
  if (
    continuation.sinceId !== undefined &&
    BigInt(continuation.pendingNewestId) < BigInt(continuation.sinceId)
  ) {
    return "continuation pendingNewestId cannot precede sinceId";
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function usageInteger(value: unknown): number | undefined {
  if (typeof value === "number") return number(value);
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function numericString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function optionalNumericString(value: unknown): string | undefined {
  return numericString(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function money(value: number): number {
  return Number(value.toFixed(6));
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
