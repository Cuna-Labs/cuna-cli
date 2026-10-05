import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { credentialFailure } from "../dist/credentials/errors.js";
import {
  MACHINE_CREATE_FOLLOW_DEADLINE_MS,
  MACHINE_CREATE_FOLLOW_POLL_INTERVAL_MS,
} from "../dist/core/observation-budget.js";

/**
 * BL-6, LIVE_RUNTIME 2026-10-03: `cuna machines create --name
 * biotech-lab-20261003 --agent opencode ... --idempotency-key ... --yes --json
 * --timeout-ms 120000` started 00:56:45.9Z. Cuna recorded the Machine started
 * at 00:58:25Z. The command returned at 01:20:13.8Z (1405 s), exit 5, with
 * `cuna.network.failed` "Cuna could not renew this session because the request
 * did not complete." and the hint "Run the command again." -- for a create Cuna
 * had committed. Re-running a create on that hint risks a second Machine.
 *
 * These tests drive the real CLI and HTTP transport, signed in as a person (so
 * every request first asks the sign-in for a bearer, as in production), against
 * a fake Cuna on a fake clock. A hang is a promise that never settles and
 * ignores its abort signal, so only a bound the CLI enforces itself ends it.
 */
const MACHINE_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const NAME = "biotech-lab-20261003";
const TOKEN = `cuna_at_${"b".repeat(43)}`;
const NOW = Date.parse("2026-10-03T00:56:45.874Z");
const RERUN_ADVICE = /run (the|this|it|the same) (command )?again|run it again/iu;
const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function never() {
  return new Promise(() => undefined);
}

/** What the sign-in throws when its renewal request did not complete. */
function renewalDidNotComplete() {
  return credentialFailure(
    "credential_refresh_failed",
    "Credential refresh failed without changing the stored credential.",
    { retryable: true, safeDetails: { reason: "cuna.network.failed" } },
  );
}

/**
 * A fake Cuna and a fake sign-in sharing one clock.
 *
 * `post`: "unanswered" holds the create until the CLI's own budget aborts it,
 * as a lost answer does; a state string answers at once with that Machine.
 * `settledAt`: the clock reading from which the create receipt says settled.
 * `machineState(server)`: the state each Machine read answers.
 * `hang(server, method, path)`: true makes that request never answer.
 * `renew(server)`: "token", "fail" or "hang" for each bearer the CLI asks for.
 */
function fakeCuna({ post = "unanswered", settledAt = 0, machineState = () => "running", hang = () => false, renew = () => "token" }) {
  const server = {
    clock: 0,
    posts: 0,
    requests: [],
    machineReads: 0,
    renewals: { token: 0, fail: 0, hang: 0 },
    runningObservedAt: undefined,
    requestIds: new Set(),
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const machine = (state) => ({ id: MACHINE_ID, name: NAME, state, agent: "opencode", vcpus: 2, memory_mib: 4096 });
  server.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    server.requests.push({ method, path: pathname, at: server.clock, afterRunning: server.runningObservedAt !== undefined });
    if (hang(server, method, pathname)) return await never();
    if (method === "GET" && pathname === "/v1/me") {
      return json({ id: ACCOUNT_ID, email: "owner@example.test", workspace: { assigned: true, id: "22222222-2222-4222-8222-222222222222", usage: { est_spend_usd: 1, est_spend_is_lower_bound: true, balance_status: "unavailable", balance_usd: null, balance_unavailable_reason: "no balance endpoint", note: "fixture" } } });
    }
    if (pathname === "/v1/capabilities") {
      return json({
        schema_version: "1.0", subject_scope: "account",
        observed_at: new Date(NOW - 1_000).toISOString(), expires_at: new Date(NOW + 30_000).toISOString(), etag: "etag-1",
        capabilities: [{ id: "machines.create", availability: "supported", interaction: "native", mutation_class: "financial", surfaces: ["cli"], required_permissions: ["machines:create"] }],
      });
    }
    if (method === "POST" && pathname === "/v1/sessions") {
      server.posts += 1;
      server.requestIds.add(init.headers["X-Cuna-Machine-Create-Request-Id"]);
      if (post !== "unanswered") return json(machine(post), 201);
      return await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
      });
    }
    const receipt = /^\/v1\/machine-creates\/([0-9a-f-]{36})$/u.exec(pathname);
    if (method === "GET" && receipt !== null) {
      const id = receipt[1];
      if (!server.requestIds.has(id)) return json({ type: "about:blank", title: "Not Found", status: 404, code: "machine_create_not_found" }, 404);
      const settled = server.clock >= settledAt;
      return json({ id, machine_id: MACHINE_ID, state: settled ? "settled" : "in_progress", retryable: !settled, action: settled ? "none" : "wait", updated_at: new Date(NOW + server.clock).toISOString() });
    }
    if (method === "GET" && pathname === `/v1/sessions/${MACHINE_ID}`) {
      server.machineReads += 1;
      const state = machineState(server);
      if (state === "running" && server.runningObservedAt === undefined) server.runningObservedAt = server.clock;
      return json(machine(state));
    }
    return json({ type: "about:blank", title: "Unexpected", status: 500, code: "unexpected_request" }, 500);
  };
  server.humanAuth = {
    async acquireAccessToken() {
      const outcome = renew(server);
      server.renewals[outcome] += 1;
      if (outcome === "fail") throw renewalDidNotComplete();
      if (outcome === "hang") return await never();
      return TOKEN;
    },
  };
  server.poller = { now: () => server.clock, async sleep(milliseconds) { server.clock += milliseconds; } };
  return server;
}

/**
 * Run the create, and give up on it after `realMs` of real time. A create that
 * is still running then is reported as such instead of stalling the suite.
 */
async function create(server, { extra = [], realMs = 10_000 } = {}) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const run = runCli([
    "machines", "create", "--name", NAME, "--agent", "opencode", "--vcpus", "2", "--memory-mib", "4096",
    "--yes", "--json", "--timeout-ms", "100", ...extra,
  ], {
    streams: streams.streams,
    platform,
    env: {},
    now: () => NOW,
    fetch: server.fetch,
    humanAuth: server.humanAuth,
    convergencePoller: server.poller,
  });
  let timer;
  const stalled = new Promise((resolve) => { timer = setTimeout(() => resolve("stalled"), realMs); });
  const started = performance.now();
  const exit = await Promise.race([run, stalled]);
  clearTimeout(timer);
  const realElapsedMs = performance.now() - started;
  assert.notEqual(exit, "stalled", `machines create had not returned after ${realMs} ms of real time`);
  const lines = streams.stderr().trim().split("\n").filter((line) => line.length > 0);
  return {
    exit,
    realElapsedMs,
    stdout: streams.stdout(),
    stderr: streams.stderr(),
    error: lines.length === 0 ? undefined : JSON.parse(lines.at(-1)).error,
  };
}

test("(a) a Machine read as running ends the create within one poll interval, with no read after it", async () => {
  // The renewal the CLI would need for any further request fails, as BL-6's
  // did. Once the Machine has been read as running there is nothing left to ask.
  const server = fakeCuna({
    settledAt: 4_000,
    machineState: (current) => (current.clock >= 60_000 ? "running" : "starting"),
    renew: (current) => (current.runningObservedAt === undefined ? "token" : "fail"),
  });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.success, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.data.id, MACHINE_ID);
  assert.equal(record.data.state, "running");
  assert.ok(server.runningObservedAt !== undefined, "the Machine was read as running");
  assert.ok(server.clock - server.runningObservedAt <= MACHINE_CREATE_FOLLOW_POLL_INTERVAL_MS,
    "success comes within one poll interval of reading it running");
  assert.deepEqual(server.requests.filter((request) => request.afterRunning), [], "no request is made after the running read");
  assert.equal(server.renewals.fail, 0, "no renewal is asked for after the running read");
  assert.equal(server.posts, 1, "the create is sent once");
});

test("(b) a renewal that fails after Cuna settled the create names the Machine and the read, and never says run it again", async () => {
  // Settled, the Machine is read once and is still starting; the renewal for
  // the next read does not complete. This is BL-6's answer, one read earlier.
  const server = fakeCuna({
    settledAt: 4_000,
    machineState: () => "starting",
    renew: (current) => (current.machineReads >= 1 ? "fail" : "token"),
  });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.doesNotMatch(`${error.message} ${error.hint}`, RERUN_ADVICE, "a committed create is never to be run again");
  assert.match(error.hint, /cuna machines list/u, "names the read that settles it");
  assert.ok(`${error.message} ${error.hint}`.includes(MACHINE_ID), "names the committed Machine id");
  assert.equal(error.retryable, false, "running this create again is not the remedy");
  assert.equal(error.details.machine_id, MACHINE_ID);
  assert.equal(error.details.remote_outcome, "committed");
  assert.equal(error.details.reason, "cuna.network.failed", "keeps what actually failed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to run`);
  assert.equal(server.renewals.fail, 1, "one failed renewal ends the wait; the login code is not exchanged again and again");
  assert.equal(server.posts, 1);
});

test("(b) a renewal that fails for the read-back after Cuna answered the create names the Machine, not run it again", async () => {
  const server = fakeCuna({
    post: "running",
    renew: (current) => (current.posts >= 1 ? "fail" : "token"),
  });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.doesNotMatch(`${error.message} ${error.hint}`, RERUN_ADVICE);
  assert.match(error.hint, /cuna machines list/u);
  assert.ok(`${error.message} ${error.hint}`.includes(MACHINE_ID));
  assert.equal(error.retryable, false);
  assert.equal(error.details.machine_id, MACHINE_ID);
  assert.equal(error.details.machine_state, "running", "what Cuna's answer to the create said");
  assert.equal(error.details.remote_outcome, "committed");
  assert.equal(error.details.reason, "cuna.network.failed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to be read back`);
  assert.equal(server.posts, 1);
});

test("(c) a read that never answers is bounded by --timeout-ms, and the timeout names what it waited for", async () => {
  // Settled and starting; from 290 s of the follow every request hangs.
  const server = fakeCuna({
    settledAt: 4_000,
    machineState: () => "starting",
    hang: (current) => current.clock >= 290_000,
  });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to run`, "the timeout says what it waited for");
  assert.equal(error.details.machine_id, MACHINE_ID);
  assert.equal(error.details.machine_state, "starting");
  assert.equal(error.details.remote_outcome, "committed");
  assert.match(error.message, new RegExp(`machine ${NAME} to run`, "u"));
  assert.match(error.hint, /cuna machines list/u);
  assert.ok(error.hint.includes(MACHINE_ID));
  assert.doesNotMatch(`${error.message} ${error.hint}`, RERUN_ADVICE);
  assert.ok(server.clock >= MACHINE_CREATE_FOLLOW_DEADLINE_MS, "the follow ran to its deadline");
  // Five hung reads of 100 ms each between 290 s and 300 s; generous for CI.
  assert.ok(result.realElapsedMs < 5_000, `bounded in real time (${Math.round(result.realElapsedMs)} ms)`);
});

test("(c) a sign-in renewal that never answers is bounded by --timeout-ms too", async () => {
  // An edge f72f391 leaves open, and one way BL-6's wait could outlive
  // --timeout-ms (its cause was not observed): the per-request budget is armed
  // only once a bearer is in hand, so a renewal that does not finish is waited
  // on without limit.
  const server = fakeCuna({
    settledAt: 4_000,
    machineState: () => "starting",
    renew: (current) => (current.clock >= 290_000 ? "hang" : "token"),
  });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to run`);
  assert.equal(error.details.machine_id, MACHINE_ID);
  assert.equal(error.details.remote_outcome, "committed");
  assert.doesNotMatch(`${error.message} ${error.hint}`, RERUN_ADVICE);
  assert.ok(server.renewals.hang >= 1, "the hung renewal was reached");
  assert.ok(result.realElapsedMs < 5_000, `bounded in real time (${Math.round(result.realElapsedMs)} ms)`);
});

test("NEGATIVE CONTROL: a Machine that is still starting at the deadline fails, naming what it waited for", async () => {
  // Everything answers at once; only the operative variable -- a running read
  // -- is absent. The fix must not turn this into a success.
  const server = fakeCuna({ settledAt: 4_000, machineState: () => "starting" });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to run`);
  assert.equal(error.details.machine_state, "starting");
  assert.equal(error.details.machine_id, MACHINE_ID);
  assert.equal(error.details.remote_outcome, "committed");
  assert.equal(error.retryable, false);
  assert.ok(error.hint.includes(MACHINE_ID));
  assert.match(error.hint, /cuna machines list/u);
  assert.doesNotMatch(`${error.message} ${error.hint}`, RERUN_ADVICE);
  assert.ok(error.details.elapsed_ms >= MACHINE_CREATE_FOLLOW_DEADLINE_MS, "it waited the whole follow deadline");
  assert.equal(server.posts, 1);
});

test("NEGATIVE CONTROL: a create Cuna never settles keeps the same-key follow advice, and names what it waited for", async () => {
  // Not committed: the receipt never leaves in_progress and no Machine is
  // read. Following the same request again with its key is the safe step, so
  // that advice and `retryable` stay.
  const server = fakeCuna({ settledAt: Number.POSITIVE_INFINITY });
  const result = await create(server, { extra: ["--idempotency-key", "biotech-lab-20261003-create-01"] });
  assert.equal(result.exit, EXIT_CODES.network, result.stderr);
  const { error } = result;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.equal(error.details.waiting_for, `machine ${NAME} to be created`);
  assert.equal(error.details.receipt_state, "in_progress");
  assert.equal(error.details.remote_outcome, "unsettled");
  assert.equal(error.retryable, true);
  assert.match(error.hint, /--idempotency-key biotech-lab-20261003-create-01/u);
  assert.equal(server.machineReads, 0);
  assert.equal(server.posts, 1);
});
