import { createServer } from "vite";
import { parseReaderArgs } from "./lib/reader";

export async function main(argv = Bun.argv.slice(2)) {
  const args = parseReaderArgs(argv);
  process.env.SIGNALCRAFT_DATA_DIRECTORY = args.data;
  const server = await createServer({
    server: {
      host: "127.0.0.1",
      port: args.port,
      strictPort: true,
    },
  });
  await server.listen();
  console.log(`SignalCraft reader: http://127.0.0.1:${args.port}`);
  return server;
}

if (import.meta.main) await main();
