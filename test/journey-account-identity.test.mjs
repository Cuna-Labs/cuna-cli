import assert from "node:assert/strict";
import test from "node:test";

import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
import { memoryStreams, runCli } from "../dist/index.js";
import { DEFAULT_REQUEST_BUDGET_MS, observationBudgetElapsed } from "../dist/core/observation-budget.js";
import {
  ACCOUNT_IDENTITY_WAITING_FOR,
  readAccountIdentityWithin,
} from "../dist/journey/account-identity.js";
import { ACCOUNT_IDENTITY_DEADLINE_MS, REISSUE_PAUSE_MS } from "../dist/journey/wait-policy.js";

/**
 * The first read of the journey, `GET /v1/me`, held to the same promise as the
 * rest of it: one slow read does not end the command.
 *
 * WHY THIS FILE EXISTS. The re-issue policy shipped in
 * `journey/api-effects.ts` and `journey/remote-workspace.ts`, and this read runs
 * in neither — `cli/run.ts` makes it before it chooses which effects to build.
 * Measured 2026-09-22 with that policy already live
 * (`prds/cuna-cli-latency-before-20260922.md` § 8.3): run `a5` exited 5 at
 * 21 454 ms and the deliberate `--timeout-ms 800` control `slow1` exited 5 at
 * 5 147 ms, both `cuna.client.response_budget_elapsed` on `GET /v1/me`.
 *
 * The clock below advances only inside the fake sleep and inside a read that
 * this test says burned its budget, so every elapsed figure reported is one the
 * test decided and no policy can pass here by being fast.
 */

const IDENTITY = Object.freeze({
  id: "40000000-0000-4000-8000-000000000001",
  email: "someone@example.com",
  workspaceAssigned: true,
  workspaceId: "50000000-0000-4000-8000-000000000001",
});

function budgetElapsed(budgetMs = DEFAULT_REQUEST_BUDGET_MS) {
  return observationBudgetElapsed({
    kind: "response",
    operation: "GET /v1/me",
    budgetMs,
    details: { method: "GET", path: "/v1/me" },
  });
}

/**
 * One account read under the policy, with a hand-driven clock.
 *
 * `plan` is consulted once per dispatch: a number is how many milliseconds that
 * attempt burned before refusing with a response-budget error, and `"answer"`
 * returns the identity.
 */
function attempt(plan, options = {}) {
  let clock = Date.parse("2026-09-22T15:27:10.557Z");
  const waits = [];
  let reads = 0;
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  const promise = readAccountIdentityWithin({
    read: async () => {
      const step = plan[Math.min(reads, plan.length - 1)];
      reads += 1;
      if (step === "answer") return IDENTITY;
      if (step instanceof Error) throw step;
      clock += step;
      throw budgetElapsed(options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS);
    },
    signal: controller.signal,
    sleep: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
    onWait: (wait) => waits.push(wait),
  });
  return { promise, waits, reads: () => reads };
}

test("the deadline is three request budgets, and it is derived rather than chosen", () => {
  // The constant's own derivation, executable: the read may burn its whole
  // budget twice and still be dispatched a third time. The test below shows
  // that is exactly what happens.
  assert.equal(ACCOUNT_IDENTITY_DEADLINE_MS, 3 * DEFAULT_REQUEST_BUDGET_MS);
  assert.equal(ACCOUNT_IDENTITY_DEADLINE_MS, 45_000);
});

test("a slow account read is re-issued and the journey gets its identity", async () => {
  const run = attempt([DEFAULT_REQUEST_BUDGET_MS, "answer"]);
  assert.deepEqual(await run.promise, IDENTITY);
  assert.equal(run.reads(), 2, "the same idempotent read is asked again");
  assert.deepEqual(run.waits, [{
    waitingFor: ACCOUNT_IDENTITY_WAITING_FOR,
    elapsedMs: DEFAULT_REQUEST_BUDGET_MS,
    deadlineMs: ACCOUNT_IDENTITY_DEADLINE_MS,
  }]);
  // The row says what it waits for and against which bound, not just that it is
  // waiting: `Still waiting for your account · 15s of 45s`.
  assert.equal(run.waits[0].waitingFor, "your account");
});

test("NEGATIVE CONTROL: the same slow read still ends the command once the deadline elapses", async () => {
  // The behaviour being repaired, reproduced by removing the only thing that
  // changed — time left. Every dispatch burns the whole budget, so the third
  // one finds no time and the command ends exactly as run `a5` did.
  const run = attempt([DEFAULT_REQUEST_BUDGET_MS]);
  await assert.rejects(run.promise, (error) => {
    assert.ok(error instanceof CunaError);
    assert.equal(error.code, "cuna.client.response_budget_elapsed");
    assert.equal(error.exitCode, EXIT_CODES.network);
    assert.equal(error.retryable, true);
    assert.equal(error.details.remote_outcome, "unobserved");
    assert.equal(error.details.waiting_for, ACCOUNT_IDENTITY_WAITING_FOR);
    // 45 000 of budget plus the two 250 ms re-issue pauses that separated the
    // three dispatches. `elapsed_ms` is what actually passed, not the bound:
    // clamping it to the deadline would hide the overshoot
    // `startJourneyDeadline` documents, on the one number a reader uses to
    // judge how long they waited.
    assert.equal(error.details.elapsed_ms, ACCOUNT_IDENTITY_DEADLINE_MS + 2 * REISSUE_PAUSE_MS);
    assert.equal(error.details.elapsed_ms, 45_500);
    assert.equal(error.details.budget_ms, ACCOUNT_IDENTITY_DEADLINE_MS);
    assert.equal(error.details.read_reissues, 2);
    // The refusal names the read-only command that settles it, so a person is
    // never left with an unknown and no next step.
    assert.equal(error.details.settle_with, "cuna whoami");
    return true;
  });
  assert.equal(run.reads(), 3, "two refusals absorbed, a third dispatch, then out of time");
  assert.deepEqual(run.waits.map((wait) => wait.elapsedMs), [15_000, 30_250]);
});

test("slow1 reproduced: a lowered --timeout-ms no longer ends the command", async () => {
  // `prds/cuna-cli-latency-before-20260922.md` § 8.3, run `slow1`: exit 5 at
  // 5 147 ms with `budget_ms: 800`. A lowered per-request budget says how long
  // to believe ONE connection; it is not a statement about how long the account
  // read is worth, so the same journey now survives two of them.
  const run = attempt([800, 800, "answer"], { budgetMs: 800 });
  assert.deepEqual(await run.promise, IDENTITY);
  assert.equal(run.reads(), 3);
  assert.deepEqual(run.waits.map((wait) => wait.elapsedMs), [800, 1_850]);
  // 800 + 250 (REISSUE_PAUSE_MS) + 800 = 1 850 ms, all of it inside 45 000.
  for (const wait of run.waits) assert.ok(wait.elapsedMs < wait.deadlineMs);
});

test("a refusal Cuna actually sent is an answer, and is never asked again", async () => {
  const refusal = new CunaError({
    code: "cuna.auth.required",
    message: "This account is not signed in.",
    exitCode: EXIT_CODES.auth,
  });
  const run = attempt([refusal]);
  await assert.rejects(run.promise, (error) => {
    assert.equal(error.code, "cuna.auth.required");
    return true;
  });
  assert.equal(run.reads(), 1, "only the CLI's own budget is re-issuable");
  assert.deepEqual(run.waits, [], "nothing was waited for, so nothing is claimed on screen");
});

/* -------------------------------------------------------------------------- */
/* Through the command, at the call site the measurement failed on             */
/* -------------------------------------------------------------------------- */

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

/**
 * Run `cuna claude` far enough to pass the account read.
 *
 * `plan` is consulted per dispatch exactly as above. The clock is the test's,
 * so the deadline is reached by arithmetic rather than by waiting; only the
 * 250 ms re-issue pauses are real, because `cli/run.ts` sleeps on the wall
 * clock in production and this test drives the production path.
 */
async function command(plan) {
  const streams = memoryStreams({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true });
  let clock = Date.parse("2026-09-22T15:27:10.557Z");
  let reads = 0;
  const exit = await runCli(["claude", "/work/project", "--machine", "harness"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    now: () => clock,
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async getIdentity() {
        const step = plan[Math.min(reads, plan.length - 1)];
        reads += 1;
        if (step === "answer") return IDENTITY;
        clock += step;
        throw budgetElapsed();
      },
    }),
  });
  return { exit, reads, stderr: streams.stderr() };
}

test("the command survives a slow account read and says what it is waiting for", async () => {
  const run = await command([DEFAULT_REQUEST_BUDGET_MS, "answer"]);
  assert.equal(run.reads, 2, "the wiring in cli/run.ts, not just the policy module");
  // Past the account read: the next refusal is the injected-client harness
  // reaching the branch that needs real workspace transport, which is several
  // steps beyond where runs `a5` and `slow1` ended.
  assert.match(run.stderr, /cuna\.journey\.workspace_transport_unavailable/u);
  assert.match(run.stderr, /Still waiting for your account · 15s of 45s/u);
  // Once the account answers, the row gives the wait back to the phase it stood
  // in for. Without that, it keeps counting a wait that is already over until
  // some later step happens to repaint it.
  const lastWait = run.stderr.lastIndexOf("Still waiting for your account");
  assert.ok(run.stderr.indexOf("Connecting to Claude Code", lastWait) > lastWait);
});

test("NEGATIVE CONTROL: the command still ends when the account read never answers", async () => {
  const run = await command([DEFAULT_REQUEST_BUDGET_MS]);
  assert.equal(run.reads, 3);
  assert.equal(run.exit, EXIT_CODES.network);
  assert.match(run.stderr, /cuna\.client\.response_budget_elapsed/u);
  assert.match(run.stderr, /Run `cuna whoami` to see the current state\./u);
});

test("a cancelled command outranks the deadline", async () => {
  // Ctrl-C is an answer from the person at the keyboard, and re-issuing against
  // it would ignore them.
  const run = attempt([DEFAULT_REQUEST_BUDGET_MS], { aborted: true });
  await assert.rejects(run.promise, (error) => {
    assert.equal(error.code, "cuna.client.response_budget_elapsed");
    return true;
  });
  assert.equal(run.reads(), 1);
  assert.deepEqual(run.waits, []);
});
