import { parse } from "yaml";
import { readTextIfExists } from "./files";

export interface XApiConfig {
  enabled: boolean;
  sourceIds: string[];
  maxPostReadsPerRun: number;
  maxPostReadsPerDay: number;
  maxPostReadsPerMonth: number;
  maxCostUsdPerRun: number;
  maxCostUsdPerDay: number;
  maxCostUsdPerMonth: number;
  maxPagesPerQuery: number;
  costPerPostReadUsd: number;
  failClosed: true;
}

export const DEFAULT_X_API_CONFIG: XApiConfig = {
  enabled: false,
  sourceIds: [],
  maxPostReadsPerRun: 100,
  maxPostReadsPerDay: 200,
  maxPostReadsPerMonth: 4_000,
  maxCostUsdPerRun: 0.5,
  maxCostUsdPerDay: 1,
  maxCostUsdPerMonth: 20,
  maxPagesPerQuery: 1,
  costPerPostReadUsd: 0.005,
  failClosed: true,
};

export async function loadXApiConfig(path: string): Promise<XApiConfig> {
  const text = await readTextIfExists(path);
  if (text === undefined) return { ...DEFAULT_X_API_CONFIG, sourceIds: [] };

  const value: unknown = parse(text);
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Invalid config.yaml version");
  }
  if (value.x_api === undefined) {
    return { ...DEFAULT_X_API_CONFIG, sourceIds: [] };
  }
  if (!isRecord(value.x_api)) {
    throw new Error("config.yaml x_api must be an object");
  }
  const config = value.x_api;
  const failClosed = optionalBoolean(config.fail_closed, true, "fail_closed");
  if (!failClosed) {
    throw new Error("config.yaml x_api.fail_closed must be true");
  }

  return {
    enabled: optionalBoolean(config.enabled, false, "enabled"),
    sourceIds: optionalStringArray(config.source_ids, "source_ids"),
    maxPostReadsPerRun: optionalPositiveNumber(
      config.max_post_reads_per_run,
      DEFAULT_X_API_CONFIG.maxPostReadsPerRun,
      "max_post_reads_per_run",
    ),
    maxPostReadsPerDay: optionalPositiveNumber(
      config.max_post_reads_per_day,
      DEFAULT_X_API_CONFIG.maxPostReadsPerDay,
      "max_post_reads_per_day",
    ),
    maxPostReadsPerMonth: optionalPositiveNumber(
      config.max_post_reads_per_month,
      DEFAULT_X_API_CONFIG.maxPostReadsPerMonth,
      "max_post_reads_per_month",
    ),
    maxCostUsdPerRun: optionalPositiveNumber(
      config.max_cost_usd_per_run,
      DEFAULT_X_API_CONFIG.maxCostUsdPerRun,
      "max_cost_usd_per_run",
    ),
    maxCostUsdPerDay: optionalPositiveNumber(
      config.max_cost_usd_per_day,
      DEFAULT_X_API_CONFIG.maxCostUsdPerDay,
      "max_cost_usd_per_day",
    ),
    maxCostUsdPerMonth: optionalPositiveNumber(
      config.max_cost_usd_per_month,
      DEFAULT_X_API_CONFIG.maxCostUsdPerMonth,
      "max_cost_usd_per_month",
    ),
    maxPagesPerQuery: optionalPositiveInteger(
      config.max_pages_per_query,
      DEFAULT_X_API_CONFIG.maxPagesPerQuery,
      "max_pages_per_query",
    ),
    costPerPostReadUsd: conservativePostReadCost(config.cost_per_post_read_usd),
    failClosed: true,
  };
}

function conservativePostReadCost(value: unknown): number {
  const cost = optionalPositiveNumber(
    value,
    DEFAULT_X_API_CONFIG.costPerPostReadUsd,
    "cost_per_post_read_usd",
  );
  if (cost < DEFAULT_X_API_CONFIG.costPerPostReadUsd) {
    throw new Error(
      `config.yaml x_api.cost_per_post_read_usd must be at least ${DEFAULT_X_API_CONFIG.costPerPostReadUsd}`,
    );
  }
  return cost;
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`config.yaml x_api.${label} must be a boolean`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`config.yaml x_api.${label} must be a string array`);
  }
  return [...new Set(value.map((entry) => (entry as string).trim()))];
}

function optionalPositiveNumber(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config.yaml x_api.${label} must be a positive number`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const parsed = optionalPositiveNumber(value, fallback, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`config.yaml x_api.${label} must be an integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
