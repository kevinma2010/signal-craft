import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { archiveProcessedItems } from "./archive";
import { withFileLock } from "./file-lock";
import { readTextIfExists, writeTextAtomic } from "./files";
import { appendJsonLines, readJsonLines } from "./jsonl";
import {
  commitCollectionSuccess,
  getCollectionCheckpoint,
  loadState,
  recordSourceFailure,
  recordSourceSuccess,
  saveState,
} from "./state";
import type { NormalizedItem, SourceDefinition } from "./types";
import { normalizeUrl } from "./url";

export interface SourceCollectionResult {
  items: NormalizedItem[];
  cursor?: string;
  coveredThrough?: Date;
  incomplete?: string;
}

export interface CommittedCollectionResult {
  status: "collected" | "partial" | "already-covered" | "failed";
  items: NormalizedItem[];
  archived: number;
  error?: string;
  stagingError?: string;
}

export interface CollectAndCommitOptions {
  dataDirectory: string;
  provider: string;
  source: SourceDefinition;
  initialSince: Date;
  maxInitialLookbackMs?: number | null;
  through?: Date;
  outPath?: string;
  collect: (input: {
    since: Date;
    through: Date;
    cursor?: string;
    isFirstRun: boolean;
  }) => Promise<SourceCollectionResult>;
}

export async function collectAndCommitSource(
  options: CollectAndCommitOptions,
): Promise<CommittedCollectionResult> {
  const through = options.through ?? new Date();
  const statePath = join(options.dataDirectory, "state.json");
  const pendingPath = collectionPendingPath(options);
  await recoverPendingCollection(options, statePath, pendingPath);
  const state = await loadState(statePath);
  const checkpoint = getCollectionCheckpoint(
    state,
    options.provider,
    options.source,
  );
  const initialSince = checkpoint
    ? options.initialSince
    : boundedInitialSince(
        options.initialSince,
        through,
        options.maxInitialLookbackMs === undefined
          ? 24 * 60 * 60 * 1_000
          : options.maxInitialLookbackMs,
      );
  const since = laterDate(
    initialSince,
    checkpoint ? new Date(checkpoint.covered_through) : undefined,
  );
  if (since >= through) {
    return { status: "already-covered", items: [], archived: 0 };
  }

  let result: SourceCollectionResult;
  try {
    result = await options.collect({
      since,
      through,
      isFirstRun: !checkpoint,
      ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(options, statePath, message, through);
    return {
      status: "failed",
      items: [],
      archived: 0,
      error: message,
    };
  }

  let archived: number;
  const transaction: {
    step: "archive" | "staging" | "checkpoint";
  } = { step: "archive" };
  try {
    validateCollectionItems(result.items);
    archived = await withFileLock(
      join(options.dataDirectory, "collection-state.lock"),
      async () => {
        const pending: PendingCollection = {
          version: 1,
          provider: options.provider,
          source: options.source,
          items: result.items,
          covered_through: (
            result.coveredThrough ?? (result.incomplete ? since : through)
          ).toISOString(),
          ...(result.cursor ? { cursor: result.cursor } : {}),
          succeeded_at: through.toISOString(),
          ...(result.incomplete ? { incomplete: result.incomplete } : {}),
          ...(options.outPath ? { out_path: options.outPath } : {}),
        };
        await writeTextAtomic(pendingPath, `${JSON.stringify(pending)}\n`);
        const count = await archiveProcessedItems(
          options.dataDirectory,
          result.items,
          through,
        );
        transaction.step = "staging";
        await stagePendingItems(pending);
        transaction.step = "checkpoint";
        await commitPendingCollection(statePath, pending);
        await rm(pendingPath, { force: true });
        return count;
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(options, statePath, message, through);
    return {
      status: "failed",
      items: [],
      archived: 0,
      error: message,
      ...(transaction.step === "staging" ? { stagingError: message } : {}),
    };
  }
  return {
    status: result.incomplete ? "partial" : "collected",
    items: result.items,
    archived,
    ...(result.incomplete ? { error: result.incomplete } : {}),
  };
}

interface PendingCollection {
  version: 1;
  provider: string;
  source: SourceDefinition;
  items: NormalizedItem[];
  covered_through: string;
  cursor?: string;
  succeeded_at: string;
  incomplete?: string;
  out_path?: string;
}

async function recoverPendingCollection(
  options: CollectAndCommitOptions,
  statePath: string,
  pendingPath: string,
): Promise<void> {
  await withFileLock(
    join(options.dataDirectory, "collection-state.lock"),
    async () => {
      const text = await readTextIfExists(pendingPath);
      if (text === undefined) return;
      const persisted = validatePendingCollection(JSON.parse(text));
      const pending =
        persisted.out_path || !options.outPath
          ? persisted
          : { ...persisted, out_path: options.outPath };
      await archiveProcessedItems(
        options.dataDirectory,
        pending.items,
        new Date(pending.succeeded_at),
      );
      await stagePendingItems(pending);
      await commitPendingCollection(statePath, pending);
      await rm(pendingPath, { force: true });
    },
  );
}

async function stagePendingItems(pending: PendingCollection): Promise<void> {
  if (!pending.out_path || pending.items.length === 0) return;
  const staged = await readJsonLines<NormalizedItem>(pending.out_path);
  const stagedIds = new Set(staged.map((item) => item.id));
  const stagedUrls = new Set(staged.map((item) => normalizeUrl(item.url)));
  const additions = pending.items.filter((item) => {
    const url = normalizeUrl(item.url);
    if (stagedIds.has(item.id) || stagedUrls.has(url)) return false;
    stagedIds.add(item.id);
    stagedUrls.add(url);
    return true;
  });
  await appendJsonLines(pending.out_path, additions);
}

async function commitPendingCollection(
  statePath: string,
  pending: PendingCollection,
): Promise<void> {
  const latest = await loadState(statePath);
  commitCollectionSuccess(latest, pending.provider, pending.source, {
    coveredThrough: pending.covered_through,
    cursor: pending.cursor,
    succeededAt: pending.succeeded_at,
  });
  if (pending.incomplete) {
    recordSourceFailure(
      latest,
      pending.source.id,
      pending.incomplete,
      new Date(pending.succeeded_at),
    );
  } else {
    recordSourceSuccess(latest, pending.source.id);
  }
  await saveState(statePath, latest);
}

function collectionPendingPath(options: CollectAndCommitOptions): string {
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        provider: options.provider,
        id: options.source.id,
        url: options.source.url,
        handle: options.source.handle,
        query: options.source.query,
      }),
    )
    .digest("hex");
  return join(
    options.dataDirectory,
    "cache",
    "collection-pending",
    `${identity}.json`,
  );
}

function validateCollectionItems(items: readonly NormalizedItem[]): void {
  for (const item of items) {
    if (Number.isNaN(Date.parse(item.published_at))) {
      throw new Error(`Invalid item published_at: ${item.id}`);
    }
    new URL(item.url);
  }
}

function validatePendingCollection(value: unknown): PendingCollection {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    !("source" in value) ||
    typeof value.source !== "object" ||
    value.source === null ||
    !("items" in value) ||
    !Array.isArray(value.items) ||
    !("covered_through" in value) ||
    typeof value.covered_through !== "string" ||
    Number.isNaN(Date.parse(value.covered_through)) ||
    !("succeeded_at" in value) ||
    typeof value.succeeded_at !== "string" ||
    Number.isNaN(Date.parse(value.succeeded_at)) ||
    ("out_path" in value && typeof value.out_path !== "string")
  ) {
    throw new Error(`Invalid pending collection transaction`);
  }
  return value as PendingCollection;
}

async function recordFailure(
  options: CollectAndCommitOptions,
  statePath: string,
  message: string,
  at: Date,
): Promise<void> {
  await withFileLock(
    join(options.dataDirectory, "collection-state.lock"),
    async () => {
      const latest = await loadState(statePath);
      recordSourceFailure(latest, options.source.id, message, at);
      await saveState(statePath, latest);
    },
  );
}

function laterDate(left: Date, right?: Date): Date {
  return right && right > left ? right : left;
}

function boundedInitialSince(
  requested: Date,
  through: Date,
  maxLookbackMs: number | null,
): Date {
  if (maxLookbackMs === null) return requested;
  const floor = new Date(through.getTime() - maxLookbackMs);
  return requested > floor ? requested : floor;
}
