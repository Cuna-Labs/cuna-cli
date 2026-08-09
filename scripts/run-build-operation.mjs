import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanBuildOutput } from "./clean-build-output.mjs";
import { acquireExclusiveBuildLock } from "./lib/exclusive-build-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const operation = process.argv[2];

if (operation !== "build" && operation !== "test") {
  throw new Error("Expected exactly one build operation: build or test.");
}

async function runNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
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

const lock = await acquireExclusiveBuildLock(repositoryRoot);
try {
  await cleanBuildOutput(repositoryRoot);
  await runNode([resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  if (operation === "test") await runNode(["--test", "test/*.test.mjs"]);
} finally {
  await lock.release();
}
