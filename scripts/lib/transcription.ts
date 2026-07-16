import { join } from "node:path";
import { resolveExecutable } from "./executable";
import { readTextIfExists, writeTextIfAbsent } from "./files";

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen?smart_format=true";

export interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

export type CommandRunner = (
  command: readonly string[],
) => Promise<CommandResult>;
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TranscriptionBudget {
  remaining: number;
}

export interface TranscriptResult {
  provider: "native" | "deepgram" | "none";
  text: string;
  notice?: string;
}

interface YtDlpMetadata {
  subtitles?: Record<string, Subtitle[]>;
  automatic_captions?: Record<string, Subtitle[]>;
}

interface Subtitle {
  url?: string;
  ext?: string;
}

export async function runCommand(
  command: readonly string[],
): Promise<CommandResult> {
  const executable = command[0] ? resolveExecutable(command[0]) : undefined;
  if (!executable) {
    const error = Object.assign(new Error("Command not found"), {
      code: "ENOENT",
    });
    throw error;
  }
  const process = Bun.spawn([executable, ...command.slice(1)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function transcribeYouTube(options: {
  itemId: string;
  url: string;
  cacheDirectory: string;
  budget: TranscriptionBudget;
  runner?: CommandRunner;
  fetcher?: Fetcher;
  deepgramApiKey?: string;
}): Promise<TranscriptResult> {
  const cachePath = join(
    options.cacheDirectory,
    `${encodeURIComponent(options.itemId)}.json`,
  );
  const cached = await readTextIfExists(cachePath);
  if (cached !== undefined) {
    return JSON.parse(cached) as TranscriptResult;
  }

  const runner = options.runner ?? runCommand;
  const fetcher = options.fetcher ?? fetch;
  let metadata: YtDlpMetadata;
  try {
    const result = await runner([
      "yt-dlp",
      "--dump-single-json",
      "--skip-download",
      options.url,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || `yt-dlp exited ${result.exitCode}`,
      );
    }
    metadata = JSON.parse(
      new TextDecoder().decode(result.stdout),
    ) as YtDlpMetadata;
  } catch (error) {
    if (isMissingCommand(error)) {
      return {
        provider: "none",
        text: "",
        notice: "yt-dlp is unavailable. Install it with: brew install yt-dlp",
      };
    }
    throw error;
  }

  const subtitle =
    pickSubtitle(metadata.subtitles) ??
    pickSubtitle(metadata.automatic_captions);
  if (subtitle?.url) {
    const response = await fetcher(subtitle.url);
    if (response.ok) {
      const result = {
        provider: "native" as const,
        text: subtitleToText(await response.text(), subtitle.ext),
      };
      await cacheResult(cachePath, result);
      return result;
    }
  }

  if (!options.deepgramApiKey || options.budget.remaining <= 0) {
    return { provider: "none", text: "" };
  }
  options.budget.remaining -= 1;
  const audio = await runner([
    "yt-dlp",
    "-f",
    "bestaudio",
    "-o",
    "-",
    options.url,
  ]);
  if (audio.exitCode !== 0) {
    throw new Error(audio.stderr.trim() || `yt-dlp exited ${audio.exitCode}`);
  }
  const result = await transcribeAudio(
    audio.stdout,
    options.deepgramApiKey,
    fetcher,
  );
  await cacheResult(cachePath, result);
  return result;
}

export async function transcribeAudioUrl(options: {
  itemId: string;
  audioUrl: string;
  cacheDirectory: string;
  budget: TranscriptionBudget;
  fetcher?: Fetcher;
  deepgramApiKey?: string;
}): Promise<TranscriptResult> {
  const cachePath = join(
    options.cacheDirectory,
    `${encodeURIComponent(options.itemId)}.json`,
  );
  const cached = await readTextIfExists(cachePath);
  if (cached !== undefined) {
    return JSON.parse(cached) as TranscriptResult;
  }
  if (!options.deepgramApiKey || options.budget.remaining <= 0) {
    return { provider: "none", text: "" };
  }
  options.budget.remaining -= 1;
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(options.audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download failed with status ${response.status}`);
  }
  const result = await transcribeAudio(
    new Uint8Array(await response.arrayBuffer()),
    options.deepgramApiKey,
    fetcher,
  );
  await cacheResult(cachePath, result);
  return result;
}

async function transcribeAudio(
  audio: Uint8Array,
  apiKey: string,
  fetcher: Fetcher,
): Promise<TranscriptResult> {
  const response = await fetcher(DEEPGRAM_URL, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/mpeg" },
    body: Uint8Array.from(audio).buffer,
  });
  if (!response.ok) {
    throw new Error(
      `Deepgram transcription failed with status ${response.status}`,
    );
  }
  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }>;
    };
  };
  const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Deepgram transcription returned no transcript");
  }
  return { provider: "deepgram", text };
}

async function cacheResult(
  path: string,
  result: TranscriptResult,
): Promise<void> {
  await writeTextIfAbsent(path, `${JSON.stringify(result)}\n`);
}

function pickSubtitle(
  groups?: Record<string, Subtitle[]>,
): Subtitle | undefined {
  if (!groups) return undefined;
  for (const language of ["en", "en-US", ...Object.keys(groups)]) {
    const options = groups[language];
    for (const extension of ["vtt", "json3"]) {
      const subtitle = options?.find(
        (candidate) => candidate.url && candidate.ext === extension,
      );
      if (subtitle) return subtitle;
    }
  }
  return undefined;
}

function subtitleToText(value: string, extension?: string): string {
  if (extension === "json3") {
    const payload = JSON.parse(value) as {
      events?: Array<{ segs?: Array<{ utf8?: unknown }> }>;
    };
    return (payload.events ?? [])
      .map((event) =>
        (event.segs ?? [])
          .map((segment) =>
            typeof segment.utf8 === "string" ? segment.utf8 : "",
          )
          .join(""),
      )
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  const lines = value.split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const text = line.replace(/<[^>]+>/g, "").trim();
    if (
      !text ||
      text === "WEBVTT" ||
      /^(Kind|Language):/.test(text) ||
      text.includes("--> ") ||
      /^\d+$/.test(text) ||
      output.at(-1) === text
    )
      continue;
    output.push(text);
  }
  return output.join("\n");
}

function isMissingCommand(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
