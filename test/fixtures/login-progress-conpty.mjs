import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { loginFixture } from "./login-progress.mjs";

const [root, controlPath, phasePath, mode] = process.argv.slice(2);
const phase = (name, details = {}) =>
  appendFileSync(
    phasePath,
    JSON.stringify({ phase: name, at: Date.now(), ...details }) + "\n",
  );
const fixture = await loginFixture(root, {
  phase,
  rejectExchange: mode === "error",
  async hold(stage, signal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      if (JSON.parse(readFileSync(controlPath, "utf8"))[stage] === true) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(
      "Synthetic stage was not released within its test deadline",
    );
  },
});
const { runProcessCli } = await import(
  pathToFileURL(path.join(root, "dist/cli/process-entrypoint.js")).href
);
const signalListeners = new Map();
const signalHost = {
  once(signal, listener) {
    const observed = () => { phase("signal_received", { signal }); listener(); };
    signalListeners.set(listener, observed);
    process.once(signal, observed);
  },
  removeListener(signal, listener) {
    const observed = signalListeners.get(listener);
    if (observed) process.removeListener(signal, observed);
    signalListeners.delete(listener);
  },
};
const code = await runProcessCli(
  [
    "login",
    "--no-color",
    ...(mode === "timeout" ? ["--timeout-ms", "1200"] : []),
  ],
  {
    host: signalHost,
    stdin: process.stdin,
    run: (argv, input) =>
      fixture.runCli(argv, { ...fixture.dependencies, ...input }),
  },
);
phase("command_returned", {
  exit_code: code,
  stored_records: fixture.values.size,
});
fixture.values.clear();
phase("fixture_cleaned", { stored_records: fixture.values.size });
process.exitCode = code;
