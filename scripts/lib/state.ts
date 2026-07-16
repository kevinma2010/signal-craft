import { writeTextAtomic } from "./files";
import { loadVersionedFile, type Migration } from "./versioned-file";

export const STATE_VERSION = 1;

export interface CategoryState {
  last_success_at?: string;
}

export interface SourceHealth {
  consecutive_failures: number;
  last_failure_at?: string;
  last_error?: string;
}

export interface SignalCraftState {
  version: typeof STATE_VERSION;
  categories: Record<string, CategoryState>;
  sources: Record<string, SourceHealth>;
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
]);

export function createState(): SignalCraftState {
  return { version: STATE_VERSION, categories: {}, sources: {} };
}

export async function loadState(path: string): Promise<SignalCraftState> {
  return loadVersionedFile({
    path,
    currentVersion: STATE_VERSION,
    createDefault: createState,
    migrations,
    validate: validateState,
  });
}

export async function saveState(
  path: string,
  state: SignalCraftState,
): Promise<void> {
  const validated = validateState(state);
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

function validateState(data: unknown): SignalCraftState {
  if (
    !isRecord(data) ||
    data.version !== STATE_VERSION ||
    !isRecord(data.categories) ||
    !isRecord(data.sources)
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
  return { version: STATE_VERSION, categories, sources };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
