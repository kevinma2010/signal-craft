import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConnectorArgs } from "./lib/cli";
import { collectAndCommitSource } from "./lib/collection";
import { fetchRssSources } from "./lib/rss";
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
  const rssSources = sources.filter((source) => source.type === "rss");
  let failed = 0;
  for (const source of rssSources) {
    const result = await collectAndCommitSource({
      dataDirectory,
      provider: "rss",
      source,
      initialSince: args.since,
      through: now,
      outPath: args.out,
      collect: async ({ since }) => {
        const fetched = await fetchRssSources({
          sources: [source],
          since,
          outPath: args.out,
          seenPath: join(dataDirectory, "seen.jsonl"),
          now,
          writeOutput: false,
          reportError: (message) => console.error(message),
        });
        return { items: fetched.items };
      },
    });
    if (result.status === "failed") {
      failed += 1;
      console.error(`${source.name}: ${result.error}`);
    }
  }
  if (rssSources.length > 0 && failed === rssSources.length) {
    throw new Error("All RSS sources failed");
  }
}

if (import.meta.main) {
  await main();
}
