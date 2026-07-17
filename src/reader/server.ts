import { createServerFn } from "@tanstack/react-start";
import {
  listDigests,
  listItems,
  readDigest,
  readItem,
} from "../../scripts/lib/reader";

function dataDirectory(): string {
  const directory = process.env.SIGNALCRAFT_DATA_DIRECTORY;
  if (!directory) throw new Error("SIGNALCRAFT_DATA_DIRECTORY is not set");
  return directory;
}

export const getReaderDigests = createServerFn({ method: "GET" }).handler(
  async () => ({ digests: await listDigests(dataDirectory()) }),
);

export const getReaderItems = createServerFn({ method: "GET" }).handler(() =>
  listItems(dataDirectory(), "zh-CN"),
);

export const getReaderDigest = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(({ data: id }) => readDigest(dataDirectory(), id));

interface ItemInput {
  id: string;
  language?: string;
}

export const getReaderItem = createServerFn({ method: "GET" })
  .validator((input: ItemInput) => input)
  .handler(({ data }) =>
    readItem(dataDirectory(), data.id, data.language ?? "zh-CN"),
  );
