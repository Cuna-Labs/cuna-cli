import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { firstLineFor, firstLineFrame, paintFirstLine } from "../dist/cli/first-line.js";
import { runProcessCli } from "../dist/cli/process-entrypoint.js";
import { memoryStreams, runCli } from "../dist/index.js";

/**
 * THE FIRST LINE IS PAINTED BEFORE THE CLI'S MODULE GRAPH LOADS, AND IS THE
 * SAME ROW THE CLI WOULD HAVE PAINTED ITSELF.
 *
 * Measured 2026-09-22: ~98% of the time before `cuna claude` showed anything
 * was Node loading the static import graph behind `cli/run.ts` (~2.2 MB), and
 * host load alone moved an unchanged build from 499 ms to 1 391 ms. So
 * `bin/cuna.ts` now paints from `cli/first-line.ts` and loads the rest after.
 *
 * Two things can go wrong, and each has its own test here: the entry paints a
 * row `runCli` would not have painted (a lie, or a row the error lands on), and
 * the handover paints the row twice (a flicker).
 */

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const STOP = "stop-at-the-first-network-touch";
const SESSION = "11111111-1111-4111-8111-111111111111";
const ALL_TTY = Object.freeze({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true });

function ttyStream() {
  let text = "";
  const writes = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); writes.push(chunk.toString()); callback(); } });
  stream.isTTY = true;
  return { stream, text: () => text, writes };
}

/** Run `runCli` until it first reaches for the network; nothing remote answers. */
async function runUntilNetwork(argv, tty, extra = {}) {
  const streams = memoryStreams(tty);
  const stderr = extra.stderr;
  const exit = await runCli(argv, {
    streams: stderr === undefined ? streams.streams : { ...streams.streams, stderr: stderr.stream },
    platform: PLATFORM,
    env: {},
    now: () => Date.parse("2026-09-22T15:27:10.557Z"),
    fetch: async () => { throw new Error(STOP); },
    humanAuth: { async acquireAccessToken() { throw new Error(STOP); } },
    clientFactory: () => ({ async getIdentity() { throw new Error(STOP); } }),
    machinesExplorerRunner: async () => undefined,
    ...(extra.firstLine === undefined ? {} : { firstLine: extra.firstLine }),
  });
  return { exit, stderr: stderr === undefined ? streams.stderr() : stderr.text() };
}

const INVOCATIONS = Object.freeze([
  ["claude", "/work/project", "--machine", "harness"],
  ["codex", "/work/project"],
  ["opencode", "/work/project"],
  ["claude", "/work/project", "--no-color"],
  ["--profile", "someone", "claude", "/work/project", "--machine", "harness"],
  ["claude", "--agent-session", SESSION],
  [],
  ["--no-color"],
  ["--profile", "someone"],
  ["claude", "/one", "/two"],
  ["claude", "--no-such-option"],
  ["claude", "--help"],
  ["help"],
  ["--version"],
  ["machines"],
  ["--json", "claude", "/work/project"],
]);

test("the entry predicts exactly the row runCli paints first, or nothing", async () => {
  let predicted = 0;
  for (const argv of INVOCATIONS) {
    // No prediction paints nothing early, so it cannot disagree with runCli.
    const decision = firstLineFor(argv, { env: {}, ...ALL_TTY });
    if (decision === undefined) continue;
    predicted += 1;
    const run = await runUntilNetwork(argv, ALL_TTY);
    const frame = firstLineFrame(decision.label, decision.color, 80).bytes;
    assert.equal(run.stderr.slice(0, frame.length), frame, `cuna ${argv.join(" ")} paints a different first row`);
  }
  // The eight above that runCli paints first; a predicate that predicts
  // nothing would pass the loop trivially.
  assert.equal(predicted, 8);
});

test("nothing is predicted unless all three streams are terminals and --json is absent", () => {
  const argv = ["claude", "/work/project", "--machine", "harness"];
  assert.ok(firstLineFor(argv, { env: {}, ...ALL_TTY }));
  for (const tty of [
    { stdinIsTTY: false, stdoutIsTTY: true, stderrIsTTY: true },
    { stdinIsTTY: true, stdoutIsTTY: false, stderrIsTTY: true },
    { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: false },
  ]) {
    assert.equal(firstLineFor(argv, { env: {}, ...tty }), undefined, JSON.stringify(tty));
  }
  assert.equal(firstLineFor(["--json", ...argv], { env: {}, ...ALL_TTY }), undefined);
  assert.equal(firstLineFor(argv, { env: { NO_COLOR: "1" }, ...ALL_TTY }).color, false);
});

test("runCli continues a claimed row from frame 1: frame 0 is on screen once", async () => {
  const argv = ["claude", "/work/project", "--machine", "harness"];
  const stderr = ttyStream();
  const firstLine = paintFirstLine(argv, { env: {}, stdinIsTTY: true, stdoutIsTTY: true, stderr: stderr.stream });
  assert.ok(firstLine);
  const frame0 = firstLineFrame("Preparing Claude Code", true, 80).bytes;
  assert.equal(stderr.text(), frame0, "the entry paints frame 0 and nothing else");

  const run = await runUntilNetwork(argv, ALL_TTY, { stderr, firstLine });
  assert.equal(run.stderr.split(frame0).length - 1, 1, "frame 0 is not painted a second time");
  assert.equal(firstLine.claim({ kind: "journey", label: "Preparing Claude Code", color: true, stream: stderr.stream }), undefined,
    "a nested runCli cannot take the row again");
});

test("DISCRIMINATING CONTROL: without a claim the same run paints frame 0 itself", async () => {
  const argv = ["claude", "/work/project", "--machine", "harness"];
  const stderr = ttyStream();
  paintFirstLine(argv, { env: {}, stdinIsTTY: true, stdoutIsTTY: true, stderr: stderr.stream });
  const frame0 = firstLineFrame("Preparing Claude Code", true, 80).bytes;
  // The row is painted by the entry but not handed over, as before this repair.
  const run = await runUntilNetwork(argv, ALL_TTY, { stderr });
  assert.equal(run.stderr.split(frame0).length - 1, 2);
});

test("a row nobody claimed is cleared before the command's own words, and only once", async () => {
  const stderr = ttyStream();
  const firstLine = paintFirstLine(["claude", "/work/project"], { env: {}, stdinIsTTY: true, stdoutIsTTY: true, stderr: stderr.stream });
  const exit = await runProcessCli(["claude", "/work/project"], {
    host: { once() {}, removeListener() {} },
    firstLine,
    run: async () => 0,
  });
  assert.equal(exit, 0);
  assert.equal(stderr.writes.at(-1), "\r\u001b[2K", "the process boundary clears an unclaimed row");
  firstLine.release();
  assert.equal(stderr.writes.filter((write) => write === "\r\u001b[2K").length, 1);
});

/* -------------------------------------------------------------------------- */
/* The executable itself: the first bytes precede the graph import             */
/* -------------------------------------------------------------------------- */

const ENTRY = fileURLToPath(new URL("../dist/bin/cuna.js", import.meta.url));

/**
 * A preload that makes the child's three streams report a terminal, records
 * every stderr write, and records when `cli/run.js` (the head of the large
 * graph) is loaded. It never lets the child reach the network: the profile it is
 * given does not exist, so `runCli` stops at configuration.
 */
const PRELOAD = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
let order = 0;
const events = [];
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
}
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/cli/run.js")) events.push({ order: order++, kind: "graph" });
    return nextLoad(url, context);
  },
});
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  events.push({ order: order++, kind: "stderr", text: String(chunk) });
  return write(chunk, ...rest);
};
process.on("exit", () => writeFileSync(process.env.FIRST_LINE_EVENTS, JSON.stringify(events)));
`;

async function spawnEntry(t, argv) {
  const directory = await mkdtemp(join(tmpdir(), "cuna-first-line-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const preload = join(directory, "preload.mjs");
  const events = join(directory, "events.json");
  await writeFile(preload, PRELOAD);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, ENTRY, ...argv], {
    cwd: directory,
    env: { ...process.env, FIRST_LINE_EVENTS: events, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const exit = await new Promise((resolve) => child.once("exit", resolve));
  return { exit, events: JSON.parse(await readFile(events, "utf8")), directory };
}

test("the executable writes the first row before it loads cli/run.js", async (t) => {
  const run = await spawnEntry(t, ["--profile", "first-line-probe-absent", "claude", ".", "--machine", "harness"]);
  const graph = run.events.find((event) => event.kind === "graph");
  const first = run.events.find((event) => event.kind === "stderr");
  assert.ok(graph, "the probe must see the graph load; otherwise it proves nothing");
  assert.ok(first.order < graph.order, "the first stderr bytes precede the graph import");
  assert.equal(first.text, firstLineFrame("Preparing Claude Code", false, 80).bytes);
  // Refused at configuration: the row is cleared, then the error, on its own row.
  const stderr = run.events.filter((event) => event.kind === "stderr").map((event) => event.text).join("");
  assert.equal(stderr.split(first.text).length - 1, 1, "frame 0 appears once");
  assert.ok(stderr.includes("\r\u001b[2KError [cuna.config."), "the error starts on a cleared row");
  assert.notEqual(run.exit, 0);
});

test("DISCRIMINATING CONTROL: a --json invocation writes nothing before the graph loads", async (t) => {
  const run = await spawnEntry(t, ["--json", "--profile", "first-line-probe-absent", "claude", ".", "--machine", "harness"]);
  const graph = run.events.find((event) => event.kind === "graph");
  const first = run.events.find((event) => event.kind === "stderr");
  assert.ok(graph);
  assert.ok(first === undefined || first.order > graph.order);
});
