// Test-only boundary: import the installed package and replace only the host
// terminal runner with a bounded no-op. Authentication, dispatch, validation,
// and HTTP authority remain the installed artifact.
import path from "node:path";
import { pathToFileURL } from "node:url";

const installedRoot = process.env.CUNA_TEST_INSTALLED_ROOT;
if (!installedRoot) throw new Error("CUNA_TEST_INSTALLED_ROOT is required");
const { runCli } = await import(pathToFileURL(path.join(installedRoot, "dist/cli/run.js")).href);
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
}
process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  foregroundTerminalRunner: async () => {},
});
