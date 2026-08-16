// Test-only installed-package boundary for lifecycle diagnostics. It invokes
// the isolated package's process entrypoint unchanged. Optional session traces
// contain only method names/timings/resource types: never arguments, paths,
// output, or credentials.
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installedRoot = process.env.CUNA_TEST_INSTALLED_ROOT;
const receiptPath = process.env.CUNA_TEST_RUNTIME_RECEIPT;
if (!installedRoot || !receiptPath) throw new Error("installed root and runtime receipt are required");

const { runProcessCli } = await import(pathToFileURL(path.join(installedRoot, "dist/cli/process-entrypoint.js")).href);
const receipt = {
  schema_version: 1,
  kind: "installed_runtime_driver",
  run_started_ms: 0,
  operation_events: [],
};
const startedAt = performance.now();
let write = Promise.resolve();
const publish = () => {
  write = write.then(() => writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8"));
  return write;
};

if (process.env.CUNA_TEST_SESSION_TRACE === "true") {
  const { LocalEncryptedSessionBackend } = await import(pathToFileURL(path.join(installedRoot, "dist/credentials/local-session.js")).href);
  for (const method of ["probe", "read", "replace", "compareAndSwap", "compareAndDelete", "delete"]) {
    const original = LocalEncryptedSessionBackend.prototype[method];
    if (typeof original !== "function") continue;
    LocalEncryptedSessionBackend.prototype[method] = async function (...args) {
      const event = { method, started_ms: Math.round(performance.now() - startedAt) };
      receipt.operation_events.push(event);
      await publish();
      try {
        const result = await original.apply(this, args);
        event.finished_ms = Math.round(performance.now() - startedAt);
        event.outcome = "returned";
        await publish();
        return result;
      } catch (error) {
        event.finished_ms = Math.round(performance.now() - startedAt);
        event.outcome = error instanceof Error ? error.name : "error";
        await publish();
        throw error;
      }
    };
  }
}

await publish();
try {
  process.exitCode = await runProcessCli(process.argv.slice(2));
  receipt.run_returned_ms = Math.round(performance.now() - startedAt);
  receipt.exit_code = process.exitCode;
  receipt.active_resource_types = activeResourceTypes();
  await publish();
} catch (error) {
  receipt.run_threw_ms = Math.round(performance.now() - startedAt);
  receipt.error_name = error instanceof Error ? error.name : "unknown";
  receipt.active_resource_types = activeResourceTypes();
  await publish();
  throw error;
}

function activeResourceTypes() {
  if (typeof process.getActiveResourcesInfo !== "function") return ["resource_snapshot_unavailable"];
  const counts = new Map();
  for (const resource of process.getActiveResourcesInfo()) counts.set(resource, (counts.get(resource) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([resource, count]) => `${resource}:${count}`);
}
