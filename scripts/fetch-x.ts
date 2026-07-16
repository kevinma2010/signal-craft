import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveProcessedItems } from "./lib/archive";
import { parseConnectorArgs } from "./lib/cli";
import {
  type CommittedCollectionResult,
  collectAndCommitSource,
} from "./lib/collection";
import {
  DEFAULT_X_API_CONFIG,
  loadXApiConfig,
  type XApiConfig,
} from "./lib/config";
import { withFileLock } from "./lib/file-lock";
import { readJsonLines } from "./lib/jsonl";
import { loadMergedSources } from "./lib/sources";
import {
  commitCollectionSuccess,
  getCollectionCheckpoint,
  loadState,
  saveState,
} from "./lib/state";
import { fetchXSources, readLegacyXSearchThrough } from "./lib/x";
import {
  fetchXApiPosts,
  isXApiContinuationCursor,
  type XApiFetcher,
} from "./lib/x-api";
import {
  appendXApiUsage,
  loadXApiPriorUsage,
  reserveXApiUsage,
} from "./lib/x-api-ledger";
import { createXApiSource, normalizeXApiPost } from "./lib/x-api-normalize";

export async function main(
  argv = Bun.argv.slice(2),
  now = new Date(),
): Promise<void> {
  const args = parseConnectorArgs(argv, now);
  const dataDirectory = dirname(args.config);
  const defaultPackPath = fileURLToPath(
    new URL("../sources.default.yaml", import.meta.url),
  );
  const sources = await loadMergedSources(defaultPackPath, args.config);
  const config = await safeLoadXApiConfig(
    join(dataDirectory, "config.yaml"),
    (message) => console.error(message),
  );
  const xSources = sources.filter((source) => source.type === "x");
  const paidIds = new Set(config.enabled ? config.sourceIds : []);
  const knownIds = new Set(xSources.map((source) => source.id));
  const xApiRunUsage: XApiRunUsage = { postReads: 0, usd: 0 };
  for (const id of paidIds) {
    if (!knownIds.has(id)) {
      console.error(`X API source id is not configured: ${id}`);
    }
  }

  let failed = 0;
  for (const source of xSources) {
    if (!paidIds.has(source.id)) {
      await migrateLegacyGrokCheckpoint(dataDirectory, source, now);
    }
    const paid = paidIds.has(source.id);
    if (paid && !(await isPaidSourceDue(dataDirectory, source, now))) continue;
    let result: CommittedCollectionResult;
    try {
      result = paid
        ? await withFileLock(
            join(dataDirectory, "x-api.lock"),
            () =>
              collectXApiSource({
                source,
                config,
                dataDirectory,
                outPath: args.out,
                initialSince: laterDate(
                  args.since,
                  new Date(now.getTime() - 24 * 60 * 60 * 1_000),
                ),
                now,
                runUsage: xApiRunUsage,
              }),
            { timeoutMs: 1_000, staleMs: 30 * 60 * 1_000 },
          )
        : await collectAndCommitSource({
            dataDirectory,
            provider: "grok",
            source,
            initialSince: args.since,
            through: now,
            outPath: args.out,
            collect: async ({ since }) => {
              const fetched = await fetchXSources({
                sources: [source],
                since,
                outPath: args.out,
                seenPath: join(dataDirectory, "seen.jsonl"),
                now,
                manageSearchState: false,
                writeOutput: false,
                reportError: (message) => console.error(message),
              });
              if (fetched.failed.length > 0 || fetched.degraded) {
                const error =
                  fetched.degraded ??
                  fetched.failed.map((failure) => failure.error).join("; ");
                if (fetched.items.length === 0) throw new Error(error);
                return { items: fetched.items, incomplete: error };
              }
              return { items: fetched.items };
            },
          });
    } catch (error) {
      failed += 1;
      console.error(
        `${source.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (result.status === "failed") {
      failed += 1;
      console.error(`${source.name}: ${result.error}`);
    } else if (result.status === "partial") {
      console.error(`${source.name}: partial collection: ${result.error}`);
    }
  }
  if (xSources.length > 0 && failed === xSources.length) {
    throw new Error("All X sources failed");
  }
}

async function migrateLegacyGrokCheckpoint(
  dataDirectory: string,
  source: Awaited<ReturnType<typeof loadMergedSources>>[number],
  now: Date,
): Promise<void> {
  const statePath = join(dataDirectory, "state.json");
  const state = await loadState(statePath);
  if (getCollectionCheckpoint(state, "grok", source)) return;
  const searchedThrough = await readLegacyXSearchThrough(
    join(dataDirectory, "cache", "x-search-state.json"),
    source,
  );
  if (!searchedThrough) return;
  await withFileLock(join(dataDirectory, "collection-state.lock"), async () => {
    const legacyInbox = await readJsonLines<
      Awaited<ReturnType<typeof fetchXSources>>["items"][number]
    >(join(dataDirectory, "inbox", "x.jsonl"));
    const sourceItems = legacyInbox.filter(
      (item) => item.extra.source_id === source.id,
    );
    if (sourceItems.length === 0) return;
    await archiveProcessedItems(dataDirectory, sourceItems, now);
    const latest = await loadState(statePath);
    if (getCollectionCheckpoint(latest, "grok", source)) return;
    commitCollectionSuccess(latest, "grok", source, {
      coveredThrough: searchedThrough,
      succeededAt: now,
    });
    await saveState(statePath, latest);
  });
}

export async function collectXApiSource(options: {
  source: Awaited<ReturnType<typeof loadMergedSources>>[number];
  config: XApiConfig;
  dataDirectory: string;
  outPath: string;
  initialSince: Date;
  now: Date;
  runUsage: XApiRunUsage;
  bearerToken?: string;
  fetcher?: XApiFetcher;
}) {
  const ledgerPath = join(options.dataDirectory, "cache", "x-api-usage.jsonl");
  return collectAndCommitSource({
    dataDirectory: options.dataDirectory,
    provider: "x-api",
    source: options.source,
    initialSince: options.initialSince,
    through: options.now,
    outPath: options.outPath,
    collect: async ({ since, cursor }) => {
      if (options.runUsage.circuitOpen) {
        throw new Error(
          `X API circuit breaker is open: ${options.runUsage.circuitOpen}`,
        );
      }
      const remainingRunReads =
        options.config.maxPostReadsPerRun - options.runUsage.postReads;
      const remainingRunUsd =
        options.config.maxCostUsdPerRun - options.runUsage.usd;
      if (remainingRunReads <= 0 || remainingRunUsd <= 0) {
        options.runUsage.circuitOpen = "budget_exceeded";
        throw new Error("X API per-run budget exhausted");
      }
      const apiSource = createXApiSource(options.source, {
        sinceId: cursor,
        startTime: since,
      });
      const priorUsage = await loadXApiPriorUsage(ledgerPath, options.now);
      const maxPages = cursor ? options.config.maxPagesPerQuery : 1;
      const reservedReads = (apiSource.maxResults ?? 10) * maxPages;
      const reservedUsd = reservedReads * options.config.costPerPostReadUsd;
      if (
        reservedReads > remainingRunReads ||
        reservedUsd > remainingRunUsd ||
        priorUsage.postReadsToday + reservedReads >
          options.config.maxPostReadsPerDay ||
        priorUsage.postReadsThisMonth + reservedReads >
          options.config.maxPostReadsPerMonth ||
        priorUsage.usdToday + reservedUsd > options.config.maxCostUsdPerDay ||
        priorUsage.usdThisMonth + reservedUsd >
          options.config.maxCostUsdPerMonth
      ) {
        options.runUsage.circuitOpen = "budget_exceeded";
        throw new Error("X API hard budget would be exceeded");
      }
      const reservationId = randomUUID();
      await reserveXApiUsage(ledgerPath, {
        id: reservationId,
        postReads: reservedReads,
        usd: reservedUsd,
        at: options.now,
      });
      const result = await fetchXApiPosts({
        enabled: options.config.enabled,
        bearerToken: options.bearerToken ?? process.env.X_BEARER_TOKEN,
        sources: [apiSource],
        limits: {
          maxPostReadsPerRun: remainingRunReads,
          maxPostReadsPerDay: options.config.maxPostReadsPerDay,
          maxPostReadsPerMonth: options.config.maxPostReadsPerMonth,
          maxUsdPerRun: remainingRunUsd,
          maxUsdPerDay: options.config.maxCostUsdPerDay,
          maxUsdPerMonth: options.config.maxCostUsdPerMonth,
        },
        priorUsage,
        maxPages,
        costPerPostUsd: options.config.costPerPostReadUsd,
        clock: () => options.now,
        fetcher: options.fetcher,
      });
      options.runUsage.postReads += result.usage.postReads;
      options.runUsage.usd += result.usage.usd;
      await appendXApiUsage(ledgerPath, result, options.now, reservationId);
      const resultCursor = result.cursors[options.source.id];
      const hasContinuation =
        resultCursor !== undefined && isXApiContinuationCursor(resultCursor);
      const items = result.posts.map((post) =>
        normalizeXApiPost(post, options.source, options.now),
      );
      if (result.status !== "ok") {
        options.runUsage.circuitOpen = result.reason ?? "unknown failure";
        if (items.length > 0 && hasContinuation) {
          return {
            items,
            cursor: resultCursor,
            coveredThrough: since,
            incomplete: `X API partial collection: ${result.reason}`,
          };
        }
        throw new Error(`X API disabled for this run: ${result.reason}`);
      }
      return {
        items,
        cursor: resultCursor,
        ...(hasContinuation ? { coveredThrough: since } : {}),
      };
    },
  });
}

export interface XApiRunUsage {
  postReads: number;
  usd: number;
  circuitOpen?: string;
}

async function isPaidSourceDue(
  dataDirectory: string,
  source: Awaited<ReturnType<typeof loadMergedSources>>[number],
  now: Date,
): Promise<boolean> {
  const checkpoint = getCollectionCheckpoint(
    await loadState(join(dataDirectory, "state.json")),
    "x-api",
    source,
  );
  if (!checkpoint) return true;
  if (checkpoint.cursor && isXApiContinuationCursor(checkpoint.cursor)) {
    return true;
  }
  const intervalMs =
    source.tier === 2 ? 24 * 60 * 60 * 1_000 : 6 * 60 * 60 * 1_000;
  return now.getTime() - Date.parse(checkpoint.last_success_at) >= intervalMs;
}

async function safeLoadXApiConfig(
  path: string,
  reportError: (message: string) => void,
): Promise<XApiConfig> {
  try {
    return await loadXApiConfig(path);
  } catch (error) {
    reportError(
      `Paid X API configuration rejected; using Grok only: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ...DEFAULT_X_API_CONFIG, sourceIds: [] };
  }
}

function laterDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

if (import.meta.main) {
  await main();
}
