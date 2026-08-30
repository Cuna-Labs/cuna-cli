import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanBuildOutput } from "./clean-build-output.mjs";
import { acquireExclusiveBuildLock } from "./lib/exclusive-build-lock.mjs";
import { emitVendoredInfraContractWitness } from "./lib/infra-contract-witness.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const operation = process.argv[2];

/**
 * Node's default `--test-timeout` is Infinity, so a test that awaits something
 * that never arrives does not fail -- it stalls the whole run, and with it
 * `prepack`, which is `typecheck && test`. A hung build is worse than a failing
 * one: a red build names the defect, a stalled build is indistinguishable from
 * a slow machine, and someone eventually kills it and learns nothing.
 *
 * Several tests here gate on a promise the test itself resolves
 * (`await new Promise((resolve) => { release = resolve; })`), so any path where
 * the code under test stops short of the release point hangs forever.
 *
 * The bound is deliberately loose. The slowest test in this suite is the real
 * POSIX shell installer test at ~23.5 s on this machine, so five minutes is
 * roughly twelve times the observed maximum -- generous enough that a slow or
 * loaded CI runner cannot trip it, strict enough that a genuine hang becomes a
 * named failing test instead of a stall.
 */
const TEST_TIMEOUT_MS = 300_000;
const EXPERIMENTAL_CREDENTIAL_TEST_FILES = new Set([
  "local-session-preview.test.mjs",
]);

if (operation !== "build" && operation !== "test") {
  throw new Error("Expected exactly one build operation: build or test.");
}

async function runNode(args, env = process.env) {
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal) => child.kill(signal);
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  try {
    const result = await new Promise((resolveChild, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveChild({ code, signal }));
    });
    if (result.code !== 0) {
      throw new Error(`Build operation child failed with ${result.signal ?? `exit code ${result.code}`}.`);
    }
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

async function productTestFiles() {
  const testDirectory = resolve(repositoryRoot, "test");
  return (await readdir(testDirectory))
    .filter((file) => file.endsWith(".test.mjs") && !EXPERIMENTAL_CREDENTIAL_TEST_FILES.has(file))
    .sort()
    .map((file) => resolve(testDirectory, file));
}

const lock = await acquireExclusiveBuildLock(repositoryRoot);
try {
  // Keep the vendored API identity current for contract diagnostics. Provider
  // admission is deliberately not derived from this local artifact: live
  // capability and runtime observations decide each OpenCode operation.
  await emitVendoredInfraContractWitness(repositoryRoot);
  await cleanBuildOutput(repositoryRoot);
  await runNode([resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  if (operation === "test") {
    // Source-quality tests may exercise a deliberately named development pack,
    // but release-mode installed E2E must receive an immutable candidate
    // directory explicitly. Never let a generic `npm test` silently masquerade
    // as release evidence.
    const testEnvironment = {
      ...process.env,
      ...(process.env.CUNA_E2E_MODE === undefined ? { CUNA_E2E_MODE: "development" } : {}),
    };
    await runNode(["--test", `--test-timeout=${TEST_TIMEOUT_MS}`, ...await productTestFiles()], testEnvironment);
  }
} finally {
  await lock.release();
}
