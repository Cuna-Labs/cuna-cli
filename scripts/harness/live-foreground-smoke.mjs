import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";

const sessionId = process.argv[2];
if (sessionId === undefined) throw new Error("Usage: node scripts/harness/live-foreground-smoke.mjs SESSION_ID");
const presentationMode = process.argv[3] ?? "rich";
if (presentationMode !== "rich" && presentationMode !== "plain") {
  throw new Error("Presentation mode must be rich or plain.");
}

const root = path.resolve(import.meta.dirname, "..", "..");
const harnessRequire = createRequire(path.join(root, "test", "windows-conpty", "package.json"));
const { spawn } = harnessRequire("node-pty");
const { Terminal } = xtermHeadless;
const checkoutEntrypoint = path.join(root, "dist", "bin", "cuna.js");
const cliEntrypoint = process.env.CUNA_HARNESS_ENTRYPOINT === undefined
  ? checkoutEntrypoint
  : path.resolve(process.env.CUNA_HARNESS_ENTRYPOINT);
const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows: 30, scrollback: 1_000 });
const childEnvironment = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
delete childEnvironment.NO_COLOR;
childEnvironment.CUNA_TERMINAL_MODE = presentationMode;
let transcript = "";
let writeTail = Promise.resolve();
let exitResult;
const child = spawn(process.execPath, [cliEntrypoint, "agent-sessions", "attach", sessionId], {
  name: "xterm-256color",
  cols: terminal.cols,
  rows: terminal.rows,
  cwd: process.cwd(),
  useConpty: true,
  useConptyDll: false,
  env: childEnvironment,
});
child.onData((data) => {
  transcript += data;
  writeTail = writeTail.then(() => new Promise((resolve) => terminal.write(data, resolve)));
});
const exited = new Promise((resolve) => child.onExit((event) => {
  exitResult = event;
  resolve(event);
}));

function screen() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function waitUntil(predicate, message, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${message}\n${screen()}\n${transcript.slice(-4_000)}`);
}

async function disposeWindowsConpty() {
  // node-pty 1.1.0 leaves its ConPTY worker and input pipe referenced after a
  // natural child exit. Its public kill() cannot be used after that exit: it
  // forks an AttachConsole helper for a PID which is already gone. The harness
  // pins this version, so close the same three resources kill() owns, without
  // starting the process-list helper.
  const agent = child._agent;
  const conout = agent?._conoutSocketWorker;
  const worker = conout?._worker;
  if (
    agent === undefined ||
    typeof agent.inSocket?.destroy !== "function" ||
    typeof agent._ptyNative?.kill !== "function" ||
    typeof conout?.dispose !== "function" ||
    worker === undefined
  ) {
    throw new Error("The pinned node-pty ConPTY cleanup contract changed.");
  }
  agent.inSocket.destroy();
  agent._ptyNative.kill(agent._pty, false);
  if (worker.threadId === -1) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The node-pty ConPTY worker did not terminate after cleanup.")),
      5_000,
    );
    timeout.unref();
    worker.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    conout.dispose();
  });
}

let report;
let primaryFailure;
try {
  if (presentationMode === "rich") {
    await waitUntil(
      () => screen().includes("CUNA") && screen().includes("Claude") && !screen().includes("ATTACHING"),
      "The live Claude viewport did not render under the Cuna appbar.",
      20_000,
    );
  } else {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  // Cuna chrome uses truecolor; Claude's current login TUI uses ANSI-256.
  // This keeps the live oracle from mistaking the appbar for provider style.
  const providerStylePattern = /\u001b\[(?:0;)?(?:1;|2;|3;|4;|7;|8;|9;|53;)*38;5;/u;
  if (presentationMode === "rich") {
    await waitUntil(
      () => providerStylePattern.test(transcript),
      "No styled provider frame arrived after Cuna requested a remote redraw.",
      5_000,
    );
  }
  const initialScreen = screen();
  const providerStyles = providerStylePattern.test(transcript);
  if (presentationMode === "rich") {
    assert.match(transcript, /\u001b\[48;2;235;86;37m/u, "the persistent Cuna appbar color was absent");
    assert.equal(providerStyles, true, "no VTE-reemitted provider style reached the host");
  }

  const beforeResize = transcript.length;
  terminal.resize(74, 20);
  child.resize(74, 20);
  if (presentationMode === "rich") {
    await waitUntil(
      () => transcript.length > beforeResize && screen().includes("CUNA") && screen().includes("Claude"),
      "The live Cuna/Claude composition did not survive resize.",
    );
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const resizedScreen = screen();

  child.write("\u0003");
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("One Ctrl-C did not detach within fifteen seconds.")), 15_000)),
  ]);
  await writeTail;
  assert.equal(exitResult?.exitCode, 0);
  assert.equal(terminal.buffer.active.type, "normal");
  report = {
    result: "PASS",
    sessionId,
    cliEntrypoint,
    observations: {
      cunaAppbar: presentationMode === "rich",
      providerStyles,
      resize: true,
      oneCtrlC: true,
      restoredScreen: true,
    },
    initialScreen,
    resizedScreen,
  };
} catch (error) {
  primaryFailure = error;
}

let cleanupFailure;
try {
  if (exitResult === undefined) {
    try { process.kill(child.pid); } catch {}
  }
  await disposeWindowsConpty();
} catch (error) {
  cleanupFailure = error;
} finally {
  terminal.dispose();
}

if (primaryFailure !== undefined && cleanupFailure !== undefined) {
  throw new AggregateError([primaryFailure, cleanupFailure], "The live smoke and ConPTY cleanup both failed.");
}
if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;
await new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(report)}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
// All assertions, child exit checks, transcript writes, and ConPTY cleanup have
// completed. Exit explicitly because this harness embeds node-pty, whose
// Windows native binding may retain non-enumerable handles across versions.
process.exit(0);
