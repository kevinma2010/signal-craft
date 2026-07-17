import { createReaderHandler } from "../../scripts/lib/reader";

const handler = createReaderHandler({
  get dataDirectory() {
    const directory = process.env.SIGNALCRAFT_DATA_DIRECTORY;
    if (!directory) throw new Error("SIGNALCRAFT_DATA_DIRECTORY is not set");
    return directory;
  },
});

export function handleReaderApi(request: Request): Promise<Response> {
  return handler(request);
}
