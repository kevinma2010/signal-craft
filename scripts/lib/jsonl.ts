import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readTextIfExists } from "./files";

export async function readJsonLines<T>(path: string): Promise<T[]> {
  const text = await readTextIfExists(path);
  const values: T[] = [];
  for (const [index, line] of (text?.split("\n") ?? []).entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}`, {
        cause: error,
      });
    }
  }
  return values;
}

export async function appendJsonLines(
  path: string,
  values: readonly unknown[],
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}
