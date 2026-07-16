import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConnectorArgs } from "./lib/cli";
import { collectAndCommitSource } from "./lib/collection";
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
  const githubSources = sources.filter((source) => source.type === "github");
  let failed = 0;
  for (const source of githubSources) {
    const result = await collectAndCommitSource({
      dataDirectory,
      provider: "github",
      source,
      initialSince: args.since,
      through: now,
      outPath: args.out,
      collect: async ({ since, isFirstRun }) => {
        const fetched = await fetchGitHubSources({
          sources: [source],
          since,
          outPath: args.out,
          seenPath: join(dataDirectory, "seen.jsonl"),
          now,
          writeOutput: false,
          maxPages: isFirstRun ? 1 : undefined,
          token: process.env.GITHUB_TOKEN,
          reportError: (message) => console.error(message),
        });
        return {
          items: fetched.items,
          ...(fetched.failed.length > 0
            ? {
                incomplete: fetched.failed.map(({ error }) => error).join("; "),
              }
            : {}),
        };
      },
    });
    if (result.status === "failed") {
      failed += 1;
      console.error(`${source.name}: ${result.error}`);
    } else if (result.status === "partial") {
      console.error(`${source.name}: partial collection: ${result.error}`);
    }
  }
  if (githubSources.length > 0 && failed === githubSources.length) {
    throw new Error("All GitHub sources failed");
  }
}

if (import.meta.main) {
  await main();
}
