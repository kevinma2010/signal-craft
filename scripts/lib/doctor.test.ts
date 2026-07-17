import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorExitCode,
  parseDoctorArgs,
  renderDoctorReport,
  runDoctor,
} from "./doctor";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SignalCraft doctor", () => {
  test("reports a healthy configured installation", async () => {
    const fixture = await createDoctorFixture();
    const report = await runDoctor({
      ...fixture,
      env: {
        GITHUB_TOKEN: "github-secret",
        DEEPGRAM_API_KEY: "deepgram-secret",
        DEEPSEEK_API_KEY: "deepseek-secret",
        X_BEARER_TOKEN: "x-secret",
      },
      resolveExecutable: (name) => `/usr/local/bin/${name}`,
      runCommand: async () => ({ exitCode: 0 }),
      checkPort: async () => true,
      bunVersion: "1.3.14",
    });

    expect(doctorExitCode(report)).toBe(0);
    expect(report.outcome).toBe("ready");
    expect(report.checks.map((check) => check.code)).toEqual([
      "bun",
      "dependencies",
      "data_directory",
      "config",
      "sources",
      "state",
      "run_lock",
      "pending_collection",
      "yt_dlp",
      "grok",
      "grok_login",
      "github_token",
      "deepgram_key",
      "deepseek_key",
      "x_bearer_token",
      "reader_port",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBeTrue();

    const output = renderDoctorReport(report);
    expect(output).toContain("Result: READY");
    expect(output).not.toContain("github-secret");
    expect(output).not.toContain("deepgram-secret");
    expect(output).not.toContain("deepseek-secret");
    expect(output).not.toContain("x-secret");
  });

  test("reports enabled capabilities that will degrade", async () => {
    const fixture = await createDoctorFixture({ paidX: false });
    let commandCalls = 0;
    const report = await runDoctor({
      ...fixture,
      env: {},
      resolveExecutable: () => undefined,
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0 };
      },
      checkPort: async () => false,
      bunVersion: "1.3.14",
    });

    expect(doctorExitCode(report)).toBe(1);
    expect(report.outcome).toBe("degraded");
    expect(statusOf(report, "yt_dlp")).toBe("warn");
    expect(statusOf(report, "grok")).toBe("warn");
    expect(statusOf(report, "grok_login")).toBe("info");
    expect(statusOf(report, "deepgram_key")).toBe("warn");
    expect(statusOf(report, "reader_port")).toBe("warn");
    expect(commandCalls).toBe(0);
  });

  test("blocks on missing onboarding files", async () => {
    const fixture = await createDoctorFixture();
    await rm(join(fixture.dataDirectory, "config.yaml"));
    await rm(join(fixture.dataDirectory, "sources.yaml"));

    const report = await runDoctor({
      ...fixture,
      env: {},
      resolveExecutable: () => undefined,
      runCommand: async () => ({ exitCode: 1 }),
      checkPort: async () => true,
      bunVersion: "1.3.14",
    });

    expect(doctorExitCode(report)).toBe(2);
    expect(report.outcome).toBe("blocked");
    expect(statusOf(report, "config")).toBe("fail");
    expect(statusOf(report, "sources")).toBe("fail");
    expect(renderDoctorReport(report)).toContain("Result: BLOCKED");
  });

  test("reports unreadable configuration paths instead of aborting", async () => {
    const fixture = await createDoctorFixture();
    await rm(join(fixture.dataDirectory, "config.yaml"));
    await mkdir(join(fixture.dataDirectory, "config.yaml"));

    const report = await runDoctor({
      ...fixture,
      env: {},
      resolveExecutable: () => undefined,
      runCommand: async () => ({ exitCode: 1 }),
      checkPort: async () => true,
      bunVersion: "1.3.14",
    });

    expect(statusOf(report, "config")).toBe("fail");
    expect(doctorExitCode(report)).toBe(2);
  });

  test("inspects state, locks, and recovery files without modifying them", async () => {
    const fixture = await createDoctorFixture();
    const statePath = join(fixture.dataDirectory, "state.json");
    const lockPath = join(fixture.dataDirectory, "signalcraft.lock");
    const pendingPath = join(
      fixture.dataDirectory,
      "cache",
      "collection-pending",
      "pending.json",
    );
    await mkdir(join(fixture.dataDirectory, "cache", "collection-pending"), {
      recursive: true,
    });
    await writeFile(statePath, '{"version":1,"categories":{},"sources":{}}\n');
    await writeFile(
      lockPath,
      '{"pid":123,"started_at":"2026-07-17T00:00:00.000Z"}\n',
    );
    await writeFile(
      pendingPath,
      JSON.stringify({
        version: 1,
        provider: "rss",
        source: { id: "example-rss" },
        items: [],
        covered_through: "2026-07-17T00:00:00.000Z",
        succeeded_at: "2026-07-17T00:00:00.000Z",
      }),
    );
    const before = {
      state: await readFile(statePath, "utf8"),
      lock: await readFile(lockPath, "utf8"),
      pending: await readFile(pendingPath, "utf8"),
    };

    const report = await runDoctor({
      ...fixture,
      now: new Date("2026-07-17T01:00:00.000Z"),
      env: {
        GITHUB_TOKEN: "set",
        DEEPGRAM_API_KEY: "set",
        DEEPSEEK_API_KEY: "set",
        X_BEARER_TOKEN: "set",
      },
      resolveExecutable: (name) => `/usr/local/bin/${name}`,
      runCommand: async () => ({ exitCode: 0 }),
      checkPort: async () => true,
      bunVersion: "1.3.14",
    });

    expect(statusOf(report, "state")).toBe("warn");
    expect(statusOf(report, "run_lock")).toBe("warn");
    expect(statusOf(report, "pending_collection")).toBe("warn");
    expect(await readFile(statePath, "utf8")).toBe(before.state);
    expect(await readFile(lockPath, "utf8")).toBe(before.lock);
    expect(await readFile(pendingPath, "utf8")).toBe(before.pending);
    await expect(readFile(`${statePath}.v1.bak`, "utf8")).rejects.toThrow();
  });
});

describe("parseDoctorArgs", () => {
  test("uses the SignalCraft data directory by default", () => {
    expect(parseDoctorArgs([], "/home/tester")).toEqual({
      dataDirectory: "/home/tester/.signalcraft",
    });
  });

  test("accepts one data override and rejects unknown arguments", () => {
    expect(parseDoctorArgs(["--data", "/tmp/signals"])).toEqual({
      dataDirectory: "/tmp/signals",
    });
    expect(() => parseDoctorArgs(["--data", "one", "--data", "two"])).toThrow(
      "Usage",
    );
    expect(() => parseDoctorArgs(["--port", "4317"])).toThrow("Usage");
  });
});

async function createDoctorFixture(options: { paidX?: boolean } = {}) {
  directory = await mkdtemp(join(tmpdir(), "signalcraft-doctor-"));
  const projectDirectory = join(directory, "project");
  const dataDirectory = join(directory, "data");
  const defaultPackPath = join(projectDirectory, "sources.default.yaml");
  await mkdir(join(projectDirectory, "node_modules"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(projectDirectory, "package.json"),
    '{"packageManager":"bun@1.3.14"}\n',
  );
  await writeFile(
    defaultPackPath,
    `version: 1
sources:
  - id: example-rss
    name: Example RSS
    type: rss
    category: official
    url: https://example.com/feed.xml
    weight: 1
  - id: example-github
    name: Example GitHub
    type: github
    category: releases
    url: https://github.com/example/project
    weight: 1
  - id: example-youtube
    name: Example YouTube
    type: youtube
    category: video
    url: https://www.youtube.com/channel/example
    weight: 1
  - id: example-x
    name: Example X
    type: x
    category: social
    handle: example
    weight: 1
`,
  );
  await writeFile(
    join(dataDirectory, "config.yaml"),
    `version: 1
frequency: daily
language: zh-CN
depth: standard
interests: []
source_types: [rss, github, youtube, x]
transcription:
  enabled: true
  max_items_per_run: 10
delivery: local
x_api:
  enabled: ${options.paidX === false ? "false" : "true"}
  source_ids: ${options.paidX === false ? "[]" : "[example-x]"}
`,
  );
  await writeFile(
    join(dataDirectory, "sources.yaml"),
    "version: 1\nadded: []\ndisabled: []\nweights: {}\n",
  );
  await writeFile(
    join(dataDirectory, "state.json"),
    '{"version":2,"categories":{},"sources":{},"checkpoints":{}}\n',
  );
  return { projectDirectory, dataDirectory, defaultPackPath };
}

function statusOf(report: Awaited<ReturnType<typeof runDoctor>>, code: string) {
  return report.checks.find((check) => check.code === code)?.status;
}
