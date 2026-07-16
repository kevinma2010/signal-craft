import { describe, expect, test } from "bun:test";
import { parseConnectorArgs } from "./cli";

describe("parseConnectorArgs", () => {
  test("parses the connector contract", () => {
    const args = parseConnectorArgs(
      [
        "--config",
        "/tmp/sources.yaml",
        "--since",
        "2026-01-15T00:00:00Z",
        "--out",
        "/tmp/rss.jsonl",
      ],
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(args.config).toBe("/tmp/sources.yaml");
    expect(args.since.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(args.out).toBe("/tmp/rss.jsonl");
  });

  test("caps lookback at 30 days", () => {
    const args = parseConnectorArgs(
      [
        "--config",
        "sources.yaml",
        "--since",
        "2020-01-01T00:00:00Z",
        "--out",
        "rss.jsonl",
      ],
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(args.since.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  test("rejects incomplete arguments", () => {
    expect(() => parseConnectorArgs(["--config", "sources.yaml"])).toThrow(
      "Usage",
    );
  });
});
