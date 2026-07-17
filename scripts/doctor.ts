import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DoctorOptions,
  doctorExitCode,
  parseDoctorArgs,
  renderDoctorReport,
  runDoctor,
} from "./lib/doctor";

export async function main(
  argv = Bun.argv.slice(2),
  dependencies: Partial<
    Pick<
      DoctorOptions,
      | "env"
      | "bunVersion"
      | "resolveExecutable"
      | "runCommand"
      | "checkPort"
      | "now"
    >
  > = {},
): Promise<0 | 1 | 2> {
  const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = parseDoctorArgs(argv);
  const report = await runDoctor({
    projectDirectory,
    dataDirectory: args.dataDirectory,
    defaultPackPath: join(projectDirectory, "sources.default.yaml"),
    ...dependencies,
  });
  console.log(renderDoctorReport(report).trimEnd());
  return doctorExitCode(report);
}

if (import.meta.main) process.exitCode = await main();
