import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import xtermHeadless from "@xterm/headless";

// Explicit local integration evidence, never production or backend proof.
if (process.platform !== "win32" || process.arch !== "x64") {
  console.log(JSON.stringify({ result: "UNVERIFIED", reason: "Windows x64 ConPTY required" }));
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
function argument(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  assert.ok(args[at + 1], `Missing ${name} value`);
  return path.resolve(args[at + 1]);
}
const moduleRoot = argument("--module-root", root);
const ptyRoot = argument("--pty-root", root);
const requirePty = createRequire(path.join(ptyRoot, "test/windows-conpty/package.json"));
const { spawn } = requirePty("node-pty");
const fixture = path.join(import.meta.dirname, "explorer-wait-conpty-fixture.mjs");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const modulePath = path.join(moduleRoot, "dist/machines/explorer.js");
const moduleHash = sha256(modulePath);
const { Terminal } = xtermHeadless;
const waitAdvice = /Keep this Machine running|Checking OpenCode runtime|Waiting for this Machine's OpenCode terminal supervisor/u;
const overviewWaitAdvice = /OpenCode runtime not verified yet|Waiting for this Machine's OpenCode terminal supervisor/u;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCase(state, reason, mode = "navigate") {
  const terminal = new Terminal({ allowProposedApi: true, cols: 128, rows: 32, scrollback: 100 });
  let transcript = "";
  let writeTail = Promise.resolve();
  let exitResult;
  let overflow = false;
  const steps = [];
  const failures = [];
  const childEnv = { TERM: "xterm-256color" };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
    if (process.env[name] !== undefined) childEnv[name] = process.env[name];
  }
  const child = spawn(process.execPath, [fixture, moduleRoot, state, reason, mode], {
    cwd: root, env: childEnv, name: "xterm-256color", cols: 128, rows: 32, useConpty: true, useConptyDll: false,
  });
  child.onData((data) => {
    if (transcript.length + data.length > 2_000_000) { overflow = true; return; }
    transcript += data;
    writeTail = writeTail.then(() => new Promise((resolve) => terminal.write(data, resolve)));
  });
  child.onExit((event) => { exitResult = event; });
  function screen() {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").join("\n");
  }
  async function until(predicate, label, timeout = 8_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await writeTail;
      assert.equal(overflow, false, "ConPTY transcript exceeded bound");
      if (predicate()) return;
      if (exitResult !== undefined) throw new Error(`${label}: child already exited ${exitResult.exitCode}`);
      await pause(15);
    }
    throw new Error(`Timeout: ${label}`);
  }
  function observe(label, oracle) {
    const current = screen();
    steps.push({ label, activeScreen: terminal.buffer.active.type, screen: current });
    try { oracle(current); } catch (error) { failures.push({ label, message: error.message }); }
  }
  try {
    await until(() => screen().includes("No AgentSessions") && !screen().includes("Refreshing live sessions"), "initial inventory");
    observe("overview", (current) => {
      assert.equal(terminal.buffer.active.type, "alternate");
      if (state !== "running") assert.doesNotMatch(current, overviewWaitAdvice);
      else assert.match(current, overviewWaitAdvice, "running positive witness must retain wait status");
    });
    child.write("\u001b[C");
    await until(() => screen().includes("◆── wait-fixture") && screen().includes(` ${state} · observation`), "Right opens exact machine");
    observe("right", (current) => {
      if (state === "running") assert.match(current, /Keep this Machine running/u);
      else assert.doesNotMatch(current, waitAdvice);
      if (state === "error") { assert.match(current, /Delete machine/u); assert.doesNotMatch(current, /Start machine|Stop machine/u); }
    });
    if (mode === "pending-stop") {
      assert.match(screen(), /❯ Stop machine/u, "Enter must target the selected Stop action");
      child.write("\r");
      await until(() => screen().includes("Stopping…"), "Stop remains pending");
      observe("pending-stop", (current) => assert.doesNotMatch(current, waitAdvice));
    }
    child.write("\u001b");
    await until(() => screen().includes("◆── Machines"), "Escape returns to inventory");
    observe("escape", (current) => {
      assert.equal(exitResult, undefined);
      if (mode === "pending-stop") assert.doesNotMatch(current, /Create OpenCode machine|No available machine can open an AgentSession|OpenCode runtime not verified yet|Waiting for this Machine's OpenCode terminal supervisor/u);
    });
    child.write("q");
    await until(() => exitResult !== undefined, "q exits", 5_000);
    await pause(50); await writeTail;
    assert.equal(exitResult.exitCode, 0);
    assert.equal(terminal.buffer.active.type, "normal", "q restores original terminal screen");
    const match = /EXPLORER_FIXTURE_RESULT (\{[^\r\n]+\})/u.exec(transcript);
    assert.ok(match, "child must report restored raw mode and exact mutation ledger");
    const result = JSON.parse(match[1]);
    assert.equal(result.selectionUndefined, true);
    assert.equal(result.rawMode, false);
    assert.deepEqual(result.mutations, mode === "navigate" ? [] : [{ operation: "transition", machineId: "33333333-3333-4333-8333-333333333333", action: "stop" }]);
    return { state, reason, mode, result: failures.length ? "FAIL" : "PASS", failures, steps, exitCode: exitResult.exitCode, restored: true, mutations: result.mutations };
  } catch (error) {
    return { state, reason, mode, result: "FAIL", failures: [...failures, { label: "harness", message: error.message }], steps, screen: screen(), transcriptTail: transcript.slice(-1500) };
  } finally {
    if (exitResult === undefined) { try { child.kill(); } catch {} }
    await writeTail; terminal.dispose();
  }
}
const cases = [];
for (const reason of ["opencode_runtime_unverified", "opencode_supervisor_protocol_unavailable"]) {
  for (const state of ["error", "stopped", "running"]) cases.push(await runCase(state, reason));
  cases.push(await runCase("running", reason, "pending-stop"));
}
const unchanged = sha256(modulePath) === moduleHash;
const passed = cases.filter((item) => item.result === "PASS").length;
const report = JSON.stringify({
  result: passed === cases.length && unchanged ? "PASS" : "FAIL", scope: "LOCAL_CONPTY_WITH_SYNTHETIC_BACKEND",
  node: process.version, platform: process.platform, arch: process.arch, conpty: { useConpty: true, useConptyDll: false },
  moduleRoot, modulePath, moduleHash, moduleUnchangedDuringRun: unchanged, ptyRoot,
  fixtureHash: sha256(fixture), harnessHash: sha256(import.meta.filename), passed, failed: cases.length - passed, cases,
}, null, 2);
// node-pty retains ConPTY reader workers after the child-exit notification.
// Every child has been observed/restored or killed above; drain this report
// before ending the harness process, as the platform acceptance harness does.
process.stdout.write(`${report}\n`, () => process.exit(passed === cases.length && unchanged ? 0 : 1));
