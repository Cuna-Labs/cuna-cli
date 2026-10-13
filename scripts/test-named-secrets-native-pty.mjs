import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
const root = path.resolve(import.meta.dirname, "..");
const installed = path.resolve(process.argv[2]);
const audit = path.resolve(process.argv[3]);
const linuxNode = process.argv[4];
assert.equal(typeof linuxNode, "string", "Pass the explicit supported Linux Node executable as argument 4");
assert.ok(path.posix.isAbsolute(linuxNode), "Linux Node executable must be an absolute path");
const toLinux = (value) => "/mnt/" + value[0].toLowerCase() + value.slice(2).replaceAll("\\", "/");
const fixture = path.join(root, "scripts/harness/named-secret-native-fixture.mjs");
const bridge = path.join(root, "scripts/harness/named-secret-unix-pty.py");
const require = createRequire(path.join(root, "test/windows-conpty/package.json"));
const native = require("node-pty");
const password = "NATIVE_CANARY_nativé界🔒\nsecond line";
const expectedHash = createHash("sha256").update(password).digest("hex");
await mkdir(audit, { recursive: true });
const mutant = path.join(audit, "native-pty-mutant-installed");
await cp(installed, mutant, { recursive: true });
const foregroundFile = path.join(mutant, "dist/terminal/foreground.js");
const original = await readFile(foregroundFile, "utf8");
const needle = "this.#secretOverlay?.input(local);";
assert.equal(original.split(needle).length, 2, "negative control must change exactly one actual local-capture site");
await writeFile(foregroundFile, original.replace(needle, needle + " this.#queueOrdinaryInput(local.slice());"));
const hashes = { node: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), installed_foreground: createHash("sha256").update(original).digest("hex"), installed_overlay: createHash("sha256").update(await readFile(path.join(installed, "dist/named-secrets/overlay.js"))).digest("hex"), mutant_foreground: createHash("sha256").update(await readFile(foregroundFile)).digest("hex") };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, name, ms = 8000) { const started = Date.now(); while (Date.now() - started < ms) { if (await predicate()) return; await sleep(20); } throw new Error(name); }
async function json(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } }
const results = [];
for (const platform of ["windows", "unix"]) for (const removedIsolation of [false, true]) {
  const label = `${platform}-${removedIsolation ? "negative-control" : "candidate"}`;
  const outputFile = path.join(audit, `native-pty-${label}-frontend.json`);
  const sinkFile = path.join(audit, `native-pty-${label}-sink.json`);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TERM: "xterm-256color", CUNA_NATIVE_INSTALLED: removedIsolation ? mutant : installed,
    CUNA_NATIVE_RECEIPT: outputFile, CUNA_NATIVE_SINK_RECEIPT: sinkFile, CUNA_NATIVE_NODE_PTY: path.join(root, "test/windows-conpty/package.json"), CUNA_NATIVE_UNIX_BRIDGE: bridge };
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const screen = () => Array.from({ length: terminal.rows }, (_unused, index) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? "").join("\n");
  const maxCounter = () => Math.max(0, ...[...screen().matchAll(/REMOTE_OUTPUT_(\d+)/gu)].map((match) => Number(match[1])));
  let child, exited, nativeInfo; let exitResolve; const exitPromise = new Promise((resolve) => { exitResolve = resolve; });
  const result = { label, class: "LOCAL_EXECUTION", platform, removed_isolation: removedIsolation, oracle: {}, limitation: "PTY input is programmatic, not physical-human input; provider and API authority are disposable fixtures, not production or encrypted DB persistence." };
  try {
    if (platform === "windows") {
      const pty = native.spawn(process.execPath, [fixture], { cols: 80, rows: 24, useConpty: true, env, windowsHide: true });
      child = { write: (text) => pty.write(text), resize: (cols, rows) => pty.resize(cols, rows), kill: () => pty.kill() };
      nativeInfo = { native: "ConPTY", node_pty: "1.1.0", frontend_pid: pty.pid, executable: process.execPath, node_version: process.version };
      pty.onData((data) => terminal.write(data)); pty.onExit((status) => { exited = status.exitCode; exitResolve(); });
    } else {
      const converted = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("CUNA_NATIVE_")).map(([key, value]) => [key, toLinux(value)]));
      const args = ["-d", "Ubuntu-24.04", "--", "env", "TERM=xterm-256color", ...Object.entries(converted).map(([key, value]) => `${key}=${value}`), "python3", toLinux(bridge), linuxNode, toLinux(fixture)];
      const proc = spawn("wsl.exe", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let carry = ""; proc.stdout.on("data", (bytes) => { carry += bytes; const lines = carry.split("\n"); carry = lines.pop(); for (const line of lines) { const row = JSON.parse(line); if (row.kind === "started") nativeInfo = row; else if (row.kind === "data") terminal.write(Buffer.from(row.data, "base64")); else if (row.kind === "exit") exited = row.code; } });
      proc.stderr.on("data", (bytes) => { result.stderr_class = bytes.toString().slice(0, 300); });
      child = { write: (text) => proc.stdin.write(JSON.stringify({ kind: "input", data: Buffer.from(text).toString("base64") }) + "\n"), resize: (cols, rows) => proc.stdin.write(JSON.stringify({ kind: "resize", cols, rows }) + "\n"), kill: () => proc.stdin.write('{"kind":"kill"}\n') };
      proc.on("exit", () => exitResolve());
    }
    await until(() => screen().includes("NATIVE_SINK_READY"), "native provider PTY did not become ready");
    child.write("SAFE_BEFORE\r"); await until(async () => (await json(sinkFile))?.input_bytes > 0, "positive remote PTY input control failed");
    const pidBefore = (await json(sinkFile)).pid;
    child.write("\x11"); await until(() => screen().includes("Secret Name:"), "decoded Ctrl+Q did not open installed popout");
    child.write("NativeSecret\t"); child.write("\x1b[200~" + password + "\x1b[201~");
    await until(() => screen().includes("Password: ********"), "password was not masked");
    result.oracle.masked = !screen().includes("NATIVE_CANARY_");
    const before = maxCounter(); await until(() => maxCounter() > before, "remote output stopped while popout was active"); result.oracle.output_continues = true;
    terminal.resize(64, 16); child.resize(64, 16); await sleep(150);
    child.write("\r\r"); await until(() => screen().includes("Saved in Cuna"), "operation did not confirm via installed API client");
    result.oracle.confirmed = true;
    const current = maxCounter(); child.write("\x1b"); await until(() => !screen().includes("Secret Name:"), "Escape did not close popout");
    await until(() => maxCounter() >= current, "close restored stale viewport"); result.oracle.current_view_restored = true;
    child.write("\x1b[A"); child.write("SAFE_AFTER\r"); await sleep(500);
    result.oracle.first_arrow_after_escape = (await json(sinkFile))?.arrow_seen === true;
    result.oracle.first_input_after_escape = (await json(sinkFile))?.safe_after_seen === true;
    result.oracle.same_fixture_sink_pid = (await json(sinkFile))?.pid === pidBefore;
    child.write("\x1dd"); await Promise.race([exitPromise, sleep(3000)]);
    const api = await json(outputFile); const sink = await json(sinkFile);
    result.api = api; result.sink = sink; result.native = nativeInfo;
    result.oracle.exact_password = api?.password_sha256 === expectedHash;
    result.oracle.repeated_enter_once = api?.api_posts === 1;
    result.oracle.real_resize = api?.resize_calls > 0;
    result.oracle.secret_absent_remote_pty = sink?.canary_seen === false;
    result.oracle.negative_control_detected = removedIsolation ? sink?.canary_seen === true : undefined;
    result.exit_code = exited;
    result.cleanup = exited === 0 ? "CLEAN_EXIT" : "UNVERIFIED_NONZERO_FRONTEND_EXIT";
    result.result = removedIsolation ? result.oracle.negative_control_detected ? "EXPECTED_FAIL_ISOLATION_ORACLE" : "NEGATIVE_CONTROL_FAILED"
      : Object.values(result.oracle).every((value) => value === true || value === undefined) ? "PASS" : "FAIL";
  } catch (error) { result.result = "FAIL"; result.reason = error.message; result.screen_without_payload = screen().replaceAll(password, "[REDACTED]").replaceAll("NATIVE_CANARY_", "[REDACTED]"); }
  finally { if (exited === undefined) child?.kill(); await Promise.race([exitPromise, sleep(2000)]); terminal.dispose(); await writeFile(path.join(audit, `native-pty-${label}-result.json`), JSON.stringify(result, null, 2)); results.push(result); }
}
const summary = { timestamp_utc: new Date().toISOString(), installed, hashes, linux_node: linuxNode, results, scope: "Native PTY fixture acceptance only. No physical-human, pinned real-provider, encrypted DB, production or deployment claim." };
await writeFile(path.join(audit, "native-pty-summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ summary: path.join(audit, "native-pty-summary.json"), results: results.map(({ label, result, reason }) => ({ label, result, reason })) }) + "\n");
process.exit(results.every((row) => (row.result === "PASS" || row.result === "EXPECTED_FAIL_ISOLATION_ORACLE") && row.cleanup === "CLEAN_EXIT") ? 0 : 1);
