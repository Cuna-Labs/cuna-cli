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
 *   detach_with_ctrl_c, stop, delete, cleanup_zero
 *
 * It asserts nothing about `/connect`: that lives inside OpenCode's own TUI and
 * belongs to the provider, not to Cuna.
 *
 *   node scripts/harness/live-opencode-journey.mjs MACHINE_NAME [rich|plain] [--destroy]
 *
 * `stop`, `delete` and `cleanup_zero` DESTROY the machine, so they run only
 * when opted into explicitly: pass `--destroy` on the command line, or set
 * `CUNA_JOURNEY_DESTROY=1`. Without the opt-in they are recorded UNWITNESSED
 * with a reason, never FAILED -- the same distinction the rest of this file
 * already draws between "could not check" and "checked and false".
 *
 * Exit 0 means every witness below was observed. Any failure prints the last
 * screen and the transcript tail, because a journey runner that reports only
 * "failed" costs a second run to learn anything.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";

const machineName = process.argv[2];
if (machineName === undefined) {
  throw new Error("Usage: node scripts/harness/live-opencode-journey.mjs MACHINE_NAME [rich|plain] [--destroy]");
}
const presentationMode = process.argv[3] ?? "rich";
if (presentationMode !== "rich" && presentationMode !== "plain") {
  throw new Error("Presentation mode must be rich or plain.");
}
/**
 * The opt-in for `stop` / `delete` / `cleanup_zero`. Default OFF: those three
 * conjuncts destroy the machine, and this runner must never do that as a side
 * effect of an ordinary attach-and-detach smoke run.
 */
const destroyEnabled = process.argv.includes("--destroy") || process.env.CUNA_JOURNEY_DESTROY === "1";

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
/**
 * The named machine's id, and the rejection if it never resolved.
 *
 * `select_opencode_machine` used to be a screen regex that Cuna's own chrome
 * satisfies regardless of whether MACHINE_NAME means anything, and this
 * promise's rejection was never read anywhere — `refreshDurableSessions`
 * below awaits it inside a try/catch that only sets `durableError`, which no
 * witness ever inspects. So a typo'd or deleted machine name still produced
 * a green run. `machineId`/`machineResolutionError` are read directly by the
 * witness, so a rejection now fails the run instead of vanishing.
 */
let machineId;
let machineResolutionError;
const machineIdPromise = (async () => {
  const out = await runCli(["machines", "list"]);
  const found = out?.data?.items?.find((m) => m.name === machineName);
  if (found === undefined) throw new Error(`No machine named ${machineName}`);
  return found.id;
})();
machineIdPromise.then(
  (id) => { machineId = id; },
  (error) => { machineResolutionError = error; },
);

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
 * The workspace-binding record the CLI itself commits to
 * `<workspace>/.cuna/workspace.json` (schema `cuna.workspace-binding.v2`,
 * written by `persistWorkspaceBinding` in `src/workspace/binding-store.ts`,
 * called only from `src/journey/workspace-effects.ts:225` after a real
 * sync/commit). This harness never writes this file — it is a field only the
 * CLI's own workspace-sync event can write, which is exactly what
 * `create_or_open_exact_session` needs to check exactness against, instead of
 * "a running session appeared".
 *
 * Left `undefined` on any read failure (missing file, mid-write, corrupt
 * JSON): that is "cannot decide", not "no binding", and every caller below
 * treats it that way.
 */
let localBinding;
async function refreshLocalBinding() {
  try {
    const text = await readFile(path.join(process.cwd(), ".cuna", "workspace.json"), "utf8");
    localBinding = JSON.parse(text);
  } catch {
    // Leave localBinding as-is: a transient read racing the CLI's own atomic
    // rename self-corrects on the next poll.
  }
}

/**
 * THIS run's AgentSession, but only if it is EXACT: same machine, same
 * workspace binding, same generation, same remote cwd as the local binding
 * record the CLI itself just committed — `journey/selection.ts:593`'s own
 * `isExactSessionKey`, re-applied here from outside the process. The prior
 * predicate stopped at "a running session THIS run created", which a forked
 * sibling holding a stale generation or a different binding also satisfies.
 *
 * `undefined` whenever `localBinding` has not been read: exactness cannot be
 * claimed against a binding this harness has not seen.
 *
 * The `created_at OR runtime_observed_at` time bound is deliberate: the
 * "OR open an existing exact session" branch cannot be exercised by the
 * product today — `attachment` is a hardcoded `"unknown"` in
 * `src/journey/api-effects.ts:76`, so `planAgentSessionSelection`
 * (`selection.ts:747`) refuses every exact match as
 * `attachment-unobservable` before it ever reaches the reusable/"open"
 * branch (`selection.ts:761`). `created_at` is therefore the only bound the
 * product can satisfy today. `runtime_observed_at` — the field a later
 * supervisor confirmation writes, independent of row creation — is included
 * so this witness is already correct once "open" becomes reachable, instead
 * of needing a second repair.
 */
function exactSessionThisRun() {
  if (localBinding === undefined) return undefined;
  return durableSessions.find((s) =>
    s.agent === "opencode" &&
    (s.process_state === "running" || s.process_state === "ready") &&
    s.machine_id === machineId &&
    s.machine_id === localBinding.machineId &&
    s.workspace_binding_id === localBinding.bindingId &&
    s.workspace_generation === localBinding.generation &&
    s.cwd === localBinding.remoteRoot &&
    (
      (typeof s.created_at === "string" && Date.parse(s.created_at) >= runStartedAt - 5_000) ||
      (typeof s.runtime_observed_at === "string" && Date.parse(s.runtime_observed_at) >= runStartedAt - 5_000)
    ));
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
function terminalRedeemedThisRun(agentSessionId) {
  const projectRef = process.env.CUNA_HARNESS_PROJECT_REF ?? "gnxoicpqjjrktktuzqws";
  const since = new Date(runStartedAt - 5_000).toISOString();
  // Scoped to the exact AgentSession, not the Machine. The comment fifty lines
  // up has always said `bound to the exact agent_session_id`; the query said
  // `machine_id` and was satisfied by ANY attach on that Machine, including one
  // from another client or a sibling session this run did not create. A witness
  // whose scope is wider than its claim is the same defect as a screen match,
  // wearing a database query as a disguise.
  const sql = `select count(*)::int as redeemed from public.terminal_connections `
    + `where agent_session_id = '${agentSessionId}' and redeemed_at is not null `
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

/**
 * Run one read-only SQL statement against the linked Supabase project via the
 * CLI's own keyring session, exactly like `terminalRedeemedThisRun` above --
 * same instrument, same `cwd: os.tmpdir()` reason (the Supabase CLI writes
 * `supabase/.temp/` into its working directory, and this harness runs with
 * the workspace under test as its own `cwd`; running there would advance the
 * workspace generation the earlier witnesses depend on).
 *
 * Fails CLOSED: any reason the query could not run -- missing CLI, expired
 * session, wrong project, non-zero exit -- returns `undefined`, never `""`.
 * `undefined` is "cannot decide", and every caller below treats it that way.
 */
function runDurableQuery(sql) {
  const projectRef = process.env.CUNA_HARNESS_PROJECT_REF ?? "gnxoicpqjjrktktuzqws";
  const file = path.join(os.tmpdir(), `cuna-journey-${process.pid}-${Date.now()}.sql`);
  try {
    writeFileSync(file, `${sql}\n`, "utf8");
    const out = spawnSync(
      "supabase",
      ["db", "query", "--linked", "--project-ref", projectRef, "--file", file],
      { encoding: "utf8", timeout: 120_000, shell: true, cwd: os.tmpdir() },
    );
    if (out.status !== 0) return undefined;
    return out.stdout ?? undefined;
  } catch {
    return undefined;
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * `public.sessions.status` for the exact machine id THIS run targeted -- the
 * field the `stop`/`delete` mutation itself writes, and NOT the CLI's own
 * post-mutation read. `commands.ts`'s own delete convergence probe
 * (`executeMachines`, action "delete") treats a `cuna.remote.not_found` from
 * `client.getMachine` as "settled: true, observed_state: absent" -- so a
 * `cuna machines list` read after delete can legitimately omit the row
 * instead of showing `status: deleted`, and a witness built on that read
 * could not tell "deleted" apart from "never existed". The row itself does
 * not have that ambiguity: this repo's own `0001_init.sql` soft-deletes
 * (`status` moves to `'deleted'`, the row stays), so reading `sessions`
 * directly is the one query that names the field, not a downstream project-
 * ion of it.
 */
function machineStatus(id) {
  const stdout = runDurableQuery(`select status from public.sessions where id = '${id}';`);
  if (stdout === undefined) return undefined;
  const match = /"status":\s*"([a-z_]+)"/u.exec(stdout);
  return match === null ? undefined : match[1];
}

/**
 * `cleanup_zero`'s five independent resource-class predicates, for the exact
 * machine id, in one query so they are all read from the same instant:
 *
 *   sessions.status = 'deleted'
 *   0 agent_sessions with desired_state <> 'terminated'
 *   0 workspace_bindings with state <> 'deleted'
 *   0 terminal_connections with state = 'issued'
 *   0 sessions counting toward quota (status in the four live states)
 *
 * "The machine disappeared" is not one of these. A machine can vanish from
 * `cuna machines list` while an orphaned `agent_sessions` row, workspace
 * binding, or issued terminal grant survives underneath it -- that is
 * exactly the shape of leak this conjunct exists to catch, so each class is
 * asserted on its own table, never inferred from the others.
 */
function cleanupState(id) {
  const sql = [
    "select",
    `  (select status from public.sessions where id = '${id}') as machine_status,`,
    "  (select count(*)::int from public.agent_sessions",
    `     where machine_id = '${id}' and desired_state <> 'terminated') as active_agent_sessions,`,
    "  (select count(*)::int from public.workspace_bindings",
    `     where machine_id = '${id}' and state <> 'deleted') as active_workspace_bindings,`,
    "  (select count(*)::int from public.terminal_connections",
    `     where machine_id = '${id}' and state = 'issued') as issued_terminal_connections,`,
    "  (select count(*)::int from public.sessions",
    `     where id = '${id}' and status in ('creating','running','paused','suspended')) as quota_machines;`,
  ].join("\n");
  const stdout = runDurableQuery(sql);
  if (stdout === undefined) return undefined;
  const statusMatch = /"machine_status":\s*"([a-z_]+)"/u.exec(stdout);
  const agentMatch = /"active_agent_sessions":\s*(\d+)/u.exec(stdout);
  const bindingMatch = /"active_workspace_bindings":\s*(\d+)/u.exec(stdout);
  const terminalMatch = /"issued_terminal_connections":\s*(\d+)/u.exec(stdout);
  const quotaMatch = /"quota_machines":\s*(\d+)/u.exec(stdout);
  if (statusMatch === null || agentMatch === null || bindingMatch === null
    || terminalMatch === null || quotaMatch === null) {
    return undefined;
  }
  return {
    machineStatus: statusMatch[1],
    activeAgentSessions: Number(agentMatch[1]),
    activeWorkspaceBindings: Number(bindingMatch[1]),
    issuedTerminalConnections: Number(terminalMatch[1]),
    quotaMachines: Number(quotaMatch[1]),
  };
}

/**
 * Poll a durable SQL predicate on its own cadence, for the three destructive
 * conjuncts below. Mirrors `witness()`'s own two-way split exactly, just for
 * an async/expensive probe instead of a synchronous in-memory one:
 *
 *   the query never answered           -> UNWITNESSED (never FAILED)
 *   the query answered, never matched  -> FAILED at the deadline
 *
 * The first is "cannot decide" (no Supabase CLI, no session, wrong project);
 * the second is a decided, checkable predicate that stayed false, which is
 * exactly the case the rest of this file treats as a real defect rather than
 * hiding it behind "unwitnessed".
 */
async function witnessDurableQuery(name, queryFn, matchFn, timeoutMs, cadenceMs = 5_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastProbe = 0;
  let latest;
  let everAnswered = false;
  for (;;) {
    if (latest !== undefined && matchFn(latest)) {
      witnesses.push({ name, observed: true, ms: Date.now() - startedAt });
      return;
    }
    if (Date.now() >= deadline) {
      if (!everAnswered) {
        witnesses.push({
          name,
          observed: false,
          ms: Date.now() - startedAt,
          unwitnessable: true,
          why: "the durable query never answered",
        });
        return;
      }
      throw new Error(
        `WITNESS FAILED: ${name}\n\n--- last observed ---\n${JSON.stringify(latest)}`,
      );
    }
    if (Date.now() - lastProbe >= cadenceMs) {
      lastProbe = Date.now();
      const result = queryFn();
      if (result !== undefined) {
        latest = result;
        everAnswered = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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

async function witness(name, predicate, timeoutMs, unwitnessableReason) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (predicate()) {
      witnesses.push({ name, observed: true, ms: Date.now() - startedAt });
      return;
    }
    if (Date.now() >= deadline || exitResult !== undefined) {
      /*
       * A conjunct whose probe never answered is UNWITNESSED, not failed, and
       * the difference is the whole point of this runner. `unwitnessable` was
       * read in three places at the bottom of this file and assigned in none of
       * them, so the `----` marker and the entire exit-code-2 INCOMPLETE branch
       * were dead code: every unanswerable conjunct was reported as a defect,
       * and -- worse -- a run that checked nothing could still exit 0 as long as
       * the screen-shaped predicates happened to match.
       *
       * `unwitnessableReason` generalizes the one hardcoded case this used to
       * special-case (`attach_pty`, matched by name-prefix string) to any
       * witness that can honestly say "I cannot decide this" rather than
       * "this is false" — e.g. `create_or_open_exact_session` when the local
       * workspace-binding record was never read.
       */
      const reason = typeof unwitnessableReason === "function" ? unwitnessableReason() : undefined;
      witnesses.push({
        name,
        observed: false,
        ms: Date.now() - startedAt,
        ...(reason !== undefined ? { unwitnessable: true, why: reason } : {}),
      });
      if (reason !== undefined) return;
      throw new Error(
        `WITNESS FAILED: ${name}\n\n--- screen ---\n${screen()}\n\n--- transcript tail ---\n${transcript.slice(-4_000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (Date.now() - lastDurableRefresh > 5_000) {
      lastDurableRefresh = Date.now();
      void refreshDurableSessions();
      void refreshLocalBinding();
    }
    // The durable attach probe is expensive (it shells out), so it runs on its
    // own slower cadence and only once a session exists to attach to.
    const created = sessionCreatedThisRun();
    if (Date.now() - lastAttachProbe > 15_000 && created !== undefined) {
      lastAttachProbe = Date.now();
      // The session THIS run created, not the Machine it sits on.
      attachProbe = terminalRedeemedThisRun(created.id);
    }
  }
}

let failure;
try {
  // The journey may legitimately take a while: it synchronizes a workspace and
  // waits on a remote process observation. What it may NOT do is sit on a
  // spinner with nothing behind it, so every wait here is bounded and named.
  //
  // NOT a screen match. `/ATTACHING 1 EXACT AGENTSESSION|Syncing workspace/`
  // is satisfied by Cuna's own chrome the instant it is printed, regardless of
  // whether MACHINE_NAME means anything, and `machineIdPromise`'s rejection
  // was never read by any witness — a typo'd or deleted machine name still
  // produced a green run. The durable fact is whether the name resolves at
  // all: `cuna machines list` is the authoritative source (not this process's
  // belief about its own argument), and a rejection now fails the run instead
  // of vanishing into `durableError`, which nothing ever inspected.
  //
  // This alone proves only that the NAME resolves to a real machine, not that
  // the child process under test committed to it — that commitment is closed
  // by `create_or_open_exact_session` below, which requires the exact
  // session's `machine_id` to equal this same id.
  await witness(
    "select_opencode_machine — the named machine durably resolved to an id",
    () => {
      if (machineResolutionError !== undefined) {
        throw new Error(
          `select_opencode_machine — machine "${machineName}" did not resolve `
          + `via \`cuna machines list\`: ${machineResolutionError.message ?? machineResolutionError}`,
        );
      }
      return machineId !== undefined;
    },
    90_000,
  );
  // NOT a screen match, and re-ordered ahead of `watch_a_truthful_progress_-
  // state` below, which now depends on the exact session this witness finds.
  // This used to read `sessionCreatedThisRun() !== undefined` — "a running
  // session THIS run created" — which ANY running session on the machine
  // satisfies, including a forked sibling holding a stale generation or a
  // different workspace binding. A control that cannot distinguish the exact
  // session from a sibling is not exactness.
  //
  // The durable fact is `journey/selection.ts:593`'s own `isExactSessionKey`,
  // re-applied here from outside the process: the session must match the
  // local `.cuna/workspace.json` binding record the CLI itself just
  // committed, on machine, workspace binding, generation AND cwd — not merely
  // "a running session appeared". See `exactSessionThisRun` above.
  //
  // Measured 2026-08-30: a cold OpenCode AgentSession took 6m14s from create
  // to an observed running process, so the budget below sits above that
  // measurement, not at it — a shorter budget reports a defect where there is
  // only latency.
  let exactSession;
  await witness(
    "create_or_open_exact_session — THIS run's session is EXACT: machine, workspace binding, generation and cwd all match",
    () => {
      const candidate = exactSessionThisRun();
      if (candidate === undefined) return false;
      exactSession = candidate;
      return true;
    },
    420_000,
    () => (localBinding === undefined
      ? "the local .cuna/workspace.json binding record was never read, so exactness (workspace binding, generation, cwd) could not be checked"
      : undefined),
  );
  // NOT a screen match. `/Checking terminal authority|Syncing workspace|-
  // Starting/` used to be satisfied by fixed strings the CLI prints on a
  // timer, true or not — and `Syncing workspace` is the exact string that
  // ALSO satisfied `select_opencode_machine` above, so one string green-lit
  // two witnesses and neither checked that the state it named was real.
  //
  // The durable fact is independent supervisor confirmation, not a
  // self-reported row. `runtime_observed_at` and `process_epoch` are
  // rendered by the service from a `cuna_agent_session_supervisor` authority
  // event (`runtime/terminal-transport.ts:88-107`) — a DIFFERENT actor than
  // the one that wrote `created_at` — and `machines/session-actionability.ts:-
  // 93-111` is the product's own definition of "genuinely, freshly confirmed"
  // (`processEpoch` + `runtimeObservedAt` + `runtimeExpiresAt` all present,
  // `runtimeExpiresAt > runtimeObservedAt`), re-applied here on the exact
  // session `create_or_open_exact_session` just found. A row that claims
  // `process_state: running` with no such confirmation ever recorded is
  // exactly the "lying spinner" this conjunct exists to catch, so it fails
  // this witness rather than reporting it as unwitnessable.
  await witness(
    "watch_a_truthful_progress_state — the exact session carries an independent supervisor confirmation, not just a self-reported state",
    () => {
      if (exactSession === undefined) return false;
      // Re-read the freshest observation of the exact row: `runtime_-
      // observed_at` is written by a LATER supervisor confirmation than the
      // row's own creation, so the snapshot captured when the previous
      // witness first matched can be stale.
      const current = durableSessions.find((s) => s.id === exactSession.id) ?? exactSession;
      if (typeof current.process_epoch !== "string" || current.process_epoch.length === 0) return false;
      if (typeof current.runtime_observed_at !== "string" || typeof current.runtime_expires_at !== "string") {
        return false;
      }
      const observedAt = Date.parse(current.runtime_observed_at);
      const expiresAt = Date.parse(current.runtime_expires_at);
      if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= observedAt) return false;
      // Bounded to this run: a confirmation carried over from a stale prior
      // process epoch would prove nothing about the progress THIS run watched.
      return observedAt >= runStartedAt - 5_000;
    },
    60_000,
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
      // `undefined` means the probe could not answer, which is NOT the same as
      // "no attach happened". Returning false here reported a defect whenever
      // the Supabase CLI was missing or unauthenticated. The distinction is
      // made after the wait, below.
      if (attachProbe === undefined) return false;
      return attachProbe === true;
    },
    180_000,
    () => (attachProbe === undefined ? "the durable attach probe never answered" : undefined),
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
    // A distinctive token, echoed back. This compared `transcript.length` to a
    // baseline plus sixteen, which a spinner repaint or a clock tick satisfies
    // without a single byte reaching the remote process. The conjunct is named
    // "bytes typed locally came back", so the predicate has to be those bytes.
    const probeToken = `cuna-echo-${process.pid.toString(36)}`;
    const beforeTyping = transcript.length;
    child.write(`${probeToken}\r`);
    await witness(
      "type_and_see_bytes — the exact bytes typed came back from the remote process",
      () => transcript.slice(beforeTyping).includes(probeToken),
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

  /*
   * Detaching is not the same as surviving, and the old check could not tell
   * them apart: it asserted only that the CLI process exited, which is equally
   * true when Ctrl-C KILLED the remote child, when the CLI crashed, and when it
   * failed for any other reason. Since `reconnect_to_the_same_process` depends
   * entirely on the child outliving the detach, that is the fact to read --
   * from the durable row, after the fact, for the exact session this run made.
   */
  const detached = sessionCreatedThisRun();
  if (detached === undefined) {
    witnesses.push({
      name: "detach_with_ctrl_c — the remote process survived the detach",
      observed: false,
      unwitnessable: true,
      ms: 0,
      why: "no durable AgentSession from this run to re-read",
    });
  } else {
    await refreshDurableSessions();
    const after = durableSessions.find((s) => s.id === detached.id);
    const survived = after !== undefined
      && (after.process_state === "running" || after.process_state === "ready");
    witnesses.push({
      name: "detach_with_ctrl_c — the remote process survived the detach",
      observed: survived,
      ms: 0,
      ...(survived ? {} : {
        why: `process_state=${after?.process_state ?? "row gone"} after detach`,
      }),
    });
    if (!survived) {
      throw new Error(
        "WITNESS FAILED: Ctrl-C detached the client and did not leave the remote "
        + `process running (process_state=${after?.process_state ?? "row gone"}). `
        + "Detach must not terminate the child.",
      );
    }
  }

  /*
   * stop, delete, cleanup_zero -- the three conjuncts nothing before today
   * witnessed in the same run as the attach above. Each was only ever proven
   * by a person typing a separate command afterward, which is precisely the
   * arrangement this harness exists to close: no single run witnessed the
   * whole journey.
   *
   * DESTROYS the machine, so it runs only under the explicit opt-in
   * (`destroyEnabled`, computed at the top of this file). Without it, each
   * conjunct is recorded UNWITNESSED with a reason -- not FAILED, and not
   * silently skipped either, so a reader of the summary always sees the gap
   * named rather than absent.
   */
  if (!destroyEnabled) {
    for (const name of [
      "stop — the durable machine row (public.sessions) reached status=stopped",
      "delete — the durable machine row (public.sessions) reached status=deleted",
      "cleanup_zero — sessions/agent_sessions/workspace_bindings/terminal_connections/quota all settled, per resource class",
    ]) {
      witnesses.push({
        name,
        observed: false,
        ms: 0,
        unwitnessable: true,
        why: "destructive conjuncts are opt-in; pass --destroy or set CUNA_JOURNEY_DESTROY=1",
      });
    }
  } else {
    // The mutation's own accepted/rejected response is not the witness --
    // only the durable row is, for the exact reason `postconditionUnverified`
    // exists in `commands.ts`: the CLI can report success while the producer
    // has not converged, or report a conflict while it already has. Ignore
    // the self-report; poll the row.
    await runCli(["machines", "stop", machineId, "--yes"]);
    await witnessDurableQuery(
      "stop — the durable machine row (public.sessions) reached status=stopped",
      () => machineStatus(machineId),
      (status) => status === "stopped",
      180_000,
    );

    await runCli(["machines", "delete", machineId, "--yes"]);
    await witnessDurableQuery(
      "delete — the durable machine row (public.sessions) reached status=deleted",
      () => machineStatus(machineId),
      (status) => status === "deleted",
      180_000,
    );

    // Checked PER RESOURCE CLASS, not by "the machine disappeared" -- see
    // `cleanupState` above for why that substitution hides orphaned rows.
    await witnessDurableQuery(
      "cleanup_zero — sessions/agent_sessions/workspace_bindings/terminal_connections/quota all settled, per resource class",
      () => cleanupState(machineId),
      (state) => state.machineStatus === "deleted"
        && state.activeAgentSessions === 0
        && state.activeWorkspaceBindings === 0
        && state.issuedTerminalConnections === 0
        && state.quotaMachines === 0,
      180_000,
    );
  }
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
  const why = entry.unwitnessable === true && entry.why !== undefined ? ` -- ${entry.why}` : "";
  console.log(`${mark} ${entry.name}${entry.ms > 0 ? ` (${entry.ms}ms)` : ""}${why}`);
}
const unwitnessed = witnesses.filter((w) => w.unwitnessable === true);
if (unwitnessed.length > 0 && unwitnessed.some((w) => w.name.startsWith("attach_pty"))) {
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
} else if (unwitnessed.length > 0) {
  // Zero must mean "every conjunct was witnessed", not "nothing threw". A run
  // that cannot check every conjunct has not proven the journey, and exiting
  // zero is how a reader — or a CI job — comes to believe otherwise. Measured
  // 2026-08-30: a run exited zero with seven greens while
  // `terminal_connections` held no row for it at all.
  console.error(
    `INCOMPLETE: ${unwitnessed.map((w) => w.name).join(", ")} ${unwitnessed.length === 1 ? "was" : "were"} not ` +
    "witnessed. Exit 0 is reserved for a run in which every conjunct above was checked.",
  );
  process.exitCode = 2;
}
