/**
 * Negative-path exercises against a LIVE OpenCode AgentSession, driven through
 * a real PTY the same way `live-opencode-journey.mjs` drives the happy path.
 *
 * The governing law here is not "did it work" — it is: every negative path
 * must refuse or recover VISIBLY, never silently. A hang with no message is
 * as bad as a crash, and is reported as such (SILENT_HANG), distinct from a
 * typed, user-visible refusal (REFUSED_VISIBLY) or a process death (CRASH).
 *
 * This script only READS machine/session inventory and ATTACHES a foreground
 * terminal client (`cuna connect <id>` / `cuna claude --machine <name>`). It
 * never creates, stops, or deletes a machine, and it reuses the single
 * already-running AgentSession on the live machine for every attach-based
 * test instead of creating siblings.
 *
 *   node scripts/harness/negative-paths.mjs
 *
 * Every wait below is bounded. Nothing loops forever. Each finding is an
 * OBSERVATION ("hung for N seconds, no output"), not a verdict beyond what
 * was actually seen.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";

const root = path.resolve(import.meta.dirname, "..", "..");
const harnessRequire = createRequire(path.join(root, "test", "windows-conpty", "package.json"));
const { spawn } = harnessRequire("node-pty");
const { Terminal } = xtermHeadless;
const cliEntrypoint = process.env.CUNA_HARNESS_ENTRYPOINT === undefined
  ? path.join(root, "dist", "bin", "cuna.js")
  : path.resolve(process.env.CUNA_HARNESS_ENTRYPOINT);

// The live subject named in the task. Read fresh via `cuna machines list`
// rather than trusted blindly — a stale id here must fail loudly, not
// silently attach to the wrong thing.
const LIVE_MACHINE_HINT_ID = "199f91e0-e888-46de-8008-83deff884b3b";
const LIVE_MACHINE_HINT_NAME = "goal0-bytes-1";

// OpenCode's own TUI footer, not Cuna's chrome. Cuna's "Checking selected
// AgentSession" spinner is ALSO styled with ANSI-256 (`38;5;202` etc.), so a
// generic "any 38;5; sequence" probe false-positives on Cuna's own chrome
// before the provider ever renders. These two footer strings only appear
// once OpenCode itself is drawing the screen.
const PROVIDER_READY_RE = /esc\s+interrupt|ctrl\+p\s+commands/u;
// The CLI's own typed foreground-terminal failure, rendered to the primary
// screen buffer after the alternate-screen TUI exits.
const DISCONNECTED_RE = /Error \[cuna\.[a-z0-9_.]+\]/iu;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCliJson(args, timeoutMs = 60_000) {
  const child = spawnSync(process.execPath, [cliEntrypoint, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, CUNA_TERMINAL_MODE: "plain" },
    timeout: timeoutMs,
  });
  try {
    return JSON.parse(child.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Attach a foreground PTY client running `cuna <args>` — same spawn shape as
 * `live-opencode-journey.mjs`: node-pty over a real ConPTY, @xterm/headless
 * rendering exactly what a person would see, so screen assertions read real
 * rendered text instead of raw ANSI.
 */
function attach(args, { cols = 120, rows = 30, label = args.join(" ") } = {}) {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 4_000 });
  const childEnvironment = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete childEnvironment.NO_COLOR;
  childEnvironment.CUNA_TERMINAL_MODE = "rich";

  const startedAt = Date.now();
  const child = spawn(process.execPath, [cliEntrypoint, ...args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: root,
    useConpty: true,
    useConptyDll: false,
    env: childEnvironment,
  });

  let transcript = "";
  let exitInfo;
  child.onData((data) => {
    transcript += data;
    terminal.write(data);
  });
  const exited = new Promise((resolve) => child.onExit((event) => {
    exitInfo = { exitCode: event.exitCode, signal: event.signal, ms: Date.now() - startedAt };
    resolve(exitInfo);
  }));

  function screen() {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let r = 0; r < terminal.rows; r += 1) lines.push(buffer.getLine(r)?.translateToString(true) ?? "");
    return lines.map((l) => l.replace(/\s+$/u, "")).filter((l) => l.length > 0).join("\n");
  }

  /** Bounded wait for an arbitrary predicate over (transcript, screen). */
  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    for (;;) {
      if (predicate(transcript, screen())) return { matched: true, ms: Date.now() - start };
      if (exitInfo !== undefined) return { matched: false, ms: Date.now() - start, exited: true };
      if (Date.now() >= deadline) return { matched: false, ms: Date.now() - start, timedOut: true };
      await sleep(100);
    }
  }

  /**
   * Bounded wait until ONE of: the provider TUI is visibly ready, the client
   * prints its own typed failure, the client process exits, or the bound
   * expires with none of those. The three-way split is the point: a timeout
   * with nothing else true IS the silent-hang signature this harness exists
   * to catch, and it must not be confused with a visible typed refusal.
   */
  async function waitForReadyOrFailure(timeoutMs) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    for (;;) {
      if (PROVIDER_READY_RE.test(transcript)) return { state: "ready", ms: Date.now() - start };
      const currentScreen = screen();
      if (DISCONNECTED_RE.test(currentScreen)) {
        return { state: "disconnected", ms: Date.now() - start, screen: currentScreen };
      }
      if (exitInfo !== undefined) return { state: "exited", ms: Date.now() - start, exitInfo };
      if (Date.now() >= deadline) return { state: "timeout", ms: Date.now() - start };
      await sleep(150);
    }
  }

  async function waitForExit(timeoutMs) {
    if (exitInfo !== undefined) return exitInfo;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs));
    return Promise.race([exited, timeout]);
  }

  function safeResize(nextCols, nextRows) {
    try {
      child.resize(nextCols, nextRows);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** Ctrl-C: production's documented detach key. Must not be assumed to kill the remote. */
  async function detach(timeoutMs = 15_000) {
    if (exitInfo !== undefined) return exitInfo;
    child.write("\x03");
    const result = await waitForExit(timeoutMs);
    if (result === undefined) {
      try { child.kill(); } catch { /* best effort local cleanup */ }
      return undefined;
    }
    return result;
  }

  return {
    label,
    startedAt,
    transcript: () => transcript,
    screen,
    exitInfo: () => exitInfo,
    waitFor,
    waitForReadyOrFailure,
    waitForExit,
    resize: safeResize,
    write: (data) => child.write(data),
    detach,
  };
}

function discoverLiveMachine() {
  const out = runCliJson(["machines", "list"]);
  const items = out?.data?.items ?? [];
  const machine = items.find((m) => m.id === LIVE_MACHINE_HINT_ID)
    ?? items.find((m) => m.name === LIVE_MACHINE_HINT_NAME);
  if (machine === undefined) {
    throw new Error(
      `Live machine ${LIVE_MACHINE_HINT_NAME} (${LIVE_MACHINE_HINT_ID}) was not found via \`cuna machines list\`.`,
    );
  }
  return machine;
}

function discoverRunningOpenCodeSession(machineId) {
  const out = runCliJson(["agent-sessions", "list", "--machine", machineId]);
  const items = out?.data?.items ?? [];
  return items.find((s) => s.agent === "opencode" && s.process_state === "running");
}

/**
 * Any AgentSession sitting on a non-live, non-running machine — used for the
 * missing-capability path. Read-only: listing machines/sessions never wakes
 * a stopped machine or mutates anything.
 */
function discoverUnsupportedCapabilitySession(excludeMachineId) {
  const out = runCliJson(["machines", "list"]);
  const candidates = (out?.data?.items ?? [])
    .filter((m) => m.id !== excludeMachineId && m.state !== "running" && m.state !== "creating");
  for (const machine of candidates) {
    const sessions = runCliJson(["agent-sessions", "list", "--machine", machine.id]);
    const items = sessions?.data?.items ?? [];
    if (items.length > 0) return { machine, session: items[0] };
  }
  return undefined;
}

/**
 * Attach, and if the client fails/exits/times out before reaching a usable
 * provider TUI, try once more on a fresh attach rather than reporting a
 * transient blip as the finding. Every attempt is recorded regardless, so a
 * persistent failure (not a one-off) is still visible in the final report.
 */
async function attachUntilReady(args, opts, timeoutMs, maxAttempts = 2) {
  const attempts = [];
  for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum += 1) {
    const h = attach(args, opts);
    const ready = await h.waitForReadyOrFailure(timeoutMs);
    attempts.push({ attemptNum, state: ready.state, ms: ready.ms, screen: ready.screen });
    if (ready.state === "ready") return { handle: h, ready, attempts };
    if (h.exitInfo() === undefined) await h.detach(10_000);
    if (attemptNum < maxAttempts) await sleep(3_000); // don't hammer a flaky supervisor
  }
  return { handle: undefined, ready: undefined, attempts };
}

function buildPasteBlock(byteBudget, label) {
  const marker = `CUNA-PASTE-${label}-${process.pid.toString(36)}`;
  const startTag = `${marker}-START`;
  const endTag = `${marker}-END`;
  const lines = [startTag];
  let size = Buffer.byteLength(`${startTag}\n${endTag}\n`, "utf8");
  let i = 0;
  while (size < byteBudget) {
    // Deliberately inert content: no line resembles a command or instruction,
    // so if bracketed paste is NOT honored and a line-ending were ever read as
    // a submitted turn, there is nothing here for the real agent to act on.
    const line = `TEST-PASTE-NOOP ${String(i).padStart(6, "0")} ${"x".repeat(48)}`;
    lines.push(line);
    size += Buffer.byteLength(`${line}\n`, "utf8");
    i += 1;
  }
  lines.push(endTag);
  return { block: lines.join("\n"), startTag, endTag, actualBytes: size };
}

async function testResizeAndPaste(results, sessionId) {
  const { handle: h, ready, attempts } = await attachUntilReady(
    ["connect", sessionId],
    { cols: 120, rows: 30, label: "resize+paste" },
    60_000,
  );
  if (h === undefined) {
    results.push({
      path: "resize",
      action: `attach \`cuna connect ${sessionId}\` and wait up to 60s for the provider TUI (2 attempts)`,
      observed: `every attempt failed before reaching a usable TUI: ${JSON.stringify(attempts)}`,
      verdict: attempts.every((a) => a.state === "timeout") ? "SILENT_HANG" : "UNKNOWN",
    });
    results.push({
      path: "long_paste",
      action: "(skipped — the attach never reached a usable provider TUI to paste into)",
      observed: "not exercised",
      verdict: "UNKNOWN",
    });
    return;
  }
  if (attempts.length > 1) {
    results.push({
      path: "resize_paste_attach_retry_note",
      action: "n/a",
      observed: `the first attach attempt did not reach the provider TUI and was retried: ${JSON.stringify(attempts)}`,
      verdict: "UNKNOWN",
    });
  }

  // --- resize: narrow, wide, tall, 1-column ---
  const sizes = [
    { name: "narrow", cols: 20, rows: 30 },
    { name: "wide", cols: 300, rows: 30 },
    { name: "tall", cols: 80, rows: 120 },
    { name: "1-column", cols: 1, rows: 30 },
  ];
  const resizeObservations = [];
  for (const size of sizes) {
    if (h.exitInfo() !== undefined) {
      resizeObservations.push({ size: size.name, skipped: "client already exited" });
      continue;
    }
    const before = h.transcript().length;
    const call = h.resize(size.cols, size.rows);
    const reaction = await h.waitFor((t) => t.length > before, 3_000);
    resizeObservations.push({
      size: size.name,
      cols: size.cols,
      rows: size.rows,
      resizeCallError: call.ok ? undefined : call.error,
      remoteRepaintedWithin3s: reaction.matched,
      aliveAfter: h.exitInfo() === undefined,
    });
  }
  if (h.exitInfo() === undefined) h.resize(120, 30);

  const resizeCrashed = resizeObservations.some((o) => o.resizeCallError !== undefined || o.aliveAfter === false);
  results.push({
    path: "resize",
    action: "attach, wait for OpenCode's TUI, then child.resize() through narrow(20x30) -> wide(300x30) -> tall(80x120) -> 1-column(1x30) -> restore(120x30)",
    observed: JSON.stringify(resizeObservations),
    verdict: resizeCrashed ? "CRASH" : "RECOVERED",
  });

  // --- long paste: 4KB then 64KB, bracketed, in one write, no Enter ---
  if (h.exitInfo() === undefined) {
    for (const spec of [{ label: "4KB", bytes: 4_096, boundMs: 20_000 }, { label: "64KB", bytes: 65_536, boundMs: 45_000 }]) {
      if (h.exitInfo() !== undefined) {
        results.push({
          path: `long_paste_${spec.label}`,
          action: "(skipped — client already exited from a prior step)",
          observed: "not exercised",
          verdict: "UNKNOWN",
        });
        continue;
      }
      const { block, startTag, endTag, actualBytes } = buildPasteBlock(spec.bytes, spec.label);
      const wrapped = `\x1b[200~${block}\x1b[201~`;
      h.write(wrapped); // single write() call, per the task's "in one write"
      const arrival = await h.waitFor((t) => t.includes(endTag), spec.boundMs);
      const exitedDuring = h.exitInfo() !== undefined;
      const gotStart = h.transcript().includes(startTag);
      const gotEnd = h.transcript().includes(endTag);
      let verdict;
      if (exitedDuring) verdict = "CRASH";
      else if (gotEnd) verdict = "RECOVERED";
      else if (gotStart) verdict = "UNKNOWN"; // started arriving, never confirmed complete within bound
      else if (arrival.timedOut) verdict = "SILENT_HANG";
      else verdict = "UNKNOWN";
      results.push({
        path: `long_paste_${spec.label}`,
        action: `write a bracketed-paste (ESC[200~ ... ESC[201~) ${actualBytes}-byte multi-line block in a single write, no Enter sent`,
        observed: exitedDuring
          ? `client exited during the paste wait (${arrival.ms}ms), exit=${JSON.stringify(h.exitInfo())}`
          : `startMarkerSeen=${gotStart} endMarkerSeen=${gotEnd} waited=${arrival.ms}ms bound=${spec.boundMs}ms`,
        verdict,
      });
    }
  }

  if (h.exitInfo() === undefined) {
    await h.detach(15_000);
  }
  results.push({
    path: "resize_paste_cleanup_note",
    action: "n/a",
    observed: "Pasted-but-unsubmitted test text may remain in this AgentSession's OpenCode input box (Enter was never sent, by design, to avoid feeding a real agent turn).",
    verdict: "UNKNOWN",
  });
}

async function testSecondAttach(results, sessionId) {
  const { handle: first, attempts: firstAttempts } = await attachUntilReady(
    ["connect", sessionId],
    { label: "first-client" },
    60_000,
  );
  if (first === undefined) {
    results.push({
      path: "second_attach",
      action: `attach a first \`cuna connect ${sessionId}\` client and wait up to 60s for the provider TUI (2 attempts)`,
      observed: `the first client never reached the provider TUI in either attempt, so no second attach was tried: ${JSON.stringify(firstAttempts)}`,
      verdict: firstAttempts.every((a) => a.state === "timeout") ? "SILENT_HANG" : "UNKNOWN",
    });
    return;
  }
  if (firstAttempts.length > 1) {
    results.push({
      path: "second_attach_retry_note",
      action: "n/a",
      observed: `the first client's own attach was retried before the second-attach test began: ${JSON.stringify(firstAttempts)}`,
      verdict: "UNKNOWN",
    });
  }

  await sleep(2_000); // let the first client settle before introducing the second
  const firstTranscriptBeforeSecond = first.transcript().length;
  const second = attach(["connect", sessionId], { label: "second-client" });
  const secondReady = await second.waitForReadyOrFailure(60_000);
  // Bounded window to see whether the FIRST client reacts to the second attach.
  const firstReaction = await first.waitFor((t) => t.length > firstTranscriptBeforeSecond, 20_000);
  const firstExitedAfter = first.exitInfo();
  const secondExitedAfter = second.exitInfo();
  const firstScreenAfter = first.screen();
  const secondScreenAfter = second.screen();

  let verdict;
  if (secondReady.state === "ready" && firstExitedAfter === undefined && !firstReaction.matched) {
    // The second client fully attached; the first produced not one new byte
    // and did not exit. That is "went silent", the exact failure mode this
    // path is designed to catch if it happens.
    verdict = "SILENT_HANG";
  } else if (secondReady.state === "ready") {
    verdict = "REFUSED_VISIBLY"; // something visibly happened to the first (new output and/or exit)
  } else if (secondReady.state === "disconnected" || secondReady.state === "exited") {
    verdict = "REFUSED_VISIBLY"; // the second attach itself was refused, typed
  } else {
    verdict = "UNKNOWN";
  }

  results.push({
    path: "second_attach",
    action: `attach a first client, confirm it reached the provider TUI, then attach a SECOND \`cuna connect ${sessionId}\` client to the SAME AgentSession`,
    observed: [
      `second client: state=${secondReady.state} ms=${secondReady.ms}`,
      `second client exited=${secondExitedAfter !== undefined} ${secondExitedAfter ? JSON.stringify(secondExitedAfter) : ""}`,
      `second client screen tail: ${JSON.stringify(secondScreenAfter.slice(-600))}`,
      `first client produced new output after the second attached: ${firstReaction.matched} (waited ${firstReaction.ms}ms)`,
      `first client exited after the second attached: ${firstExitedAfter !== undefined} ${firstExitedAfter ? JSON.stringify(firstExitedAfter) : ""}`,
      `first client screen tail after: ${JSON.stringify(firstScreenAfter.slice(-600))}`,
    ].join(" | "),
    verdict,
  });

  if (first.exitInfo() === undefined) await first.detach(10_000);
  if (second.exitInfo() === undefined) await second.detach(10_000);
}

async function testMissingCapability(results, liveMachineId) {
  const found = discoverUnsupportedCapabilitySession(liveMachineId);
  if (found === undefined) {
    results.push({
      path: "missing_capability",
      action: "search `cuna machines list` for a non-running, non-creating machine with any AgentSession",
      observed: "no suitable machine/session was found in the current account inventory",
      verdict: "UNKNOWN",
    });
    return;
  }
  const { machine, session } = found;
  const h = attach(["connect", session.id], { label: "missing-capability" });
  const outcome = await h.waitForExit(75_000);
  const screenText = h.screen();
  let verdict;
  if (outcome === undefined) verdict = "SILENT_HANG";
  else if (DISCONNECTED_RE.test(screenText)) verdict = "REFUSED_VISIBLY";
  else verdict = "UNKNOWN";
  results.push({
    path: "missing_capability",
    action: `attach \`cuna connect ${session.id}\` — machine "${machine.name}" (${machine.id}) is state=${machine.state}, target session process_state=${session.process_state}`,
    observed: outcome === undefined
      ? `hung for 75s with no exit; last rendered screen: ${JSON.stringify(screenText.slice(-1200))}`
      : `exit=${JSON.stringify(outcome)}; rendered screen: ${JSON.stringify(screenText)}`,
    verdict,
  });
  if (h.exitInfo() === undefined) await h.detach(10_000);
}

async function testWrongProvider(results, machineName) {
  const h = attach(["claude", "--machine", machineName], { label: "wrong-provider" });
  const outcome = await h.waitForExit(75_000);
  const screenText = h.screen();
  const namesTheMismatch = /agent-mismatch|is unavailable on machine|provider_not_installed/iu.test(screenText);
  let verdict;
  if (outcome === undefined) verdict = "SILENT_HANG";
  else if (namesTheMismatch) verdict = "REFUSED_VISIBLY";
  else verdict = "UNKNOWN";
  results.push({
    path: "wrong_provider",
    action: `run \`cuna claude --machine ${machineName}\` against a machine whose installed provider is OpenCode`,
    observed: outcome === undefined
      ? `hung for 75s with no exit; last rendered screen: ${JSON.stringify(screenText.slice(-1200))}`
      : `exit=${JSON.stringify(outcome)}; rendered screen: ${JSON.stringify(screenText)}`,
    verdict,
  });
  if (h.exitInfo() === undefined) await h.detach(10_000);
}

const results = [];
let fatal;
try {
  const machine = discoverLiveMachine();
  const session = discoverRunningOpenCodeSession(machine.id);
  if (session === undefined) {
    throw new Error(`No running OpenCode AgentSession found on ${machine.name} (${machine.id}); nothing to attach to.`);
  }
  console.log(`Live subject: machine=${machine.name} (${machine.id}) session=${session.id}`);

  console.log("--- path 1+2: resize, long paste ---");
  await testResizeAndPaste(results, session.id);

  console.log("--- path 3: second attach ---");
  await testSecondAttach(results, session.id);

  console.log("--- path 4: missing capability ---");
  await testMissingCapability(results, machine.id);

  console.log("--- path 5: wrong provider ---");
  await testWrongProvider(results, machine.name);
} catch (error) {
  fatal = error;
}

console.log("\n=== NEGATIVE PATH RESULTS ===\n");
for (const r of results) {
  console.log(`[${r.verdict}] ${r.path}`);
  console.log(`  action:   ${r.action}`);
  console.log(`  observed: ${r.observed}`);
  console.log("");
}

if (fatal !== undefined) {
  console.error("FATAL:", fatal.message ?? fatal);
  process.exitCode = 1;
} else if (results.some((r) => r.verdict === "SILENT_HANG" || r.verdict === "CRASH")) {
  process.exitCode = 3;
}

// node-pty's ConPTY backend can leave a handle open (an OpenConsole.exe host
// tied to the pseudo-console) that keeps this process's event loop alive even
// after every child has reported its own exit and every detach() completed.
// Measured directly: a run that printed every result line above then sat past
// its 600s wall-clock bound with nothing left to do. All work is finished by
// this point, so exit explicitly rather than trust the loop to drain.
process.exit(process.exitCode ?? 0);
