import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { validatePendingCollectionSnapshot } from "./collection";
import {
  DEFAULT_X_API_CONFIG,
  loadXApiConfig,
  type XApiConfig,
} from "./config";
import { resolveExecutable as findExecutable } from "./executable";
import { readTextIfExists } from "./files";
import { loadMergedSources } from "./sources";
import { STATE_VERSION, validateStateSnapshot } from "./state";
import type { SourceDefinition } from "./types";

export type DoctorCheckStatus = "pass" | "info" | "warn" | "fail";
export type DoctorOutcome = "ready" | "degraded" | "blocked";

export interface DoctorCheck {
  section: "Core" | "Configuration" | "Data" | "Capabilities" | "Reader";
  code: string;
  status: DoctorCheckStatus;
  summary: string;
  remedy?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  outcome: DoctorOutcome;
}

export interface DoctorOptions {
  projectDirectory: string;
  dataDirectory: string;
  defaultPackPath: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  bunVersion?: string;
  resolveExecutable?: (name: string) => string | undefined;
  runCommand?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number }>;
  checkPort?: (port: number) => Promise<boolean>;
}

interface Preferences {
  sourceTypes: Set<SourceDefinition["type"]>;
  transcriptionEnabled: boolean;
}

const ALL_SOURCE_TYPES = new Set<SourceDefinition["type"]>([
  "rss",
  "github",
  "youtube",
  "x",
]);
const RUN_LOCK_STALE_MS = 30 * 60 * 1_000;
const READER_PORT = 4317;

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const executable = options.resolveExecutable ?? findExecutable;
  const runCommand = options.runCommand ?? runSubprocess;
  const checkPort = options.checkPort ?? isPortAvailable;

  checks.push(checkBun(options.bunVersion ?? Bun.version));
  checks.push(await checkDependencies(options.projectDirectory));
  checks.push(await checkDataDirectory(options.dataDirectory));

  const configResult = await checkConfiguration(options.dataDirectory);
  checks.push(configResult.check);

  const sourcesResult = await checkSources(
    options.defaultPackPath,
    options.dataDirectory,
  );
  checks.push(sourcesResult.check);

  checks.push(await checkState(options.dataDirectory));
  checks.push(await checkRunLock(options.dataDirectory, now));
  checks.push(await checkPendingCollections(options.dataDirectory));

  const preferences = configResult.preferences ?? {
    sourceTypes: ALL_SOURCE_TYPES,
    transcriptionEnabled: true,
  };
  const sources = sourcesResult.sources ?? [];
  const xApi = configResult.xApi ?? DEFAULT_X_API_CONFIG;
  const youtubeEnabled = hasEnabledSource(sources, preferences, "youtube");
  const githubEnabled = hasEnabledSource(sources, preferences, "github");
  const xSources = preferences.sourceTypes.has("x")
    ? sources.filter((source) => source.type === "x")
    : [];
  const paidXIds = new Set(xApi.enabled ? xApi.sourceIds : []);
  const needsGrok = xSources.some((source) => !paidXIds.has(source.id));
  const needsXApi =
    xApi.enabled && xSources.some((source) => paidXIds.has(source.id));

  const ytDlp = executable("yt-dlp");
  checks.push(
    capabilityExecutableCheck(
      "yt_dlp",
      "yt-dlp",
      youtubeEnabled,
      ytDlp,
      "Install yt-dlp to enable YouTube metadata, subtitles, and audio fallback.",
    ),
  );

  const grok = executable("grok");
  checks.push(
    capabilityExecutableCheck(
      "grok",
      "Grok CLI",
      needsGrok,
      grok,
      "Install Grok Build to enable non-paid X collection and topic discovery.",
    ),
  );
  checks.push(await checkGrokLogin(needsGrok, grok, runCommand));

  checks.push(
    credentialCheck(
      "github_token",
      "GITHUB_TOKEN",
      env.GITHUB_TOKEN,
      false,
      githubEnabled
        ? "Optional; anonymous GitHub limits remain available."
        : "Not required by the enabled source set.",
    ),
  );
  checks.push(
    credentialCheck(
      "deepgram_key",
      "DEEPGRAM_API_KEY",
      env.DEEPGRAM_API_KEY,
      youtubeEnabled && preferences.transcriptionEnabled,
      "Missing fallback transcription credential; native transcripts still work.",
    ),
  );
  checks.push(
    credentialCheck(
      "deepseek_key",
      "DEEPSEEK_API_KEY",
      env.DEEPSEEK_API_KEY,
      false,
      "Optional; full-text localization will be skipped.",
    ),
  );
  checks.push(
    credentialCheck(
      "x_bearer_token",
      "X_BEARER_TOKEN",
      env.X_BEARER_TOKEN,
      needsXApi,
      "Required only for explicitly enabled paid X API sources.",
    ),
  );

  checks.push(await checkReaderPort(checkPort));
  return { checks, outcome: doctorOutcome(checks) };
}

export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  if (report.outcome === "blocked") return 2;
  if (report.outcome === "degraded") return 1;
  return 0;
}

export function renderDoctorReport(report: DoctorReport): string {
  const sections: DoctorCheck["section"][] = [
    "Core",
    "Configuration",
    "Data",
    "Capabilities",
    "Reader",
  ];
  const lines = ["SignalCraft Doctor", ""];
  for (const section of sections) {
    const sectionChecks = report.checks.filter(
      (check) => check.section === section,
    );
    if (sectionChecks.length === 0) continue;
    lines.push(section);
    for (const check of sectionChecks) {
      lines.push(`${statusSymbol(check.status)} ${check.summary}`);
      if (check.remedy) lines.push(`  Fix: ${check.remedy}`);
    }
    lines.push("");
  }
  lines.push(`Result: ${outcomeLabel(report.outcome)}`);
  return `${lines.join("\n")}\n`;
}

export function parseDoctorArgs(
  argv: readonly string[],
  homeDirectory = homedir(),
): { dataDirectory: string } {
  let dataDirectory = join(homeDirectory, ".signalcraft");
  let dataSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--data" || dataSeen || !argv[index + 1]) {
      throw new Error("Usage: bun run doctor -- [--data <path>]");
    }
    dataDirectory = argv[index + 1] as string;
    dataSeen = true;
    index += 1;
  }
  return { dataDirectory };
}

function checkBun(version: string): DoctorCheck {
  return {
    section: "Core",
    code: "bun",
    status: version ? "pass" : "fail",
    summary: version ? `Bun ${version}` : "Bun version unavailable",
    ...(!version ? { remedy: "Run SignalCraft with Bun 1.x." } : {}),
  };
}

async function checkDependencies(
  projectDirectory: string,
): Promise<DoctorCheck> {
  try {
    await access(join(projectDirectory, "node_modules"), constants.R_OK);
    await access(join(projectDirectory, "package.json"), constants.R_OK);
    return {
      section: "Core",
      code: "dependencies",
      status: "pass",
      summary: "Project dependencies installed",
    };
  } catch {
    return {
      section: "Core",
      code: "dependencies",
      status: "fail",
      summary: "Project dependencies are not installed",
      remedy: `Run \`bun install\` in ${projectDirectory}.`,
    };
  }
}

async function checkDataDirectory(dataDirectory: string): Promise<DoctorCheck> {
  try {
    await access(dataDirectory, constants.R_OK | constants.W_OK);
    return {
      section: "Core",
      code: "data_directory",
      status: "pass",
      summary: `Data directory readable and writable: ${dataDirectory}`,
    };
  } catch {
    return {
      section: "Core",
      code: "data_directory",
      status: "fail",
      summary: `Data directory unavailable: ${dataDirectory}`,
      remedy: "Complete first-run setup or restore read/write access.",
    };
  }
}

async function checkConfiguration(dataDirectory: string): Promise<{
  check: DoctorCheck;
  preferences?: Preferences;
  xApi?: XApiConfig;
}> {
  const path = join(dataDirectory, "config.yaml");
  let text: string | undefined;
  try {
    text = await readTextIfExists(path);
  } catch (error) {
    return {
      check: {
        section: "Configuration",
        code: "config",
        status: "fail",
        summary: `config.yaml is unreadable: ${errorMessage(error)}`,
        remedy: "Restore read access before generating another briefing.",
      },
    };
  }
  if (text === undefined) {
    return {
      check: {
        section: "Configuration",
        code: "config",
        status: "fail",
        summary: "config.yaml is missing",
        remedy:
          "Run a manual SignalCraft briefing to complete first-run setup.",
      },
    };
  }
  try {
    const preferences = validatePreferences(parse(text));
    const xApi = await loadXApiConfig(path);
    return {
      check: {
        section: "Configuration",
        code: "config",
        status: "pass",
        summary: "config.yaml is valid",
      },
      preferences,
      xApi,
    };
  } catch (error) {
    return {
      check: {
        section: "Configuration",
        code: "config",
        status: "fail",
        summary: `config.yaml is invalid: ${errorMessage(error)}`,
        remedy: "Correct the configuration before generating another briefing.",
      },
    };
  }
}

async function checkSources(
  defaultPackPath: string,
  dataDirectory: string,
): Promise<{ check: DoctorCheck; sources?: SourceDefinition[] }> {
  const overlayPath = join(dataDirectory, "sources.yaml");
  let overlayText: string | undefined;
  try {
    overlayText = await readTextIfExists(overlayPath);
  } catch (error) {
    return {
      check: {
        section: "Configuration",
        code: "sources",
        status: "fail",
        summary: `sources.yaml is unreadable: ${errorMessage(error)}`,
        remedy: "Restore read access before generating another briefing.",
      },
    };
  }
  if (overlayText === undefined) {
    return {
      check: {
        section: "Configuration",
        code: "sources",
        status: "fail",
        summary: "sources.yaml is missing",
        remedy:
          "Run a manual SignalCraft briefing to complete first-run setup.",
      },
    };
  }
  try {
    const sources = await loadMergedSources(defaultPackPath, overlayPath);
    return {
      check: {
        section: "Configuration",
        code: "sources",
        status: "pass",
        summary: `${sources.length} merged sources are valid`,
      },
      sources,
    };
  } catch (error) {
    return {
      check: {
        section: "Configuration",
        code: "sources",
        status: "fail",
        summary: `Source configuration is invalid: ${errorMessage(error)}`,
        remedy: "Correct sources.yaml or restore sources.default.yaml.",
      },
    };
  }
}

async function checkState(dataDirectory: string): Promise<DoctorCheck> {
  const path = join(dataDirectory, "state.json");
  let text: string | undefined;
  try {
    text = await readTextIfExists(path);
  } catch (error) {
    return {
      section: "Data",
      code: "state",
      status: "fail",
      summary: `state.json is unreadable: ${errorMessage(error)}`,
      remedy: "Restore read access before collection.",
    };
  }
  if (text === undefined) {
    return {
      section: "Data",
      code: "state",
      status: "pass",
      summary: "state.json will be created on the first collection run",
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !Number.isInteger(value.version)) {
      throw new Error("missing or invalid version");
    }
    const version = value.version as number;
    if (version < STATE_VERSION) {
      return {
        section: "Data",
        code: "state",
        status: "warn",
        summary: `state.json version ${version} will be migrated by the next run`,
      };
    }
    if (version > STATE_VERSION) {
      throw new Error(`unsupported version ${version}`);
    }
    validateStateSnapshot(value);
    return {
      section: "Data",
      code: "state",
      status: "pass",
      summary: `state.json version ${version} is readable`,
    };
  } catch (error) {
    return {
      section: "Data",
      code: "state",
      status: "fail",
      summary: `state.json is invalid: ${errorMessage(error)}`,
      remedy: "Restore a valid state file before collection.",
    };
  }
}

async function checkRunLock(
  dataDirectory: string,
  now: Date,
): Promise<DoctorCheck> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(join(dataDirectory, "signalcraft.lock"));
  } catch (error) {
    return {
      section: "Data",
      code: "run_lock",
      status: "warn",
      summary: `The run lock is unreadable: ${errorMessage(error)}`,
      remedy: "Restore read access before starting another run.",
    };
  }
  if (text === undefined) {
    return {
      section: "Data",
      code: "run_lock",
      status: "pass",
      summary: "No run lock is present",
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      typeof value.pid !== "number" ||
      typeof value.started_at !== "string" ||
      Number.isNaN(Date.parse(value.started_at))
    ) {
      throw new Error("invalid lock data");
    }
    const age = now.getTime() - Date.parse(value.started_at);
    return {
      section: "Data",
      code: "run_lock",
      status: "warn",
      summary:
        age > RUN_LOCK_STALE_MS
          ? "A stale run lock is present"
          : `A SignalCraft run may be active (pid ${value.pid})`,
      remedy:
        age > RUN_LOCK_STALE_MS
          ? "A normal SignalCraft run can safely take over this stale lock."
          : "Wait for the active run to finish before starting another.",
    };
  } catch {
    return {
      section: "Data",
      code: "run_lock",
      status: "warn",
      summary: "The run lock is malformed",
      remedy: "Inspect signalcraft.lock before starting another run.",
    };
  }
}

async function checkPendingCollections(
  dataDirectory: string,
): Promise<DoctorCheck> {
  const directory = join(dataDirectory, "cache", "collection-pending");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isMissingPath(error)) {
      return {
        section: "Data",
        code: "pending_collection",
        status: "pass",
        summary: "No pending collection recovery records",
      };
    }
    return {
      section: "Data",
      code: "pending_collection",
      status: "fail",
      summary: `Pending recovery directory is unreadable: ${errorMessage(error)}`,
    };
  }
  if (names.length === 0) {
    return {
      section: "Data",
      code: "pending_collection",
      status: "pass",
      summary: "No pending collection recovery records",
    };
  }
  for (const name of names) {
    try {
      const value: unknown = JSON.parse(
        (await readTextIfExists(join(directory, name))) ?? "",
      );
      validatePendingCollectionSnapshot(value);
    } catch {
      return {
        section: "Data",
        code: "pending_collection",
        status: "fail",
        summary: `Pending recovery record is invalid: ${name}`,
        remedy: `Inspect ${name} before the next collection run.`,
      };
    }
  }
  return {
    section: "Data",
    code: "pending_collection",
    status: "warn",
    summary: `${names.length} pending collection record${names.length === 1 ? "" : "s"} will be recovered by the next run`,
  };
}

function capabilityExecutableCheck(
  code: string,
  label: string,
  required: boolean,
  path: string | undefined,
  remedy: string,
): DoctorCheck {
  if (!required) {
    return {
      section: "Capabilities",
      code,
      status: "pass",
      summary: `${label} is not required by the enabled source set`,
    };
  }
  return path
    ? {
        section: "Capabilities",
        code,
        status: "pass",
        summary: `${label} available`,
      }
    : {
        section: "Capabilities",
        code,
        status: "warn",
        summary: `${label} unavailable`,
        remedy,
      };
}

async function checkGrokLogin(
  required: boolean,
  executable: string | undefined,
  runCommand: NonNullable<DoctorOptions["runCommand"]>,
): Promise<DoctorCheck> {
  if (!required) {
    return {
      section: "Capabilities",
      code: "grok_login",
      status: "pass",
      summary: "Grok login is not required by the enabled source set",
    };
  }
  if (!executable) {
    return {
      section: "Capabilities",
      code: "grok_login",
      status: "info",
      summary: "Grok login not checked because the CLI is unavailable",
    };
  }
  try {
    const result = await runCommand(executable, ["models"]);
    return result.exitCode === 0
      ? {
          section: "Capabilities",
          code: "grok_login",
          status: "pass",
          summary: "Grok login available",
        }
      : {
          section: "Capabilities",
          code: "grok_login",
          status: "warn",
          summary: "Grok login unavailable",
          remedy: "Run `grok login`, then retry doctor.",
        };
  } catch {
    return {
      section: "Capabilities",
      code: "grok_login",
      status: "warn",
      summary: "Grok login check failed",
      remedy: "Run `grok login`, then retry doctor.",
    };
  }
}

function credentialCheck(
  code: string,
  label: string,
  value: string | undefined,
  requiredForCapability: boolean,
  missingSummary: string,
): DoctorCheck {
  if (value) {
    return {
      section: "Capabilities",
      code,
      status: "pass",
      summary: `${label} configured`,
    };
  }
  return {
    section: "Capabilities",
    code,
    status: requiredForCapability ? "warn" : "info",
    summary: `${label} not configured. ${missingSummary}`,
  };
}

async function checkReaderPort(
  checkPort: NonNullable<DoctorOptions["checkPort"]>,
): Promise<DoctorCheck> {
  try {
    const available = await checkPort(READER_PORT);
    return available
      ? {
          section: "Reader",
          code: "reader_port",
          status: "pass",
          summary: `Reader port ${READER_PORT} is available`,
        }
      : {
          section: "Reader",
          code: "reader_port",
          status: "warn",
          summary: `Reader port ${READER_PORT} is already in use`,
          remedy:
            "Stop the existing process or run the reader on another port.",
        };
  } catch {
    return {
      section: "Reader",
      code: "reader_port",
      status: "warn",
      summary: `Reader port ${READER_PORT} could not be checked`,
    };
  }
}

function validatePreferences(value: unknown): Preferences {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("invalid version");
  }
  if (value.frequency !== "daily" && value.frequency !== "weekly") {
    throw new Error("frequency must be daily or weekly");
  }
  if (typeof value.language !== "string" || !value.language.trim()) {
    throw new Error("language must be a non-empty string");
  }
  if (!new Set(["brief", "standard", "deep"]).has(String(value.depth))) {
    throw new Error("depth must be brief, standard, or deep");
  }
  if (!isStringArray(value.interests)) {
    throw new Error("interests must be a string array");
  }
  if (!isStringArray(value.source_types) || value.source_types.length === 0) {
    throw new Error("source_types must be a non-empty string array");
  }
  const sourceTypes = new Set<SourceDefinition["type"]>();
  for (const sourceType of value.source_types) {
    if (!ALL_SOURCE_TYPES.has(sourceType as SourceDefinition["type"])) {
      throw new Error(`unsupported source type: ${sourceType}`);
    }
    sourceTypes.add(sourceType as SourceDefinition["type"]);
  }
  if (
    !isRecord(value.transcription) ||
    typeof value.transcription.enabled !== "boolean" ||
    !Number.isInteger(value.transcription.max_items_per_run) ||
    (value.transcription.max_items_per_run as number) <= 0
  ) {
    throw new Error("transcription settings are invalid");
  }
  if (value.delivery !== "local") {
    throw new Error("delivery must be local");
  }
  return {
    sourceTypes,
    transcriptionEnabled: value.transcription.enabled,
  };
}

function hasEnabledSource(
  sources: readonly SourceDefinition[],
  preferences: Preferences,
  type: SourceDefinition["type"],
): boolean {
  return (
    preferences.sourceTypes.has(type) &&
    sources.some((source) => source.type === type)
  );
}

function doctorOutcome(checks: readonly DoctorCheck[]): DoctorOutcome {
  if (checks.some((check) => check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "degraded";
  return "ready";
}

function statusSymbol(status: DoctorCheckStatus): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "!";
  if (status === "fail") return "✗";
  return "·";
}

function outcomeLabel(outcome: DoctorOutcome): string {
  if (outcome === "blocked") return "BLOCKED";
  if (outcome === "degraded") return "READY WITH DEGRADATIONS";
  return "READY";
}

async function runSubprocess(
  command: string,
  args: readonly string[],
): Promise<{ exitCode: number }> {
  const child = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10_000);
  try {
    const exitCode = await child.exited;
    return { exitCode: timedOut ? 124 : exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
