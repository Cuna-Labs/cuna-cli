// Test-only installed-package boundary. It imports runCli from the isolated npm
// prefix and replaces only the external browser activation/paste gestures; the
// production session store, HTTP client and command wiring remain installed bytes.
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
  browser: { open: async () => {} },
  readLoginCode: async () => process.env.CUNA_TEST_LOGIN_CODE ?? "",
});
