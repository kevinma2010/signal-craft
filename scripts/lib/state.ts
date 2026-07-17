import { createHash } from "node:crypto";
import { writeTextAtomic } from "./files";
import type { SourceDefinition } from "./types";
import { normalizeUrl } from "./url";
import { loadVersionedFile, type Migration } from "./versioned-file";

export const STATE_VERSION = 2;

export interface CategoryState {
  last_success_at?: string;
}

export interface SourceHealth {
  consecutive_failures: number;
  last_failure_at?: string;
  last_error?: string;
}

export interface CollectionCheckpoint {
  covered_through: string;
  cursor?: string;
  last_success_at: string;
}

export type CollectionSource = Pick<
  SourceDefinition,
  "id" | "url" | "handle" | "query"
>;

export interface CollectionSuccess {
  coveredThrough: Date | string;
  cursor?: string | null;
  succeededAt?: Date | string;
}

export interface SignalCraftState {
  version: typeof STATE_VERSION;
  categories: Record<string, CategoryState>;
  sources: Record<string, SourceHealth>;
  checkpoints: Record<string, CollectionCheckpoint>;
}

const migrations = new Map<number, Migration>([
  [
    0,
    (data) => {
      const legacy = isRecord(data) ? data : {};
      const lastSuccess = isRecord(legacy.last_success)
        ? legacy.last_success
        : {};
      const failures = isRecord(legacy.source_failures)
        ? legacy.source_failures
        : {};
      return {
        version: 1,
        categories: Object.fromEntries(
          Object.entries(lastSuccess)
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            )
            .map(([category, timestamp]) => [
              category,
              { last_success_at: timestamp },
            ]),
        ),
        sources: Object.fromEntries(
          Object.entries(failures)
            .filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" &&
                Number.isInteger(entry[1]) &&
                entry[1] >= 0,
            )
            .map(([source, count]) => [
              source,
              { consecutive_failures: count },
            ]),
        ),
      };
    },
  ],
  [
    1,
    (data) => {
      const state = isRecord(data) ? data : {};
      return {
        version: 2,
        categories: state.categories ?? {},
        sources: state.sources ?? {},
        checkpoints: {},
      };
    },
  ],
]);

export function createState(): SignalCraftState {
  return {
    version: STATE_VERSION,
    categories: {},
    sources: {},
    checkpoints: {},
  };
}

export async function loadState(path: string): Promise<SignalCraftState> {
  return loadVersionedFile({
    path,
    currentVersion: STATE_VERSION,
    createDefault: createState,
    migrations,
    validate: validateStateSnapshot,
  });
}

export async function saveState(
  path: string,
  state: SignalCraftState,
): Promise<void> {
  const validated = validateStateSnapshot(state);
  await writeTextAtomic(path, `${JSON.stringify(validated, null, 2)}\n`);
}

export function recordCategorySuccess(
  state: SignalCraftState,
  category: string,
  at = new Date(),
): void {
  state.categories[category] = { last_success_at: at.toISOString() };
}

export function recordSourceSuccess(
  state: SignalCraftState,
  source: string,
): void {
  state.sources[source] = { consecutive_failures: 0 };
}

export function recordSourceFailure(
  state: SignalCraftState,
  source: string,
  error: string,
  at = new Date(),
): number {
  const consecutiveFailures =
    (state.sources[source]?.consecutive_failures ?? 0) + 1;
  state.sources[source] = {
    consecutive_failures: consecutiveFailures,
    last_failure_at: at.toISOString(),
    last_error: error,
  };
  return consecutiveFailures;
}

export function createCollectionCheckpointKey(
  provider: string,
  source: CollectionSource,
): string {
  const normalizedProvider = requireNonEmptyString(provider, "provider");
  const sourceId = requireNonEmptyString(source.id, "source id");
  const coordinates = {
    ...(source.url ? { url: normalizeUrl(source.url) } : {}),
    ...(source.handle ? { handle: normalizeHandle(source.handle) } : {}),
    ...(source.query ? { query: source.query.trim() } : {}),
  };
  if (Object.keys(coordinates).length === 0) {
    throw new Error(
      `Collection source has no retrieval coordinates: ${sourceId}`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(coordinates))
    .digest("hex");
  return `${encodeURIComponent(normalizedProvider)}:${encodeURIComponent(sourceId)}:${fingerprint}`;
}

export function getCollectionCheckpoint(
  state: SignalCraftState,
  provider: string,
  source: CollectionSource,
): CollectionCheckpoint | undefined {
  return state.checkpoints[createCollectionCheckpointKey(provider, source)];
}

export function commitCollectionSuccess(
  state: SignalCraftState,
  provider: string,
  source: CollectionSource,
  success: CollectionSuccess,
): CollectionCheckpoint {
  const key = createCollectionCheckpointKey(provider, source);
  const existing = state.checkpoints[key];
  const coveredThrough = requiredTimestamp(
    success.coveredThrough,
    "covered_through",
  );
  if (
    existing &&
    Date.parse(existing.covered_through) > Date.parse(coveredThrough)
  ) {
    return existing;
  }
  const lastSuccessAt = requiredTimestamp(
    success.succeededAt ?? new Date(),
    "last_success_at",
  );
  const cursor =
    success.cursor === null
      ? undefined
      : success.cursor === undefined
        ? existing?.cursor
        : requireNonEmptyString(success.cursor, "cursor");
  const checkpoint = {
    covered_through: coveredThrough,
    ...(cursor ? { cursor } : {}),
    last_success_at: lastSuccessAt,
  };
  state.checkpoints[key] = checkpoint;
  return checkpoint;
}

export function validateStateSnapshot(data: unknown): SignalCraftState {
  if (
    !isRecord(data) ||
    data.version !== STATE_VERSION ||
    !isRecord(data.categories) ||
    !isRecord(data.sources) ||
    !isRecord(data.checkpoints)
  ) {
    throw new Error("Invalid state.json");
  }
  const categories: Record<string, CategoryState> = {};
  for (const [category, value] of Object.entries(data.categories)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid category state: ${category}`);
    }
    const timestamp = optionalTimestamp(
      value.last_success_at,
      `${category}.last_success_at`,
    );
    categories[category] = timestamp ? { last_success_at: timestamp } : {};
  }
  const sources: Record<string, SourceHealth> = {};
  for (const [source, value] of Object.entries(data.sources)) {
    if (
      !isRecord(value) ||
      !Number.isInteger(value.consecutive_failures) ||
      (value.consecutive_failures as number) < 0
    ) {
      throw new Error(`Invalid source state: ${source}`);
    }
    const lastFailureAt = optionalTimestamp(
      value.last_failure_at,
      `${source}.last_failure_at`,
    );
    const lastError = value.last_error;
    if (lastError !== undefined && typeof lastError !== "string") {
      throw new Error(`Invalid last error for source: ${source}`);
    }
    sources[source] = {
      consecutive_failures: value.consecutive_failures as number,
      ...(lastFailureAt ? { last_failure_at: lastFailureAt } : {}),
      ...(lastError ? { last_error: lastError } : {}),
    };
  }
  const checkpoints: Record<string, CollectionCheckpoint> = {};
  for (const [key, value] of Object.entries(data.checkpoints)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid collection checkpoint: ${key}`);
    }
    const coveredThrough = requiredTimestamp(
      value.covered_through,
      `${key}.covered_through`,
    );
    const lastSuccessAt = requiredTimestamp(
      value.last_success_at,
      `${key}.last_success_at`,
    );
    const cursor = value.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) {
      throw new Error(`Invalid cursor for collection checkpoint: ${key}`);
    }
    checkpoints[key] = {
      covered_through: coveredThrough,
      ...(cursor ? { cursor } : {}),
      last_success_at: lastSuccessAt,
    };
  }
  return { version: STATE_VERSION, categories, sources, checkpoints };
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid timestamp: ${label}`);
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid timestamp: ${label}`);
  }
  return timestamp;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHandle(handle: string): string {
  return requireNonEmptyString(handle, "source handle")
    .replace(/^@/, "")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
