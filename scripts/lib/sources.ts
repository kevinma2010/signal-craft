import { parse } from "yaml";
import { readTextIfExists } from "./files";
import {
  SOURCE_TYPES,
  SOURCE_USAGES,
  type SourceDefinition,
  type SourceOverlay,
  type SourcePack,
} from "./types";

export async function loadMergedSources(
  defaultPackPath: string,
  overlayPath: string,
): Promise<SourceDefinition[]> {
  const defaultText = await readTextIfExists(defaultPackPath);
  if (defaultText === undefined) {
    throw new Error(`Default source pack not found: ${defaultPackPath}`);
  }
  const overlayText = await readTextIfExists(overlayPath);
  return mergeSources(
    validateSourcePack(parse(defaultText)),
    overlayText === undefined
      ? { version: 1 }
      : validateSourceOverlay(parse(overlayText)),
  );
}

export function mergeSources(
  pack: SourcePack,
  overlay: SourceOverlay,
): SourceDefinition[] {
  if (pack.version !== 1 || overlay.version !== 1) {
    throw new Error("Unsupported source configuration version");
  }

  const sources = new Map(
    pack.sources.map((source) => [source.id, { ...source }]),
  );
  for (const source of overlay.added ?? []) {
    if (sources.has(source.id)) {
      throw new Error(
        `Added source id conflicts with default source: ${source.id}`,
      );
    }
    sources.set(source.id, { ...source });
  }
  for (const [id, weight] of Object.entries(overlay.weights ?? {})) {
    const source = sources.get(id);
    if (source) {
      source.weight = validateWeight(weight, `Weight override for ${id}`);
    }
  }
  for (const id of overlay.disabled ?? []) {
    sources.delete(id);
  }
  return [...sources.values()];
}

export function getSourceMetadata(
  source: SourceDefinition,
): Record<string, unknown> {
  return {
    source_id: source.id,
    source_category: source.category,
    source_weight: source.weight,
    ...(source.tags ? { source_tags: source.tags } : {}),
    ...(source.usage ? { source_usage: source.usage } : {}),
    ...(source.tier ? { source_tier: source.tier } : {}),
  };
}

function validateSourcePack(data: unknown): SourcePack {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources)) {
    throw new Error("Invalid default source pack");
  }
  const sources = data.sources.map(validateSource);
  assertUniqueIds(sources);
  return { version: 1, sources };
}

function validateSourceOverlay(data: unknown): SourceOverlay {
  if (!isRecord(data) || data.version !== 1) {
    throw new Error("Invalid source overlay");
  }
  const added =
    data.added === undefined
      ? undefined
      : requireArray(data.added, "added").map(validateSource);
  if (added) {
    assertUniqueIds(added);
  }
  const disabled =
    data.disabled === undefined
      ? undefined
      : requireArray(data.disabled, "disabled").map((id) =>
          requireString(id, "disabled source id"),
        );
  let weights: Record<string, number> | undefined;
  if (data.weights !== undefined) {
    if (!isRecord(data.weights)) {
      throw new Error("Source weights must be an object");
    }
    weights = Object.fromEntries(
      Object.entries(data.weights).map(([id, weight]) => [
        id,
        validateWeight(weight, `Weight for ${id}`),
      ]),
    );
  }
  return { version: 1, added, disabled, weights };
}

function validateSource(data: unknown): SourceDefinition {
  if (!isRecord(data)) {
    throw new Error("Source must be an object");
  }
  const type = requireString(data.type, "source type");
  if (!SOURCE_TYPES.some((sourceType) => sourceType === type)) {
    throw new Error(`Unsupported source type: ${type}`);
  }
  const url = optionalString(data.url, "source url");
  const handle = optionalString(data.handle, "source handle");
  const query = optionalString(data.query, "source query");
  if (!url && !handle && !query) {
    throw new Error("Source must provide a url, handle, or query");
  }
  if (query && type !== "x") {
    throw new Error("Source queries are only supported for X sources");
  }
  const tags = optionalStringArray(data.tags, "source tags");
  const usage = optionalString(data.usage, "source usage");
  if (usage && !SOURCE_USAGES.some((sourceUsage) => sourceUsage === usage)) {
    throw new Error(`Unsupported source usage: ${usage}`);
  }
  const tier = optionalTier(data.tier);
  const maxResults = optionalPositiveInteger(
    data.max_results,
    "source max_results",
  );
  if (maxResults && type !== "x") {
    throw new Error("Source max_results is only supported for X sources");
  }
  return {
    id: requireString(data.id, "source id"),
    name: requireString(data.name, "source name"),
    type: type as SourceDefinition["type"],
    category: requireString(data.category, "source category"),
    weight: validateWeight(data.weight, "source weight"),
    ...(url ? { url } : {}),
    ...(handle ? { handle } : {}),
    ...(query ? { query } : {}),
    ...(tags ? { tags } : {}),
    ...(usage ? { usage: usage as SourceDefinition["usage"] } : {}),
    ...(tier ? { tier } : {}),
    ...(maxResults ? { maxResults } : {}),
  };
}

function assertUniqueIds(sources: SourceDefinition[]): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`Duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }
}

function validateWeight(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  return requireArray(value, label).map((item) => requireString(item, label));
}

function optionalTier(value: unknown): 1 | 2 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1 && value !== 2) {
    throw new Error("Source tier must be 1 or 2");
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
