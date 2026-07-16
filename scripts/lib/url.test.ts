import { describe, expect, test } from "bun:test";
import { createItemId, fingerprintUrl, normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  test("removes tracking data and stabilizes query order", () => {
    expect(
      normalizeUrl("https://www.Example.com/post/?utm_source=x&b=2&a=1#top"),
    ).toBe("https://example.com/post?a=1&b=2");
  });

  test("creates stable fingerprints and item ids", () => {
    expect(fingerprintUrl("https://example.com/?utm_medium=email")).toBe(
      fingerprintUrl("https://www.example.com/"),
    );
    expect(
      createItemId("https://example.com", "2026-01-01T00:00:00Z"),
    ).toHaveLength(64);
  });
});
