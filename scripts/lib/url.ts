import { createHash } from "node:crypto";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "source",
]);

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      TRACKING_PARAMETERS.has(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export function fingerprintUrl(value: string): string {
  return createHash("sha256").update(normalizeUrl(value)).digest("hex");
}

export function createItemId(url: string, publishedAt: string): string {
  return createHash("sha256")
    .update(`${normalizeUrl(url)}${publishedAt}`)
    .digest("hex");
}
