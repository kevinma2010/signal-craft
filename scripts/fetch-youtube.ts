import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseConnectorArgs } from "./lib/cli";
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
  const result = await fetchYouTubeSources({
    sources,
    since: args.since,
    outPath: args.out,
    seenPath: join(dataDirectory, "seen.jsonl"),
    cacheDirectory: join(dataDirectory, "cache", "transcripts"),
    budget: resolveTranscriptionBudget(
      configText ? parse(configText) : undefined,
    ),
    now,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    reportError: (message) => console.error(message),
  });
  for (const notice of result.notices) console.error(notice);
}

if (import.meta.main) await main();
