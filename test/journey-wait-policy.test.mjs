import assert from "node:assert/strict";
import test from "node:test";

import { CunaError, EXIT_CODES } from "../dist/index.js";
import { observationBudgetElapsed } from "../dist/core/observation-budget.js";
import {
  AGENT_SESSION_READY_DEADLINE_MS,
  MACHINE_READY_DEADLINE_MS,
  REISSUE_PAUSE_MS,
  isResponseBudgetElapsed,
  journeyWaitLine,
  readinessBackoffMs,
  readinessBackoffTotalMs,
  reissueIdempotentRead,
  startJourneyDeadline,
} from "../dist/journey/wait-policy.js";

const SESSION = "00b6d65a-c744-4882-aca0-d02267767d2d";

/**
 * A clock this test moves by hand. Every number below is a decision the policy
 * makes about time, so leaving time to the host would make the assertions
 * describe the machine rather than the rule.
 */
function fakeClock(startAt = 1_000_000) {
  let value = startAt;
  return {
    now: () => value,
    advance(milliseconds) { value += milliseconds; },
  };
}

/** The refusal the CLI mints when its own 15 000 ms budget elapses. */
function budgetElapsed() {
  return observationBudgetElapsed({
    kind: "response",
    operation: `GET /v1/agent-sessions/${SESSION}`,
    budgetMs: 15_000,
    settleWith: `cuna agent-sessions get ${SESSION}`,
    details: { method: "GET", path: `/v1/agent-sessions/${SESSION}` },
  });
}

function deadlineFailure(elapsed) {
  return new CunaError({
    code: "cuna.journey.agent_session_ready_timeout",
    message: `Cuna stopped waiting for ${elapsed.waitingFor}.`,
    exitCode: EXIT_CODES.network,
    details: {
      waiting_for: elapsed.waitingFor,
      deadline_ms: elapsed.deadlineMs,
      elapsed_ms: elapsed.elapsedMs,
      read_reissues: elapsed.readReissues,
    },
    // Mirrors the production minters: the budget refusal that ended the wait
    // stays reachable as the cause, so `remote_outcome: unobserved` is not lost.
    ...(elapsed.cause === undefined ? {} : { cause: elapsed.cause }),
  });
}

function harness(options = {}) {
  const clock = options.clock ?? fakeClock();
  const waits = [];
  const sleeps = [];
  return {
    clock,
    waits,
    sleeps,
    deadline: startJourneyDeadline(options.deadlineMs ?? AGENT_SESSION_READY_DEADLINE_MS, clock.now),
    signal: new AbortController().signal,
    onWait: (wait) => waits.push(wait),
    async sleep(milliseconds) { sleeps.push(milliseconds); clock.advance(milliseconds); },
    deadlineFailure,
  };
}

test("the backoff curve is the one the deadlines are derived from", () => {
  // The expression reads `min(2000, 100 * 2 ** min(attempt, 4))` and looks like
  // it climbs to 2 000 ms. The exponent cap means it never does: 1 600 ms is
  // the ceiling. Deriving a deadline from the 2 000 that is written down
  // overstates the old reach by 25%, which is how the first draft of this file
  // got both numbers wrong.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(readinessBackoffMs), [100, 200, 400, 800, 1_600, 1_600, 1_600]);
  assert.equal(readinessBackoffTotalMs(90), 139_100);
  assert.equal(readinessBackoffTotalMs(60), 91_100);
});

test("the declared deadlines cover the reach of the loops they replaced", () => {
  assert.equal(AGENT_SESSION_READY_DEADLINE_MS, 180_000);
  assert.ok(AGENT_SESSION_READY_DEADLINE_MS > readinessBackoffTotalMs(90));
  assert.equal(MACHINE_READY_DEADLINE_MS, 120_000);
  assert.ok(MACHINE_READY_DEADLINE_MS > readinessBackoffTotalMs(60));
  // Room for a re-issue or two inside the same phase, which is the whole point.
  assert.ok(AGENT_SESSION_READY_DEADLINE_MS - readinessBackoffTotalMs(90) >= 15_000);
  // A re-issue must cost far less than the 15 000 ms the failed read spent.
  assert.ok(REISSUE_PAUSE_MS > 0 && REISSUE_PAUSE_MS < 1_000);
});

test("one elapsed response budget is re-issued and the journey does not abort", async () => {
  const h = harness();
  let reads = 0;
  const session = await reissueIdempotentRead({
    waitingFor: "Cuna to answer the AgentSession read",
    read: async () => {
      reads += 1;
      if (reads === 1) { h.clock.advance(15_000); throw budgetElapsed(); }
      return { id: SESSION, processState: "running" };
    },
    deadline: h.deadline,
    signal: h.signal,
    sleep: h.sleep,
    onWait: h.onWait,
    deadlineFailure: h.deadlineFailure,
  });
  assert.equal(reads, 2, "the same idempotent read is re-issued exactly once");
  assert.equal(session.id, SESSION);
  assert.deepEqual(h.sleeps, [REISSUE_PAUSE_MS]);
  assert.equal(h.waits.length, 1);
  assert.equal(h.waits[0].waitingFor, "Cuna to answer the AgentSession read");
  assert.equal(h.waits[0].deadlineMs, AGENT_SESSION_READY_DEADLINE_MS);
  assert.equal(h.waits[0].elapsedMs, 15_000);
});

test("NEGATIVE CONTROL: under the old policy the same first read ends the journey", async () => {
  // The old policy is this one with no journey time left: the first elapsed
  // budget is an abort. Measured 2026-09-22 run `cold1` -- the whole journey
  // exited 5 with `cuna.client.response_budget_elapsed` and
  // `remote_outcome: unobserved` while the AgentSession stayed healthy.
  const h = harness({ deadlineMs: 0 });
  let reads = 0;
  await assert.rejects(
    reissueIdempotentRead({
      waitingFor: "Cuna to answer the AgentSession read",
      read: async () => { reads += 1; throw budgetElapsed(); },
      deadline: h.deadline,
      signal: h.signal,
      sleep: h.sleep,
      onWait: h.onWait,
      deadlineFailure: h.deadlineFailure,
    }),
    (error) => {
      assert.equal(error.code, "cuna.journey.agent_session_ready_timeout");
      assert.equal(error.details.read_reissues, 0);
      assert.equal(error.cause.code, "cuna.client.response_budget_elapsed");
      assert.equal(error.cause.details.remote_outcome, "unobserved");
      return true;
    },
  );
  assert.equal(reads, 1, "no re-issue is attempted once the journey deadline has elapsed");
  assert.deepEqual(h.waits, [], "a journey that is out of time must not claim it is still waiting");
});

test("the deadline stops the re-issue loop and names the last thing waited for", async () => {
  const h = harness({ deadlineMs: 40_000 });
  let reads = 0;
  await assert.rejects(
    reissueIdempotentRead({
      waitingFor: "Cuna to answer the AgentSession read",
      // Each read burns its whole 15 000 ms budget, so the 40 000 ms deadline
      // is reached on the third refusal.
      read: async () => { reads += 1; h.clock.advance(15_000); throw budgetElapsed(); },
      deadline: h.deadline,
      signal: h.signal,
      sleep: h.sleep,
      onWait: h.onWait,
      deadlineFailure: h.deadlineFailure,
    }),
    (error) => {
      assert.equal(error.details.waiting_for, "Cuna to answer the AgentSession read");
      assert.equal(error.details.deadline_ms, 40_000);
      assert.ok(error.details.elapsed_ms >= 40_000);
      assert.equal(error.details.read_reissues, 2);
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(h.waits.length, 2);
});

test("only the CLI's own response budget is re-issued", async () => {
  for (const refusal of [
    new CunaError({ code: "cuna.network.service_unavailable", message: "no", exitCode: EXIT_CODES.network }),
    new CunaError({ code: "cuna.client.convergence_budget_elapsed", message: "no", exitCode: EXIT_CODES.network }),
    new CunaError({ code: "cuna.remote.not_found", message: "no", exitCode: EXIT_CODES.remote }),
    new TypeError("not a CunaError at all"),
  ]) {
    const h = harness();
    let reads = 0;
    await assert.rejects(
      reissueIdempotentRead({
        waitingFor: "Cuna to answer the AgentSession read",
        read: async () => { reads += 1; throw refusal; },
        deadline: h.deadline,
        signal: h.signal,
        sleep: h.sleep,
        onWait: h.onWait,
        deadlineFailure: h.deadlineFailure,
      }),
      (error) => error === refusal,
    );
    assert.equal(reads, 1, `${refusal.code ?? refusal.name} is an answer, not a budget`);
    assert.deepEqual(h.waits, []);
  }
});

test("a cancelled journey is never re-issued against", async () => {
  const controller = new AbortController();
  const h = harness();
  let reads = 0;
  await assert.rejects(
    reissueIdempotentRead({
      waitingFor: "Cuna to answer the AgentSession read",
      read: async () => { reads += 1; controller.abort(); throw budgetElapsed(); },
      deadline: h.deadline,
      signal: controller.signal,
      sleep: h.sleep,
      onWait: h.onWait,
      deadlineFailure: h.deadlineFailure,
    }),
    (error) => error.code === "cuna.client.response_budget_elapsed",
  );
  assert.equal(reads, 1);
});

test("isResponseBudgetElapsed discriminates the two observation budgets", () => {
  assert.equal(isResponseBudgetElapsed(budgetElapsed()), true);
  assert.equal(isResponseBudgetElapsed(observationBudgetElapsed({
    kind: "convergence", operation: "machine deletion", budgetMs: 120_000,
  })), false);
  assert.equal(isResponseBudgetElapsed(undefined), false);
});

test("a dispatched read that outlives the deadline still returns its answer", async () => {
  const h = harness({ deadlineMs: 10_000 });
  // The deadline gates DISPATCH, not completion: discarding an answer that
  // arrived would be worse than being late, and the caller reports the real
  // elapsed figure either way.
  const value = await reissueIdempotentRead({
    waitingFor: "Cuna to answer the AgentSession read",
    read: async () => { h.clock.advance(15_000); return "answered"; },
    deadline: h.deadline,
    signal: h.signal,
    sleep: h.sleep,
    onWait: h.onWait,
    deadlineFailure: h.deadlineFailure,
  });
  assert.equal(value, "answered");
  assert.equal(h.deadline.elapsed(), true);
});

test("the wait renders what it waits for, the elapsed seconds and the deadline", () => {
  assert.equal(
    journeyWaitLine({ waitingFor: "the machine's terminal supervisor to register", elapsedMs: 23_400, deadlineMs: 180_000 }),
    "Still waiting for the machine's terminal supervisor to register · 23s of 180s",
  );
  // Floor, never round: a line claiming 24s at 23.6s claims time that has not
  // passed, on the one number a person uses to judge a stall.
  assert.equal(
    journeyWaitLine({ waitingFor: "the session process to start", elapsedMs: 23_600, deadlineMs: 180_000 }),
    "Still waiting for the session process to start · 23s of 180s",
  );
  assert.equal(
    journeyWaitLine({ waitingFor: "a fresh runtime observation", elapsedMs: 0, deadlineMs: 180_000 }),
    "Still waiting for a fresh runtime observation · 0s of 180s",
  );
  // Overshoot is shown, not hidden: it is exactly the in-flight read the
  // deadline does not cut short.
  assert.equal(
    journeyWaitLine({ waitingFor: "the session to accept a terminal", elapsedMs: 181_200, deadlineMs: 180_000 }),
    "Still waiting for the session to accept a terminal · 181s of 180s",
  );
});

test("a deadline reports elapsed, remaining and dispatch admission from its own clock", () => {
  const clock = fakeClock();
  const deadline = startJourneyDeadline(30_000, clock.now);
  assert.equal(deadline.deadlineMs, 30_000);
  assert.equal(deadline.elapsedMs(), 0);
  assert.equal(deadline.remainingMs(), 30_000);
  assert.equal(deadline.elapsed(), false);
  clock.advance(29_999);
  assert.equal(deadline.elapsed(), false);
  assert.equal(deadline.remainingMs(), 1);
  clock.advance(1);
  assert.equal(deadline.elapsed(), true);
  assert.equal(deadline.remainingMs(), 0);
  assert.throws(() => startJourneyDeadline(-1, clock.now), TypeError);
});
