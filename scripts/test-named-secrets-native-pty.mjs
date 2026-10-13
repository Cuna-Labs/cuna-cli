import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
async function receipt(file, runId) { const row = await json(file); return row?.run_id === runId ? row : undefined; }
function verifiedCleanExit(dead, exited, api) {
  return dead && exited === 0 && api?.stage === "closed" && api.fatal === undefined && api.failure_class === undefined;
}
const redact = (text) => text.replaceAll(password, "[REDACTED]").replace(/NATIVE_CANARY_[^\r\n]*/gu, "[REDACTED]");
function reconcilePid(platform, pid, runId) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { pid, state: "UNOBSERVED" };
  if (platform === "windows") {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if(!$p){'ABSENT'}elseif($p.CommandLine -like '*--native-run=${runId}*'){Stop-Process -Id ${pid} -Force; if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){'STILL_PRESENT'}else{'OWNED_STOPPED'}}else{'OWNER_UNVERIFIED'}`;
    return { pid, state: execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  }
  const script = "import os,sys,signal,time; p=int(sys.argv[1]); marker=sys.argv[2].encode(); root='/proc/'+str(p); state='ABSENT'\nif os.path.exists(root):\n cmd=open(root+'/cmdline','rb').read(); state='OWNER_UNVERIFIED'\n if marker in cmd:\n  os.kill(p,signal.SIGTERM); time.sleep(.1); state='OWNED_STOPPED' if not os.path.exists(root) else 'STILL_PRESENT'\nprint(state)";
  return { pid, state: execFileSync("wsl.exe", ["-d", "Ubuntu-24.04", "--", "python3", "-c", script, String(pid), `--native-run=${runId}`], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim() };
}
const results = [];
for (const platform of ["windows", "unix"]) for (const removedIsolation of [false, true]) {
  const label = `${platform}-${removedIsolation ? "negative-control" : "candidate"}`;
  const runId = randomUUID(); const started = Date.now(); const stages = [{ stage: "prelaunch", elapsed_ms: 0 }]; let rawTail = "";
  const outputFile = path.join(audit, `native-pty-${label}-frontend.json`);
  const sinkFile = path.join(audit, `native-pty-${label}-sink.json`);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TERM: "xterm-256color", CUNA_NATIVE_INSTALLED: removedIsolation ? mutant : installed,
    CUNA_NATIVE_RUN_ID: runId, CUNA_NATIVE_RECEIPT: outputFile, CUNA_NATIVE_SINK_RECEIPT: sinkFile, CUNA_NATIVE_NODE_PTY: path.join(root, "test/windows-conpty/package.json"), CUNA_NATIVE_UNIX_BRIDGE: bridge };
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const screen = () => Array.from({ length: terminal.rows }, (_unused, index) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? "").join("\n");
  const maxCounter = () => Math.max(0, ...[...screen().matchAll(/REMOTE_OUTPUT_(\d+)/gu)].map((match) => Number(match[1])));
  let child, exited, nativeInfo; let exitResolve; const exitPromise = new Promise((resolve) => { exitResolve = resolve; });
  const result = { label, class: "LOCAL_EXECUTION", platform, removed_isolation: removedIsolation, oracle: {}, limitation: "PTY input is programmatic, not physical-human input; provider and API authority are disposable fixtures, not production or encrypted DB persistence." };
  try {
    if (platform === "windows") {
      const pty = native.spawn(process.execPath, [fixture, `--native-run=${runId}`], { cols: 80, rows: 24, useConpty: true, env, windowsHide: true });
      child = { write: (text) => pty.write(text), resize: (cols, rows) => pty.resize(cols, rows), kill: () => pty.kill() };
      nativeInfo = { native: "ConPTY", node_pty: "1.1.0", frontend_pid: pty.pid, executable: process.execPath, node_version: process.version };
      pty.onData((data) => { if (!rawTail) stages.push({ stage: "first_data", elapsed_ms: Date.now() - started }); rawTail = redact((rawTail + data).slice(-4096)); terminal.write(data); }); pty.onExit((status) => { exited = status.exitCode; exitResolve(); });
    } else {
      const converted = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("CUNA_NATIVE_")).map(([key, value]) => [key, key === "CUNA_NATIVE_RUN_ID" ? value : toLinux(value)]));
      const args = ["-d", "Ubuntu-24.04", "--", "env", "TERM=xterm-256color", ...Object.entries(converted).map(([key, value]) => `${key}=${value}`), "python3", toLinux(bridge), linuxNode, toLinux(fixture), `--native-run=${runId}`];
      const proc = spawn("wsl.exe", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      result.bridge_launcher_pid = proc.pid;
      let carry = ""; proc.stdout.on("data", (bytes) => { carry += bytes; const lines = carry.split("\n"); carry = lines.pop(); for (const line of lines) { const row = JSON.parse(line); if (row.kind === "started") { nativeInfo = row; stages.push({ stage: "bridge_started", elapsed_ms: Date.now() - started }); } else if (row.kind === "data") { if (!rawTail) stages.push({ stage: "first_data", elapsed_ms: Date.now() - started }); const data = Buffer.from(row.data, "base64"); rawTail = redact((rawTail + data.toString()).slice(-4096)); terminal.write(data); } else if (row.kind === "exit") exited = row.code; } });
      proc.stderr.on("data", (bytes) => { result.stderr = redact(((result.stderr ?? "") + bytes.toString()).slice(-4096)); });
      child = { write: (text) => proc.stdin.write(JSON.stringify({ kind: "input", data: Buffer.from(text).toString("base64") }) + "\n"), resize: (cols, rows) => proc.stdin.write(JSON.stringify({ kind: "resize", cols, rows }) + "\n"), kill: () => proc.stdin.write('{"kind":"kill"}\n') };
      proc.on("exit", () => exitResolve());
      await until(() => nativeInfo !== undefined, "Unix bridge did not start within bounded launch budget", 30000);
    }
    await until(() => screen().includes("NATIVE_SINK_READY"), "native provider PTY did not become ready");
    child.write("SAFE_BEFORE\r"); await until(async () => (await receipt(sinkFile, runId))?.input_bytes > 0, "positive remote PTY input control failed");
    const pidBefore = (await receipt(sinkFile, runId)).pid;
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
    result.oracle.first_arrow_after_escape = (await receipt(sinkFile, runId))?.arrow_seen === true;
    result.oracle.first_input_after_escape = (await receipt(sinkFile, runId))?.safe_after_seen === true;
    result.oracle.same_fixture_sink_pid = (await receipt(sinkFile, runId))?.pid === pidBefore;
    child.write("\x1dd"); await Promise.race([exitPromise, sleep(3000)]);
    const api = await receipt(outputFile, runId); const sink = await receipt(sinkFile, runId);
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
  } catch (error) { result.result = "FAIL"; result.reason = redact(error.message); result.screen_without_payload = redact(screen()); }
  finally {
    result.native = nativeInfo ?? null; result.run_id = runId; result.stages = stages; result.started_at_utc = new Date(started).toISOString();
    result.api = await receipt(outputFile, runId); result.sink = await receipt(sinkFile, runId);
    result.raw_tty_tail = rawTail; result.stderr ??= "";
    const frontendPid = nativeInfo?.frontend_pid ?? nativeInfo?.pid ?? result.api?.pid;
    const sinkPid = result.sink?.pid ?? result.api?.sink_pid;
    try {
      result.owned_processes = [reconcilePid(platform, sinkPid, runId), reconcilePid(platform, frontendPid, runId)];
      if (platform === "unix" && exited === undefined && result.owned_processes.every((row) => row.state === "ABSENT" || row.state === "OWNED_STOPPED")) child?.kill();
      await Promise.race([exitPromise, sleep(2000)]);
      result.exit_code = exited ?? null;
      const dead = result.owned_processes.every((row) => row.state === "ABSENT" || row.state === "OWNED_STOPPED");
      result.cleanup = verifiedCleanExit(dead, exited, result.api) ? "CLEAN_EXIT" : "UNVERIFIED";
      // The intended negative control is the observed native-sink leak. An
      // unrelated exception or missing lifecycle receipt never counts as success.
      if (result.cleanup !== "CLEAN_EXIT") result.result = "FAIL";
    } catch (error) { result.cleanup = "UNVERIFIED"; result.cleanup_error = redact(error.message); result.result = "FAIL"; }
    result.ended_at_utc = new Date().toISOString(); terminal.dispose(); await writeFile(path.join(audit, `native-pty-${label}-result.json`), JSON.stringify(result, null, 2)); results.push(result);
  }
}
const summary = { timestamp_utc: new Date().toISOString(), installed, hashes, linux_node: linuxNode, results, scope: "Native PTY fixture acceptance only. No physical-human, pinned real-provider, encrypted DB, production or deployment claim." };
await writeFile(path.join(audit, "native-pty-summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ summary: path.join(audit, "native-pty-summary.json"), results: results.map(({ label, result, reason }) => ({ label, result, reason })) }) + "\n");
process.exit(results.every((row) => (row.result === "PASS" || row.result === "EXPECTED_FAIL_ISOLATION_ORACLE") && row.cleanup === "CLEAN_EXIT") ? 0 : 1);
