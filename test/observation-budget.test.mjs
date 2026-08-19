import assert from "node:assert/strict";
import test from "node:test";

import {
  CunaError,
  DEFAULT_REQUEST_BUDGET_MS,
  EXIT_CODES,
  MACHINE_CREATE_REQUEST_BUDGET_MS,
  OBSERVATION_BUDGET_CODES,
  createCunaApiClient,
  createHttpTransport,
  isObservationBudgetCode,
  memoryStreams,
  observationBudgetElapsed,
  runCli,
} from "../dist/index.js";

/**
 * THE FLOOR IS LITERAL, IN BOTH DIRECTIONS, ON PURPOSE.
 *
 * The requirement this file exists for is D3: *a test SHALL fail if a
 * client-budget refusal is emitted with `retryable: false`*. A test parametrized
 * over `OBSERVATION_BUDGET_CODES` alone cannot do that, because deleting an
 * entry from the record deletes the case that would have failed — the
 * parametrization narrows along with the source, which is the exact mistake this
 * repository made in a dual-accept test and has now written down twice.
 *
 * So the authority for this file is the hand-written list below, and
 * `OBSERVATION_BUDGET_CODES` is the thing being compared against it. Adding a
 * kind is a deliberate edit here; removing one is a failure.
 *
 * The negatives matter as much as the positives. `cuna.network.timeout` and
 * `cuna.remote.postcondition_unverified` are the two codes this change RETIRED
 * from the client-budget path, and asserting they are not budget codes is what
 * stops someone re-pointing the old names at the new behaviour and calling it
 * fixed.
 */
const REQUIRED_OBSERVATION_BUDGET_CODES = Object.freeze([
  "cuna.client.response_budget_elapsed",
  "cuna.client.convergence_budget_elapsed",
]);

/**
 * The measured server-side duration of `POST /v1/sessions`, written out here as
 * a number rather than imported, so the budget cannot be lowered to whatever the
 * implementation currently says.
 *
 * Measured 2026-08-19T00:17Z, Fly release v93, installed `cuna 0.1.0`: the CLI
 * aborted at its 15 s default after a 24 s invocation and the machine reached
 * `running` about five seconds later, so the create takes on the order of 50 s.
 */
const MEASURED_MACHINE_CREATE_MS = 50_000;

const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

const CAPABILITY_EXPIRY = "2026-08-08T00:00:30.000Z";

function capabilitySnapshot(capabilityId, subjectScope, subjectId) {
  return {
    schemaVersion: "1.0",
    subjectScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: CAPABILITY_EXPIRY,
    etag: "fixture",
    capabilities: [{
      id: capabilityId,
      availability: "supported",
      interaction: "native",
      mutationClass: "destructive",
      surfaces: ["cli"],
      requiredPermissions: ["write"],
    }],
  };
}

/** A poller that never blocks and advances a fake clock instead. */
function fakeConvergencePoller() {
  let clock = 0;
  const record = { sleeps: 0, elapsed: () => clock };
  return {
    poller: {
      now: () => clock,
      async sleep(milliseconds) {
        record.sleeps += 1;
        clock += milliseconds;
      },
    },
    record,
  };
}

/* -------------------------------------------------------------------------- */
/* The floor                                                                  */
/* -------------------------------------------------------------------------- */

test("the observation-budget authority holds exactly the required codes", () => {
  const minted = Object.values(OBSERVATION_BUDGET_CODES);
  for (const code of REQUIRED_OBSERVATION_BUDGET_CODES) {
    assert.ok(
      minted.includes(code),
      `${code} is no longer minted. A client-budget refusal it used to carry now wears another code.`,
    );
  }
  assert.equal(
    minted.length,
    REQUIRED_OBSERVATION_BUDGET_CODES.length,
    "A budget code was added without being written into this floor, so nothing here asserts it is retryable.",
  );
  // Literal oracle on the mint itself. Membership assertions alone are satisfied
  // by swapping which kind carries which string.
  assert.equal(OBSERVATION_BUDGET_CODES.response, "cuna.client.response_budget_elapsed");
  assert.equal(OBSERVATION_BUDGET_CODES.convergence, "cuna.client.convergence_budget_elapsed");
});

test("codes retired from the client-budget path are not readmitted to it", () => {
  for (const code of REQUIRED_OBSERVATION_BUDGET_CODES) {
    assert.equal(isObservationBudgetCode(code), true, code);
  }
  for (const code of [
    "cuna.network.timeout",
    "cuna.remote.postcondition_unverified",
    "cuna.network.failed",
    "cuna.network.cancelled",
    "cuna.remote.conflict",
  ]) {
    assert.equal(isObservationBudgetCode(code), false, code);
  }
});

test("D3: no client-budget refusal can be minted with retryable false", () => {
  // Parametrized over the literal floor, so deleting a kind from the source
  // cannot delete the case. The kind is recovered by searching the record for
  // the code, which fails loudly if the record no longer carries it.
  for (const code of REQUIRED_OBSERVATION_BUDGET_CODES) {
    const kind = Object.keys(OBSERVATION_BUDGET_CODES)
      .find((name) => OBSERVATION_BUDGET_CODES[name] === code);
    assert.ok(kind !== undefined, `${code} has no kind in the authority.`);
    const error = observationBudgetElapsed({
      kind,
      operation: "machine deletion",
      settleWith: "cuna machines list",
      budgetMs: 30_000,
    });
    assert.equal(error.code, code);
    assert.equal(error.retryable, true, `${code} denied retry for the CLI's own budget.`);
    assert.equal(error.exitCode, EXIT_CODES.network);
    assert.match(error.hint, /cuna machines list/u);
    assert.equal(error.details.settle_with, "cuna machines list");
    assert.equal(error.details.remote_outcome, "unobserved");
    // It must never claim the mutation did not apply.
    const said = `${error.message} ${error.hint}`;
    assert.equal(/did not|was not applied|no change was applied/u.test(said), false, said);
  }
});

/* -------------------------------------------------------------------------- */
/* The response budget                                                        */
/* -------------------------------------------------------------------------- */

const neverAnswers = async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
});

test("an elapsed response budget names the CLI's budget, not the network, and permits retry", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 5,
    fetch: neverAnswers,
  });
  // Every method, including the mutations that used to be told `retryable: false`
  // for an operation the server was still completing.
  for (const request of [
    { method: "GET", path: "/v1/sessions" },
    { method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" },
    { method: "DELETE", path: "/v1/sessions/33333333-3333-4333-8333-333333333333" },
  ]) {
    await assert.rejects(
      transport.request(request),
      (error) => {
        assert.ok(error instanceof CunaError);
        // Literal, not imported: this is the string a consumer branches on.
        assert.equal(error.code, "cuna.client.response_budget_elapsed");
        assert.equal(error.retryable, true);
        assert.equal(error.exitCode, EXIT_CODES.network);
        assert.equal(error.details.budget_ms, 5);
        return true;
      },
    );
  }
});

test("a genuine transport failure keeps its own name and stays fail-closed for mutations", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.network.failed" &&
      error.retryable === false,
  );
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/sessions" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.network.failed" &&
      error.retryable === true,
  );
});

test("caller cancellation is still cancellation and not a budget", async () => {
  const controller = new AbortController();
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 60_000,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      setTimeout(() => controller.abort(new Error("user pressed ctrl-c")), 1);
    }),
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/sessions", signal: controller.signal }),
    (error) => error instanceof CunaError && error.code === "cuna.network.cancelled",
  );
});

/* -------------------------------------------------------------------------- */
/* D1: the machine-create budget                                              */
/* -------------------------------------------------------------------------- */

test("D1: machine creation declares a budget larger than the measured create", () => {
  assert.ok(
    MACHINE_CREATE_REQUEST_BUDGET_MS >= MEASURED_MACHINE_CREATE_MS,
    `${MACHINE_CREATE_REQUEST_BUDGET_MS} ms does not cover the measured ${MEASURED_MACHINE_CREATE_MS} ms create.`,
  );
  assert.ok(
    MACHINE_CREATE_REQUEST_BUDGET_MS >= MEASURED_MACHINE_CREATE_MS * 1.5,
    "The margin over the measured create duration is under 50%.",
  );
  // The documented `--timeout-ms` ceiling. A default a user cannot widen past is
  // not a default, it is a limit.
  assert.ok(MACHINE_CREATE_REQUEST_BUDGET_MS <= 120_000);
});

test("D1: the create budget reaches the transport from a constant, not a call-site literal", async () => {
  const seen = [];
  const client = createCunaApiClient({
    async request(request) {
      seen.push(request);
      return {
        id: MACHINE_ID,
        name: "dev",
        state: "creating",
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
      };
    },
  });
  await client.createMachine({ name: "dev" }, "11111111-1111-4111-8111-111111111111");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/v1/sessions");
  assert.equal(seen[0].budgetMs, MACHINE_CREATE_REQUEST_BUDGET_MS);
  // C2: the operation names the read that settles it.
  assert.equal(seen[0].settleWith, "cuna machines list");

  // Every mutating machine operation, not just the one that was measured. A
  // refusal that says "unknown" and names no read is the dead end C2 forbids.
  seen.length = 0;
  await client.deleteMachine(MACHINE_ID).catch(() => undefined);
  await client.transitionMachine(MACHINE_ID, "stop").catch(() => undefined);
  assert.deepEqual(
    seen.map((request) => [request.method, request.settleWith]),
    [["DELETE", "cuna machines list"], ["POST", "cuna machines list"]],
  );
});

test("without --timeout-ms a create is bounded by its own budget, not by the global default", async (t) => {
  // The mutation this exists to catch is restoring the eager `15_000` default in
  // `cli/run.ts`. That revert is invisible to every test that builds a transport
  // directly, because the eager default only does its damage on the way THROUGH
  // `runCli`: it arrives at the transport indistinguishable from a typed flag and
  // outranks the per-operation budget. Mocked timers let the whole 90 s be
  // observed in microseconds.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams = memoryStreams();
  let settled;
  const run = runCli(["machines", "create", "--name", "dev", "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === "/v1/capabilities") {
        return new Response(JSON.stringify({
          schema_version: "1.0",
          subject_scope: "account",
          observed_at: "2026-08-08T00:00:00.000Z",
          expires_at: CAPABILITY_EXPIRY,
          etag: "fixture",
          capabilities: [{
            id: "machines.create",
            availability: "supported",
            interaction: "native",
            mutation_class: "destructive",
            surfaces: ["cli"],
            required_permissions: ["write"],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  }).then((exit) => { settled = exit; });

  // The create request is dispatched after an awaited capability read, so let the
  // microtask queue drain before the clock is moved.
  await new Promise((resolve) => process.nextTick(resolve));
  await new Promise((resolve) => process.nextTick(resolve));
  t.mock.timers.tick(DEFAULT_REQUEST_BUDGET_MS + 1);
  await new Promise((resolve) => process.nextTick(resolve));
  assert.equal(settled, undefined, "The create was cut off at the global default instead of its own budget.");

  t.mock.timers.tick(MACHINE_CREATE_REQUEST_BUDGET_MS);
  await run;
  assert.equal(settled, EXIT_CODES.network);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.client.response_budget_elapsed");
  assert.equal(error.details.budget_ms, MACHINE_CREATE_REQUEST_BUDGET_MS);
});

test("an explicit --timeout-ms outranks a per-operation budget", async () => {
  const explicit = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 5,
    fetch: neverAnswers,
  });
  await assert.rejects(
    // A budget the operation would never reach inside this test's runtime. If
    // the per-operation value won, this call would hang until the suite timeout.
    explicit.request({ method: "POST", path: "/v1/sessions", budgetMs: 3_600_000 }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.client.response_budget_elapsed" &&
      error.details.budget_ms === 5,
  );

  const declared = createHttpTransport({ baseUrl: "https://api.getcuna.com", fetch: neverAnswers });
  await assert.rejects(
    declared.request({ method: "POST", path: "/v1/sessions", budgetMs: 5 }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.client.response_budget_elapsed" &&
      error.details.budget_ms === 5,
  );
});

/* -------------------------------------------------------------------------- */
/* D2: convergence before judgement                                           */
/* -------------------------------------------------------------------------- */

function deleteClient(machineStates) {
  const remaining = [...machineStates];
  const record = { reads: 0, deletes: 0 };
  return {
    record,
    client: {
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot("machines.delete", scope, resourceId);
      },
      async deleteMachine() { record.deletes += 1; return true; },
      async getMachine(id) {
        record.reads += 1;
        const next = remaining.length > 1 ? remaining.shift() : remaining[0];
        if (next === "absent") {
          throw new CunaError({
            code: "cuna.remote.not_found",
            message: "The requested Cuna resource or operation was not found.",
            exitCode: EXIT_CODES.remote,
          });
        }
        return { id, name: "dev", state: next };
      },
    },
  };
}

test("D2: a delete the producer completes a moment later SUCCEEDS", async () => {
  // The measured scenario: present on the immediate read, gone shortly after.
  const { client, record } = deleteClient(["running", "running", "absent"]);
  const { poller } = fakeConvergencePoller();
  const streams = memoryStreams();
  const exit = await runCli(["machines", "delete", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: poller,
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.equal(record.deletes, 1);
  assert.equal(record.reads, 3, "The CLI judged the postcondition before reading back more than once.");
  assert.equal(JSON.parse(streams.stdout()).data.acknowledged, true);
});

test("D2: a delete that never converges reports the CLI's budget, retryable, naming the read", async () => {
  const { client, record } = deleteClient(["running"]);
  const { poller, record: clock } = fakeConvergencePoller();
  const streams = memoryStreams();
  const exit = await runCli(["machines", "delete", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: poller,
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.network);
  const record_ = JSON.parse(streams.stderr()).error;
  assert.equal(record_.code, "cuna.client.convergence_budget_elapsed");
  assert.equal(record_.retryable, true);
  assert.equal(record_.details.settle_with, "cuna machines list");
  assert.equal(record_.details.observed_state, "running");
  assert.equal(record_.details.remote_outcome, "unobserved");
  assert.equal(clock.elapsed(), 30_000);
  assert.ok(record.reads > 1);
});

test("D2: a lifecycle transition converges before it judges the state", async () => {
  const states = ["running", "running", "paused"];
  let reads = 0;
  const client = {
    async discoverCapabilities(scope, resourceId) {
      return capabilitySnapshot("machines.lifecycle", scope, resourceId);
    },
    async transitionMachine(id) { return { id, name: "dev", state: "pausing" }; },
    async getMachine(id) {
      const next = states[Math.min(reads, states.length - 1)];
      reads += 1;
      return { id, name: "dev", state: next };
    },
  };
  const { poller } = fakeConvergencePoller();
  const streams = memoryStreams();
  const exit = await runCli(["machines", "pause", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: poller,
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.equal(reads, 3);
  assert.equal(JSON.parse(streams.stdout()).data.state, "paused");
});

test("a contradiction that no waiting repairs is still a postcondition failure", async () => {
  // The producer answers about a different machine. This must NOT be reported as
  // the CLI's budget, and must NOT be retried: it is a real contract violation.
  const client = {
    async discoverCapabilities(scope, resourceId) {
      return capabilitySnapshot("machines.lifecycle", scope, resourceId);
    },
    async transitionMachine() {
      return { id: "44444444-4444-4444-8444-444444444444", name: "other", state: "paused" };
    },
    async getMachine(id) { return { id, name: "dev", state: "paused" }; },
  };
  const { poller } = fakeConvergencePoller();
  const streams = memoryStreams();
  const exit = await runCli(["machines", "pause", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: poller,
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.remote.postcondition_unverified");
});
