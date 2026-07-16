import { join } from "node:path";
import { readTextIfExists, writeTextIfAbsent } from "./files";
import { ITEM_TYPES, type ItemType, type NormalizedItem } from "./types";

export const RUN_AUDIT_VERSION = 1;

const RUN_KINDS = [
  "collection",
  "daily",
  "weekly",
  "backfill",
  "ad-hoc",
] as const;
const RUN_STATUSES = ["completed", "partial", "failed"] as const;
const CONTENT_STATUSES = [
  "complete",
  "excerpt",
  "summary",
  "unknown",
  "missing",
] as const;

type ContentStatus = (typeof CONTENT_STATUSES)[number];

export interface RunAudit {
  version: typeof RUN_AUDIT_VERSION;
  run_id: string;
  kind: (typeof RUN_KINDS)[number];
  status: (typeof RUN_STATUSES)[number];
  started_at: string;
  finished_at: string;
  window: { from: string; to: string };
  sources: {
    configured: number;
    covered: number;
    failed: Array<{ source_id: string; code: string }>;
    unattempted: number;
  };
  items: ItemAuditSummary & { archived: number; selected: number };
  processing: {
    transcribed: number;
    translated: number;
    translation_cache_hits: number;
    pre_summarized: number;
  };
  paid_x_api: {
    requests: number;
    post_reads: number;
    estimated_usd: number;
  };
  artifacts: { digest?: string };
  degradation_codes: string[];
}

export interface ItemAuditSummary {
  by_type: Partial<Record<ItemType, number>>;
  x_posts: {
    total: number;
    with_text: number;
    content_status: Partial<Record<ContentStatus, number>>;
  };
}

export function createItemAuditSummary(
  items: readonly NormalizedItem[],
): ItemAuditSummary {
  const byType: Partial<Record<ItemType, number>> = {};
  const contentStatus: Partial<Record<ContentStatus, number>> = {};
  let xPosts = 0;
  let xPostsWithText = 0;
  for (const item of items) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
    if (item.type !== "post") continue;
    xPosts += 1;
    if (item.text.trim()) xPostsWithText += 1;
    const status = readContentStatus(item.extra.content_status);
    contentStatus[status] = (contentStatus[status] ?? 0) + 1;
  }
  return {
    by_type: sortRecord(byType),
    x_posts: {
      total: xPosts,
      with_text: xPostsWithText,
      content_status: sortRecord(contentStatus),
    },
  };
}

export async function writeRunAudit(
  dataDirectory: string,
  record: RunAudit,
): Promise<string> {
  const validated = validateRunAudit(record);
  const path = join(dataDirectory, "runs", `${validated.run_id}.json`);
  if (
    !(await writeTextIfAbsent(path, `${JSON.stringify(validated, null, 2)}\n`))
  ) {
    throw new Error(`Run audit already exists: ${validated.run_id}`);
  }
  return path;
}

export async function readRunAudit(path: string): Promise<RunAudit> {
  const text = await readTextIfExists(path);
  if (text === undefined) throw new Error(`Run audit does not exist: ${path}`);
  return validateRunAudit(JSON.parse(text));
}

function validateRunAudit(value: unknown): RunAudit {
  const record = requireRecord(value, "run audit");
  requireExactKeys(record, [
    "version",
    "run_id",
    "kind",
    "status",
    "started_at",
    "finished_at",
    "window",
    "sources",
    "items",
    "processing",
    "paid_x_api",
    "artifacts",
    "degradation_codes",
  ]);
  if (record.version !== RUN_AUDIT_VERSION)
    throw new Error("Invalid run audit version");
  const runId = requireString(record.run_id, "run_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
    throw new Error("Invalid run_id");
  const startedAt = requireTimestamp(record.started_at, "started_at");
  const finishedAt = requireTimestamp(record.finished_at, "finished_at");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("finished_at must not precede started_at");
  }

  const window = requireRecord(record.window, "window");
  requireExactKeys(window, ["from", "to"]);
  const from = requireTimestamp(window.from, "window.from");
  const to = requireTimestamp(window.to, "window.to");
  if (Date.parse(to) < Date.parse(from))
    throw new Error("Invalid audit window");

  const sources = validateSources(record.sources);
  const items = validateItems(record.items);
  const processing = validateProcessing(record.processing);
  const paidXApi = validatePaidXApi(record.paid_x_api);
  const artifacts = requireRecord(record.artifacts, "artifacts");
  requireExactKeys(artifacts, ["digest"], true);
  const digest = optionalSafePath(artifacts.digest, "artifacts.digest");

  return {
    version: RUN_AUDIT_VERSION,
    run_id: runId,
    kind: requireEnum(record.kind, RUN_KINDS, "kind"),
    status: requireEnum(record.status, RUN_STATUSES, "status"),
    started_at: startedAt,
    finished_at: finishedAt,
    window: { from, to },
    sources,
    items,
    processing,
    paid_x_api: paidXApi,
    artifacts: digest ? { digest } : {},
    degradation_codes: requireCodes(
      record.degradation_codes,
      "degradation_codes",
    ),
  };
}

function validateSources(value: unknown): RunAudit["sources"] {
  const record = requireRecord(value, "sources");
  requireExactKeys(record, ["configured", "covered", "failed", "unattempted"]);
  if (!Array.isArray(record.failed)) throw new Error("Invalid sources.failed");
  const failed = record.failed.map((entry) => {
    const failure = requireRecord(entry, "source failure");
    requireExactKeys(failure, ["source_id", "code"]);
    return {
      source_id: requireString(failure.source_id, "source_id"),
      code: requireCode(failure.code, "failure code"),
    };
  });
  const configured = requireCount(record.configured, "sources.configured");
  const covered = requireCount(record.covered, "sources.covered");
  const unattempted = requireCount(record.unattempted, "sources.unattempted");
  if (covered > configured || unattempted > configured) {
    throw new Error("Source audit counts exceed configured sources");
  }
  return {
    configured,
    covered,
    failed,
    unattempted,
  };
}

function validateItems(value: unknown): RunAudit["items"] {
  const record = requireRecord(value, "items");
  requireExactKeys(record, ["archived", "selected", "by_type", "x_posts"]);
  const byType = validateCountRecord(
    record.by_type,
    ITEM_TYPES,
    "items.by_type",
  );
  const xPosts = requireRecord(record.x_posts, "items.x_posts");
  requireExactKeys(xPosts, ["total", "with_text", "content_status"]);
  const total = requireCount(xPosts.total, "x_posts.total");
  const withText = requireCount(xPosts.with_text, "x_posts.with_text");
  if (withText > total) throw new Error("x_posts.with_text exceeds total");
  const archived = requireCount(record.archived, "items.archived");
  const selected = requireCount(record.selected, "items.selected");
  const statuses = validateCountRecord(
    xPosts.content_status,
    CONTENT_STATUSES,
    "x_posts.content_status",
  );
  if (selected > archived || sumCounts(byType) !== archived) {
    throw new Error("Invalid archived item counts");
  }
  if ((byType.post ?? 0) !== total || sumCounts(statuses) !== total) {
    throw new Error("Invalid X post audit counts");
  }
  return {
    archived,
    selected,
    by_type: byType,
    x_posts: {
      total,
      with_text: withText,
      content_status: statuses,
    },
  };
}

function validateProcessing(value: unknown): RunAudit["processing"] {
  const record = requireRecord(value, "processing");
  requireExactKeys(record, [
    "transcribed",
    "translated",
    "translation_cache_hits",
    "pre_summarized",
  ]);
  return {
    transcribed: requireCount(record.transcribed, "processing.transcribed"),
    translated: requireCount(record.translated, "processing.translated"),
    translation_cache_hits: requireCount(
      record.translation_cache_hits,
      "processing.translation_cache_hits",
    ),
    pre_summarized: requireCount(
      record.pre_summarized,
      "processing.pre_summarized",
    ),
  };
}

function validatePaidXApi(value: unknown): RunAudit["paid_x_api"] {
  const record = requireRecord(value, "paid_x_api");
  requireExactKeys(record, ["requests", "post_reads", "estimated_usd"]);
  const estimatedUsd = record.estimated_usd;
  if (
    typeof estimatedUsd !== "number" ||
    !Number.isFinite(estimatedUsd) ||
    estimatedUsd < 0
  ) {
    throw new Error("Invalid paid_x_api.estimated_usd");
  }
  return {
    requests: requireCount(record.requests, "paid_x_api.requests"),
    post_reads: requireCount(record.post_reads, "paid_x_api.post_reads"),
    estimated_usd: estimatedUsd,
  };
}

function validateCountRecord<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): Partial<Record<T, number>> {
  const record = requireRecord(value, label);
  const allowedSet = new Set<string>(allowed);
  const result: Partial<Record<T, number>> = {};
  for (const [key, count] of Object.entries(record)) {
    if (!allowedSet.has(key)) throw new Error(`Invalid ${label} key: ${key}`);
    result[key as T] = requireCount(count, `${label}.${key}`);
  }
  return sortRecord(result);
}

function readContentStatus(value: unknown): ContentStatus {
  return typeof value === "string" &&
    CONTENT_STATUSES.includes(value as ContentStatus)
    ? (value as ContentStatus)
    : "missing";
}

function requireCodes(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((entry) => requireCode(entry, label));
}

function requireCode(value: unknown, label: string): string {
  const code = requireString(value, label);
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(code))
    throw new Error(`Invalid ${label}`);
  return code;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`Invalid ${label}`);
  return new Date(timestamp).toISOString();
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as T;
}

function optionalSafePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const path = requireString(value, label);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Invalid ${label}`);
  }
  return path;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  optional = false,
): void {
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    (!optional && allowed.some((key) => !keys.includes(key)))
  ) {
    throw new Error("Invalid run audit fields");
  }
}

function sortRecord<T extends string>(
  record: Partial<Record<T, number>>,
): Partial<Record<T, number>> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  ) as Partial<Record<T, number>>;
}

function sumCounts(record: Partial<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(record)) total += count ?? 0;
  return total;
}
