import { copyFile } from "node:fs/promises";
import { readTextIfExists, writeTextAtomic } from "./files";

export interface VersionedData {
  version: number;
}

export type Migration = (data: unknown) => VersionedData;

interface LoadVersionedOptions<T extends VersionedData> {
  path: string;
  currentVersion: number;
  createDefault: () => T;
  migrations: ReadonlyMap<number, Migration>;
  validate: (data: unknown) => T;
}

export async function loadVersionedFile<T extends VersionedData>(
  options: LoadVersionedOptions<T>,
): Promise<T> {
  const text = await readTextIfExists(options.path);
  if (text === undefined) {
    return options.createDefault();
  }

  let data: unknown = JSON.parse(text);
  let version = readVersion(data);
  const needsMigration = version < options.currentVersion;
  if (version > options.currentVersion) {
    throw new Error(
      `Unsupported version ${version} in ${options.path}; expected at most ${options.currentVersion}`,
    );
  }

  if (needsMigration) {
    await copyFile(options.path, `${options.path}.v${version}.bak`);
  }

  while (version < options.currentVersion) {
    const migrate = options.migrations.get(version);
    if (!migrate) {
      throw new Error(
        `No migration from version ${version} for ${options.path}`,
      );
    }
    data = migrate(data);
    const nextVersion = readVersion(data);
    if (nextVersion !== version + 1) {
      throw new Error(
        `Migration from version ${version} must produce version ${version + 1}`,
      );
    }
    version = nextVersion;
  }

  const validated = options.validate(data);
  if (needsMigration) {
    await writeTextAtomic(
      options.path,
      `${JSON.stringify(validated, null, 2)}\n`,
    );
  }
  return validated;
}

function readVersion(data: unknown): number {
  if (typeof data !== "object" || data === null || !("version" in data)) {
    return 0;
  }
  const version = data.version;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new Error("Version must be a non-negative integer");
  }
  return version as number;
}
