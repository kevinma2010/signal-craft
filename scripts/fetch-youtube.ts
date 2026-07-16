import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseConnectorArgs } from "./lib/cli";
import { collectAndCommitSource } from "./lib/collection";
import { readTextIfExists } from "./lib/files";
import { loadMergedSources } from "./lib/sources";
import { fetchYouTubeSources, resolveTranscriptionBudget } from "./lib/youtube";

export async function main(
  argv = Bun.argv.slice(2),
  now = new Date(),
): Promise<void> {
  const args = parseConnectorArgs(argv, now);
  const dataDirectory = dirname(args.config);
  const sources = await loadMergedSources(
    fileURLToPath(new URL("../sources.default.yaml", import.meta.url)),
    args.config,
  );
  const configText = await readTextIfExists(join(dataDirectory, "config.yaml"));
  let remainingBudget = resolveTranscriptionBudget(
    configText ? parse(configText) : undefined,
  );
  const youtubeSources = sources.filter((source) => source.type === "youtube");
  let failed = 0;
  for (const source of youtubeSources) {
    const result = await collectAndCommitSource({
      dataDirectory,
      provider: "youtube",
      source,
      initialSince: args.since,
      through: now,
      outPath: args.out,
      collect: async ({ since }) => {
        const fetched = await fetchYouTubeSources({
          sources: [source],
          since,
          outPath: args.out,
          seenPath: join(dataDirectory, "seen.jsonl"),
          cacheDirectory: join(dataDirectory, "cache", "transcripts"),
          budget: remainingBudget,
          writeOutput: false,
          now,
          deepgramApiKey: process.env.DEEPGRAM_API_KEY,
          reportError: (message) => console.error(message),
        });
        remainingBudget = Math.max(0, remainingBudget - fetched.transcribed);
        for (const notice of fetched.notices) console.error(notice);
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
  if (youtubeSources.length > 0 && failed === youtubeSources.length) {
    throw new Error("All YouTube sources failed");
  }
}

if (import.meta.main) await main();
