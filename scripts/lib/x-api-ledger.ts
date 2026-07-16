import { appendJsonLines, readJsonLines } from "./jsonl";
import type { XApiAuditRecord, XApiFetchResult, XApiPriorUsage } from "./x-api";

export interface XApiUsageRecord {
  kind?: "result";
  reservation_id?: string;
  at: string;
  status: XApiFetchResult["status"];
  reason?: XApiFetchResult["reason"];
  post_reads: number;
  usd: number;
  audit: XApiAuditRecord[];
}

export interface XApiReservationRecord {
  kind: "reservation";
  reservation_id: string;
  at: string;
  post_reads: number;
  usd: number;
}

export async function loadXApiPriorUsage(
  path: string,
  now = new Date(),
): Promise<XApiPriorUsage> {
  const records = await readJsonLines<unknown>(path);
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const usage: XApiPriorUsage = {
    postReadsToday: 0,
    postReadsThisMonth: 0,
    usdToday: 0,
    usdThisMonth: 0,
  };
  const effective = new Map<string, XApiUsageRecord | XApiReservationRecord>();
  const standalone: XApiUsageRecord[] = [];
  for (const value of records) {
    const record = validateUsageRecord(value);
    if (record.kind === "reservation") {
      effective.set(record.reservation_id, record);
    } else if (record.reservation_id) {
      effective.set(record.reservation_id, record);
    } else {
      standalone.push(record);
    }
  }
  for (const record of [...standalone, ...effective.values()]) {
    const date = new Date(record.at).toISOString().slice(0, 10);
    if (date.slice(0, 7) !== month) continue;
    usage.postReadsThisMonth += record.post_reads;
    usage.usdThisMonth += record.usd;
    if (date === today) {
      usage.postReadsToday += record.post_reads;
      usage.usdToday += record.usd;
    }
  }
  usage.usdToday = money(usage.usdToday);
  usage.usdThisMonth = money(usage.usdThisMonth);
  return usage;
}

export async function appendXApiUsage(
  path: string,
  result: XApiFetchResult,
  at = new Date(),
  reservationId?: string,
): Promise<void> {
  await appendJsonLines(path, [
    {
      at: at.toISOString(),
      ...(reservationId
        ? { kind: "result" as const, reservation_id: reservationId }
        : {}),
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      post_reads: result.usage.postReads,
      usd: result.usage.usd,
      audit: result.audit,
    } satisfies XApiUsageRecord,
  ]);
}

export async function reserveXApiUsage(
  path: string,
  reservation: {
    id: string;
    postReads: number;
    usd: number;
    at?: Date;
  },
): Promise<void> {
  if (
    !reservation.id.trim() ||
    !nonNegativeNumber(reservation.postReads) ||
    !nonNegativeNumber(reservation.usd)
  ) {
    throw new Error("Invalid X API usage reservation");
  }
  await appendJsonLines(path, [
    {
      kind: "reservation",
      reservation_id: reservation.id,
      at: (reservation.at ?? new Date()).toISOString(),
      post_reads: reservation.postReads,
      usd: reservation.usd,
    } satisfies XApiReservationRecord,
  ]);
}

function validateUsageRecord(
  value: unknown,
): XApiUsageRecord | XApiReservationRecord {
  if (!isRecord(value) || !validTimestamp(value.at)) {
    throw new Error("Invalid X API usage ledger record");
  }
  if (value.kind === "reservation") {
    if (
      typeof value.reservation_id !== "string" ||
      !value.reservation_id.trim() ||
      !nonNegativeNumber(value.post_reads) ||
      !nonNegativeNumber(value.usd)
    ) {
      throw new Error("Invalid X API usage reservation");
    }
    return value as unknown as XApiReservationRecord;
  }
  if (value.status !== "ok" && value.status !== "degraded") {
    throw new Error("Invalid X API usage ledger status");
  }
  if (!nonNegativeNumber(value.post_reads) || !nonNegativeNumber(value.usd)) {
    throw new Error("Invalid X API usage ledger amount");
  }
  if (!Array.isArray(value.audit)) {
    throw new Error("Invalid X API usage ledger audit");
  }
  if (
    value.reservation_id !== undefined &&
    (typeof value.reservation_id !== "string" || !value.reservation_id.trim())
  ) {
    throw new Error("Invalid X API usage ledger reservation id");
  }
  return value as unknown as XApiUsageRecord;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
