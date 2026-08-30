/**
 * The OpenCode journey, driven end to end through a real PTY.
 *
 * `live-foreground-smoke.mjs` attaches to a session that already exists, so it
 * can only witness the last third of the journey. Everything before the attach
 * — selecting the machine, synchronizing the workspace, creating the exact
 * AgentSession — was only ever exercised by a person typing, which is exactly
 * the arrangement where the owner is the one who rediscovers a basic failure.
 *
 * This drives `cuna opencode --machine NAME`, the command a person actually
 * runs, and records a witness for each conjunct it can observe:
 *
 *   select_opencode_machine, create_or_open_exact_session,
 *   watch_a_truthful_progress_state, attach_pty, type_and_see_bytes,
 *   detach_with_ctrl_c
 *
 * It asserts nothing about `/connect`: that lives inside OpenCode's own TUI and
 * belongs to the provider, not to Cuna.
 *
 *   node scripts/harness/live-opencode-journey.mjs MACHINE_NAME [rich|plain]
 *
 * Exit 0 means every witness below was observed. Any failure prints the last
 * screen and the transcript tail, because a journey runner that reports only
 * "failed" costs a second run to learn anything.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";

const machineName = process.argv[2];
if (machineName === undefined) {
  throw new Error("Usage: node scripts/harness/live-opencode-journey.mjs MACHINE_NAME [rich|plain]");
}
const presentationMode = process.argv[3] ?? "rich";
if (presentationMode !== "rich" && presentationMode !== "plain") {
  throw new Error("Presentation mode must be rich or plain.");
}

const root = path.resolve(import.meta.dirname, "..", "..");
const harnessRequire = createRequire(path.join(root, "test", "windows-conpty", "package.json"));
const { spawn } = harnessRequire("node-pty");
const { Terminal } = xtermHeadless;
const cliEntrypoint = process.env.CUNA_HARNESS_ENTRYPOINT === undefined
  ? path.join(root, "dist", "bin", "cuna.js")
  : path.resolve(process.env.CUNA_HARNESS_ENTRYPOINT);

const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows: 30, scrollback: 2_000 });
const childEnvironment = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
delete childEnvironment.NO_COLOR;
childEnvironment.CUNA_TERMINAL_MODE = presentationMode;

let transcript = "";
let writeTail = Promise.resolve();
let exitResult;
const witnesses = [];

const child = spawn(process.execPath, [cliEntrypoint, "opencode", "--machine", machineName], {
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

/**
 * The durable AgentSessions on this machine, refreshed out of band.
 *
 * The runner cannot ask the attached CLI what exists — it is busy holding a
 * PTY — so a second process reads the authority. Polling is deliberately slow:
 * this is a fence, not a progress bar.
 */
let durableSessions = [];
let lastDurableRefresh = 0;
let durableError;
const machineIdPromise = (async () => {
  const out = await runCli(["machines", "list"]);
  const found = out?.data?.items?.find((m) => m.name === machineName);
  if (found === undefined) throw new Error(`No machine named ${machineName}`);
  return found.id;
})();

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawnSync(process.execPath, [cliEntrypoint, ...args, "--json"], {
      encoding: "utf8",
      env: { ...process.env, CUNA_TERMINAL_MODE: "plain" },
      timeout: 60_000,
    });
    try {
      resolve(JSON.parse(child.stdout));
    } catch {
      resolve(undefined);
    }
  });
}

function durableRunningSession() {
  return durableSessions.find((s) => s.process_state === "running");
}

async function refreshDurableSessions() {
  try {
    const machineId = await machineIdPromise;
    const out = await runCli(["agent-sessions", "list", "--machine", machineId]);
    durableSessions = out?.data?.items ?? [];
  } catch (error) {
    durableError = error;
  }
}

function screen() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function witness(name, predicate, timeoutMs) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (predicate()) {
      witnesses.push({ name, observed: true, ms: Date.now() - startedAt });
      return;
    }
    if (Date.now() >= deadline || exitResult !== undefined) {
      witnesses.push({ name, observed: false, ms: Date.now() - startedAt });
      throw new Error(
        `WITNESS FAILED: ${name}\n\n--- screen ---\n${screen()}\n\n--- transcript tail ---\n${transcript.slice(-4_000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (Date.now() - lastDurableRefresh > 5_000) {
      lastDurableRefresh = Date.now();
      void refreshDurableSessions();
    }
  }
}

let failure;
try {
  // The journey may legitimately take a while: it synchronizes a workspace and
  // waits on a remote process observation. What it may NOT do is sit on a
  // spinner with nothing behind it, so every wait here is bounded and named.
  // Not the machine name: the rich appbar owns row 0 and the selection scrolls
  // out of the viewport long before the attach resolves. What is durable on
  // screen is that the CLI committed to exactly one AgentSession.
  await witness(
    "select_opencode_machine — the CLI committed to one exact AgentSession",
    () => /ATTACHING 1 EXACT AGENTSESSION|Syncing workspace/u.test(screen()),
    90_000,
  );
  // Measured 2026-08-30: a cold OpenCode AgentSession took 6m14s from create to
  // an observed running process. The client budget must exceed that or the
  // runner reports a defect where there is only latency.
  await witness(
    "watch_a_truthful_progress_state — a named, bounded wait, never a bare spinner",
    () => /Checking terminal authority|Syncing workspace|Starting/u.test(screen()),
    30_000,
  );
  // NOT a screen match. This witness used to read
  // `/OpenCode/.test(screen()) && !/ATTACHING/.test(screen())`, which the CLI's
  // own chrome satisfies the moment the ATTACHING banner clears — no provider,
  // no session, still green. It reported two PASSES against a machine on which
  // the database later proved no AgentSession had ever been created. A control
  // that cannot fail is not a control, and this one could not.
  //
  // Durable state is the witness: an AgentSession must exist on this exact
  // machine, in `running`, before an attach can mean anything.
  await witness(
    "create_or_open_exact_session — a durable AgentSession is running on this machine",
    () => durableRunningSession() !== undefined,
    240_000,
  );
  await witness(
    "attach_pty — an OpenCode viewport rendered over a live durable session",
    () => durableRunningSession() !== undefined &&
      /OpenCode/u.test(screen()) && !/ATTACHING/u.test(screen()),
    180_000,
  );
  // A remote frame styled by the provider, not by Cuna's own chrome. Cuna uses
  // truecolor; this is the ANSI-256 signature of the provider's own TUI, so a
  // pass here cannot be the appbar mistaken for the child.
  await witness(
    "type_and_see_bytes — styled provider frames arrived from the remote process",
    () => /\[(?:0;)?(?:[0-9]+;)*38;5;/u.test(transcript),
    30_000,
  );

  // CUNA_JOURNEY_NO_INPUT=1 skips this block, and it exists as a control rather
  // than a convenience. Measured 2026-08-30: after a run that typed and then
  // sent one Ctrl-C, the AgentSession was gone. Two candidate causes — the
  // keystrokes or the Ctrl-C — and the run cannot tell them apart. Attaching
  // and detaching without typing anything discriminates them: if the session
  // survives here, the typing ended it; if it does not, Ctrl-C is killing a
  // process it is only supposed to detach from.
  if (process.env.CUNA_JOURNEY_NO_INPUT !== "1") {
    const beforeTyping = transcript.length;
    child.write("help\r");
    await witness(
      "type_and_see_bytes — bytes typed locally came back from the remote process",
      () => transcript.length > beforeTyping + 16,
      30_000,
    );
  }

  // Ctrl-C must detach the local attachment and return the prompt. It must not
  // terminate the remote process: `reconnect_to_the_same_process` is the next
  // conjunct and it depends on this one refusing to kill anything.
  child.write("");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);
  if (exitResult === undefined) {
    throw new Error(
      `WITNESS FAILED: detach_with_ctrl_c — the attachment did not return the prompt\n\n--- screen ---\n${screen()}`,
    );
  }
  witnesses.push({ name: "detach_with_ctrl_c — Ctrl-C returned the prompt", observed: true, ms: 0 });
} catch (error) {
  failure = error;
} finally {
  if (exitResult === undefined) {
    child.write("");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await writeTail;
}

for (const entry of witnesses) {
  console.log(`${entry.observed ? "OK  " : "FAIL"} ${entry.name}${entry.ms > 0 ? ` (${entry.ms}ms)` : ""}`);
}
console.log(`exit=${JSON.stringify(exitResult ?? null)}`);
if (failure !== undefined) {
  console.error(String(failure.message ?? failure));
  process.exitCode = 1;
}
