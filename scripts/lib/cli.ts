const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ConnectorArgs {
  config: string;
  since: Date;
  out: string;
}

export function parseConnectorArgs(
  argv: readonly string[],
  now = new Date(),
): ConnectorArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag ||
      !value ||
      !["--config", "--since", "--out"].includes(flag) ||
      values.has(flag)
    ) {
      throw new Error("Usage: --config <path> --since <ISO8601> --out <path>");
    }
    values.set(flag, value);
  }

  const config = values.get("--config");
  const sinceValue = values.get("--since");
  const out = values.get("--out");
  if (!config || !sinceValue || !out || values.size !== 3) {
    throw new Error("Usage: --config <path> --since <ISO8601> --out <path>");
  }

  const requestedSince = new Date(sinceValue);
  if (Number.isNaN(requestedSince.getTime())) {
    throw new Error("--since must be a valid ISO8601 timestamp");
  }
  const earliest = new Date(now.getTime() - MAX_LOOKBACK_MS);
  return {
    config,
    since: requestedSince < earliest ? earliest : requestedSince,
    out,
  };
}
