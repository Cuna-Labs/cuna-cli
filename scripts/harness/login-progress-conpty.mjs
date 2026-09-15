import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import xterm from "@xterm/headless";
import { SYNTHETIC_LOGIN_CODE } from "../../test/fixtures/login-progress.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("UNVERIFIED: native Windows x64 ConPTY required");
  process.exit(2);
}
const args = process.argv.slice(2),
  root = path.resolve(import.meta.dirname, "../..");
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const moduleRoot = path.resolve(option("--module-root", root));
const ptyRoot = path.resolve(option("--pty-root", root));
const output = path.resolve(
  option("--output", path.join(root, "login-progress-evidence")),
);
mkdirSync(output, { recursive: true });
const { spawn } = createRequire(
  path.join(ptyRoot, "test/windows-conpty/package.json"),
)("node-pty");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
for (const mode of option(
  "--cases",
  "success,cancel,error,cancel-persist,timeout,invalid",
).split(",")) {
  const dir = path.join(output, mode);
  mkdirSync(dir, { recursive: true });
  const control = path.join(dir, "control.json"),
    phasePath = path.join(dir, "phases.jsonl");
  writeFileSync(control, "{}");
  writeFileSync(phasePath, "");
  const terminal = new xterm.Terminal({
    allowProposedApi: true,
    cols: 100,
    rows: 30,
    scrollback: 200,
  });
  let raw = "",
    tail = Promise.resolve(),
    exit;
  const steps = [],
    failures = [];
  const environment = { TERM: "xterm-256color" };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [
      path.join(root, "test/fixtures/login-progress-conpty.mjs"),
      moduleRoot,
      control,
      phasePath,
      mode,
    ],
    {
      cwd: root,
      env: environment,
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      useConpty: true,
      useConptyDll: false,
    },
  );
  child.onData((data) => {
    if (raw.length + data.length > 1_000_000) {
      child.kill();
      return;
    }
    raw += data;
    tail = tail.then(
      () => new Promise((resolve) => terminal.write(data, resolve)),
    );
  });
  child.onExit((event) => {
    exit = event;
  });
  const phases = () =>
    readFileSync(phasePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const seen = (name) => phases().some((row) => row.phase === name);
  const screen = () =>
    Array.from(
      { length: terminal.rows },
      (_, i) =>
        terminal.buffer.active
          .getLine(terminal.buffer.active.viewportY + i)
          ?.translateToString(true) ?? "",
    ).join("\n");
  async function until(predicate, label, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await tail;
      if (predicate()) return;
      if (exit) throw Error(`${label}: exited early ${exit.exitCode}`);
      await pause(15);
    }
    throw Error(`Timed out: ${label}`);
  }
  const observe = (label, check) => {
    const current = screen();
    steps.push({ label, at: Date.now(), screen: current });
    try {
      check(current);
    } catch (error) {
      failures.push({ label, message: error.message });
    }
  };
  const release = (exchange, persistence) => {
    writeFileSync(`${control}.next`, JSON.stringify({ exchange, persistence }));
    renameSync(`${control}.next`, control);
  };
  try {
    await until(
      () => screen().includes("Paste the login code"),
      "hidden prompt",
    );
    observe("before-input", (current) =>
      assert.doesNotMatch(current, /Completing Cuna sign-in/),
    );
    child.write(
      mode === "invalid"
        ? "invalid"
        : `\u001b[200~${SYNTHETIC_LOGIN_CODE}\u001b[201~`,
    );
    await until(() => screen().includes("*******"), "masked paste");
    observe("paste-before-enter", (current) => {
      assert.doesNotMatch(current, /Completing Cuna sign-in/);
      assert.ok(!current.includes(SYNTHETIC_LOGIN_CODE));
    });
    const enteredAt = Date.now();
    child.write("\r");
    if (mode !== "invalid") {
      await until(() => seen("exchange_started"), "exchange entered");
      // Observe the held operation, not a transcript from a prior screen.
      const progressDeadline = Date.now() + 700;
      while (
        Date.now() < progressDeadline &&
        !screen().includes("Completing Cuna sign-in") &&
        !exit
      ) {
        await tail;
        await pause(15);
      }
      observe("after-enter-held-exchange", (current) => {
        assert.match(current, /Completing Cuna sign-in/);
        assert.doesNotMatch(current, /Signed in to Cuna\./);
      });
      if (mode === "cancel") child.write("\u0003");
      else if (mode !== "timeout") {
        release(true, false);
        if (mode !== "error") {
          await until(() => seen("persistence_started"), "persistence entered");
          observe("held-persistence", (current) => {
            assert.match(current, /Completing Cuna sign-in/);
            assert.doesNotMatch(current, /Signed in to Cuna\./);
          });
          if (mode === "cancel-persist") {
            child.write("\u0003");
            await until(() => seen("signal_received"), "actual cancellation signal received");
            const cancellationPaintDeadline = Date.now() + 1500;
            while (Date.now() < cancellationPaintDeadline && !screen().includes("Stopping Cuna sign-in") && !exit) {
              await tail;
              await pause(15);
            }
            assert.equal(
              exit,
              undefined,
              "must reconcile the in-flight local mutation",
            );
            observe("cancellation-settling", (current) =>
              assert.match(current, /Stopping Cuna sign-in/),
            );
          }
          release(true, true);
        }
      }
    }
    await until(() => exit !== undefined, "process exit", 6000);
    await tail;
    observe("final", (current) => {
      assert.doesNotMatch(
        current,
        /Completing Cuna sign-in|Stopping Cuna sign-in/,
      );
      if (mode === "success") assert.match(current, /Signed in to Cuna\./);
      else assert.doesNotMatch(current, /Signed in to Cuna\./);
    });
    assert.equal(exit.exitCode === 0, mode === "success");
    assert.ok(!raw.includes(SYNTHETIC_LOGIN_CODE));
    const final = phases().find((row) => row.phase === "command_returned");
    assert.equal(final.stored_records, mode === "success" ? 1 : 0);
    assert.equal(seen("fixture_cleaned"), true);
    if (mode === "cancel-persist") {
      assert.equal(seen("persisted"), true);
      assert.equal(seen("cleanup_deleted"), true);
      assert.equal(seen("revoked"), true);
    }
    if (mode === "invalid") {
      assert.equal(seen("exchange_started"), false);
      assert.doesNotMatch(raw, /Completing Cuna sign-in/);
    }
    results.push({
      mode,
      entered_at: enteredAt,
      exit: exit.exitCode,
      failures,
      phases: phases(),
      steps,
    });
  } catch (error) {
    failures.push({ label: "harness", message: error.message });
    results.push({
      mode,
      exit: exit?.exitCode,
      failures,
      phases: phases(),
      steps,
    });
  } finally {
    release(true, true);
    if (!exit) {
      child.kill();
      const deadline = Date.now() + 3000;
      while (!exit && Date.now() < deadline) await pause(20);
    }
    await tail;
    writeFileSync(path.join(dir, "raw.txt"), raw);
    writeFileSync(
      path.join(dir, "screens.json"),
      JSON.stringify(steps, null, 2),
    );
    terminal.dispose();
    if (!exit)
      failures.push({ label: "cleanup", message: "child exit not observed" });
  }
}
const hashes = Object.fromEntries(
  [
    "dist/cli/run.js",
    "dist/auth/human-session.js",
    "dist/cli/process-entrypoint.js",
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(moduleRoot, file)))
      .digest("hex"),
  ]),
);
const report = {
  classification: "LOCAL_NATIVE_CONPTY_REAL_CLI_SYNTHETIC_HTTP_MEMORY_STORAGE",
  harness_pid: process.pid,
  module_root: moduleRoot,
  hashes,
  results,
  passed: results.filter((result) => result.failures.length === 0).length,
  failed: results.filter((result) => result.failures.length > 0).length,
};
writeFileSync(
  path.join(output, "report.json"),
  JSON.stringify(report, null, 2),
);
// All child exits were checked above. Close the driver's node-pty pipe handles;
// their lifetime is distinct from the actual CLI processes whose exits we observed.
process.stdout.write(
  JSON.stringify({ passed: report.passed, failed: report.failed }) + "\n",
  () => process.exit(report.failed ? 1 : 0),
);
