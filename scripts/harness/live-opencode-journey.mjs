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
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
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
let attachProbe;
let lastAttachProbe = 0;
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

/**
 * Any running AgentSession on the machine — deliberately weak, and never on its
 * own a witness that THIS run did anything.
 *
 * Measured 2026-08-30: a run reported seven green witnesses in 26–31ms against
 * a machine that already held a running session from an earlier run. It created
 * a second session and opened no terminal at all; every predicate below was
 * already true before it started. The durable record settled it — two
 * `terminal_connections` rows existed, both bound to the OLD session and both
 * issued minutes earlier.
 *
 * So this is a precondition, not a witness. `sessionCreatedThisRun` is what the
 * assertions below actually use; this is kept only to make the distinction
 * legible to the next reader.
 */
function durableRunningSession() {
  return durableSessions.find((s) => s.process_state === "running");
}

/**
 * A running AgentSession that THIS run created.
 *
 * Bounding by `startedAt` is the whole point: without it a session left by an
 * earlier run certifies a run that created nothing.
 *
 * THIS IS STILL NOT A WITNESS THAT A PTY ATTACHED. The only durable proof of an
 * attach is a `terminal_connections` row with `redeemed_at` set and bound to the
 * exact `agent_session_id` — a grant can be issued and never consumed. The CLI
 * exposes no command that lists terminal connections, so this harness cannot
 * check it, and inventing a weaker screen-based substitute is what produced two
 * separate rounds of false green today. Verify it out of band:
 *
 *   select agent_session_id, state, issued_at, redeemed_at
 *     from public.terminal_connections
 *    where machine_id = '<id>' order by issued_at;
 */
const runStartedAt = Date.now();
function sessionCreatedThisRun() {
  return durableSessions.find((s) =>
    s.process_state === "running" &&
    typeof s.created_at === "string" &&
    Date.parse(s.created_at) >= runStartedAt - 5_000);
}

/**
 * Did a terminal connection get REDEEMED during this run?
 *
 * This reads the database directly, which a product surface must never do — but
 * this is a harness, and the alternative is what happened three times today:
 * a screen-shaped proxy that goes green without an attach. A grant can be
 * issued and never consumed, so `redeemed_at` is the fact, and no field the CLI
 * exposes carries it.
 *
 * Fails CLOSED. If the query cannot run — no Supabase CLI, no session, wrong
 * project — this returns `undefined`, which the caller reports as unwitnessed.
 * It never returns `true` on an unanswered question.
 *
 * Requires `supabase projects list` to already work; set CUNA_HARNESS_PROJECT_REF
 * to override the project.
 */
function terminalRedeemedThisRun(machineId) {
  const projectRef = process.env.CUNA_HARNESS_PROJECT_REF ?? "gnxoicpqjjrktktuzqws";
  const since = new Date(runStartedAt - 5_000).toISOString();
  const sql = `select count(*)::int as redeemed from public.terminal_connections `
    + `where machine_id = '${machineId}' and redeemed_at is not null `
    + `and issued_at > '${since}';`;
  const file = path.join(os.tmpdir(), `cuna-journey-${process.pid}.sql`);
  try {
    writeFileSync(file, `${sql}\n`, "utf8");
    const out = spawnSync(
      "supabase",
      ["db", "query", "--linked", "--project-ref", projectRef, "--file", file],
      // Run OUTSIDE the workspace under test. The Supabase CLI writes a
      // `supabase/.temp/` directory into its working directory, and this
      // harness runs with the workspace as its cwd -- so the witness that
      // proves the attach was also adding two files to the workspace it
      // measures. That advanced the workspace generation, and generation is
      // part of the exact-session key, so the next run could no longer match
      // the session this one created and forked a sibling instead. The
      // instrument was manufacturing the defect it would then have reported.
      { encoding: "utf8", timeout: 120_000, shell: true, cwd: os.tmpdir() },
    );
    const match = /"redeemed":\s*(\d+)/u.exec(out.stdout ?? "");
    if (match === null) return undefined;
    return Number(match[1]) > 0;
  } catch {
    return undefined;
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
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
    // The durable attach probe is expensive (it shells out), so it runs on its
    // own slower cadence and only once a session exists to attach to.
    if (Date.now() - lastAttachProbe > 15_000 && sessionCreatedThisRun() !== undefined) {
      lastAttachProbe = Date.now();
      const id = await machineIdPromise.catch(() => undefined);
      if (id !== undefined) attachProbe = terminalRedeemedThisRun(id);
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
    "create_or_open_exact_session — THIS run created a durable AgentSession, now running",
    () => sessionCreatedThisRun() !== undefined,
    240_000,
  );
  // attach_pty IS NOT WITNESSED HERE, and this runner will not pretend it is.
  //
  // Three attempts to witness it from inside this process have now produced a
  // green against a run that opened no terminal at all:
  //   1. `/OpenCode/.test(screen())` — satisfied by the CLI's own chrome.
  //   2. the same, plus any running session — satisfied by a session an earlier
  //      run left behind.
  //   3. the same, plus a session THIS run created — satisfied the moment the
  //      session exists, which is strictly before any attach.
  // Measured 2026-08-30T17:03-17:11Z: all seven witnesses green, and
  // `select … from terminal_connections where issued_at > <run start>` returned
  // zero rows. Nothing was attached.
  //
  // A grant can be issued and never consumed, so the only durable proof is a
  // `terminal_connections` row with `redeemed_at` set, bound to the exact
  // `agent_session_id`. The CLI exposes no command that reads that table, so
  // this harness cannot check it — and every screen-shaped substitute is
  // satisfiable without an attach. Emitting an unverifiable green is the exact
  // failure this runner exists to prevent, so it prints the query instead.
  // So it asks the durable record instead. `redeemed_at` is the fact: a grant
  // issued and never consumed is not an attach, and no field the CLI exposes
  // carries it.
  await witness(
    "attach_pty — a terminal grant was REDEEMED during this run",
    () => {
      if (attachProbe === undefined) return false;
      return attachProbe === true;
    },
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
  const mark = entry.unwitnessable === true ? "----" : entry.observed ? "OK  " : "FAIL";
  console.log(`${mark} ${entry.name}${entry.ms > 0 ? ` (${entry.ms}ms)` : ""}`);
}
if (witnesses.some((w) => w.unwitnessable === true)) {
  console.log([
    "",
    "attach_pty must be verified against the durable record:",
    "  select agent_session_id, state, issued_at, redeemed_at",
    "    from public.terminal_connections",
    `   where machine_id = <this machine> and issued_at > '${new Date(runStartedAt).toISOString()}'`,
    "",
    "A row with redeemed_at set is an attach. No rows means nothing attached,",
    "however green everything above reads.",
  ].join("\n"));
}
console.log(`exit=${JSON.stringify(exitResult ?? null)}`);
if (failure !== undefined) {
  console.error(String(failure.message ?? failure));
  process.exitCode = 1;
} else if (witnesses.some((w) => w.unwitnessable === true)) {
  // Zero must mean "every conjunct was witnessed", not "nothing threw". A run
  // that cannot check attach_pty has not proven the journey, and exiting zero
  // is how a reader — or a CI job — comes to believe otherwise. Measured
  // 2026-08-30: a run exited zero with seven greens while
  // `terminal_connections` held no row for it at all.
  console.error(
    "INCOMPLETE: attach_pty was not witnessed. Exit 0 is reserved for a run in " +
    "which every conjunct above was checked.",
  );
  process.exitCode = 2;
}
