import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConnectorArgs } from "./lib/cli";
import { fetchGitHubSources } from "./lib/github";
import { loadMergedSources } from "./lib/sources";

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
  await fetchGitHubSources({
    sources,
    since: args.since,
    outPath: args.out,
    seenPath: join(dataDirectory, "seen.jsonl"),
    now,
    token: process.env.GITHUB_TOKEN,
    reportError: (message) => console.error(message),
  });
}

if (import.meta.main) {
  await main();
}
