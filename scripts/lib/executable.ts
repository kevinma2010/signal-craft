import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".grok", "bin"),
  join(homedir(), ".bun", "bin"),
];

export function resolveExecutable(
  name: string,
  options: {
    pathLookup?: (name: string) => string | null;
    fallbackDirectories?: readonly string[];
  } = {},
): string | undefined {
  const fromPath = (options.pathLookup ?? Bun.which)(name);
  if (fromPath) return fromPath;
  return (options.fallbackDirectories ?? FALLBACK_DIRECTORIES)
    .map((directory) => join(directory, name))
    .find(isExecutable);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
