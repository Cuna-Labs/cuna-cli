import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCurrentAgentSessionRuntimeLease,
  isAgentSessionIntendedActive,
  readAgentSessionRuntime,
  readRuntimeWindow,
  wasAgentSessionObservedRunning,
} from "../dist/machines/session-visibility.js";
import { classifySessionActionability } from "../dist/machines/session-actionability.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const HOUR = 3_600_000;

function session(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    name: "dev",
    agent: "opencode",
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    processEpoch: "33333333-3333-4333-8333-333333333333",
    runtimeObservedAt: new Date(NOW - 30_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 4,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T11:59:30.000Z",
  };
}

/**
 * The predicate this repair replaced, written out verbatim.
 *
 * It is here as the NEGATIVE CONTROL, not as a helper: the counterexample below
 * has to be shown producing the wrong answer from the old rule before the new
 * reading is worth anything. If this copy ever stops answering `true` for a
 * six-hour-old observation under an open lease, the counterexample it is meant
 * to reproduce has changed and the assertions below are no longer about it.
 */
function formerIsAgentSessionRunningNow(value, now) {
  const MAX_FUTURE_SKEW_MS = 5_000;
  if (!isAgentSessionIntendedActive(value) || value.processState !== "running") return false;
  if (value.runtimeObservedAt === undefined || value.runtimeExpiresAt === undefined) return false;
  const observedAt = Date.parse(value.runtimeObservedAt);
  const expiresAt = Date.parse(value.runtimeExpiresAt);
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt) &&
    observedAt <= now + MAX_FUTURE_SKEW_MS &&
    expiresAt > observedAt &&
    expiresAt > now;
}

/** A lease renewed with no fresh observation: old `observed_at`, future `expires_at`. */
const leaseRenewedWithoutObservation = session({
  runtimeObservedAt: new Date(NOW - 6 * HOUR).toISOString(),
  runtimeExpiresAt: new Date(NOW + 15_000).toISOString(),
});

test("REPRODUCTION: the former predicate calls a six-hour-old observation running now", () => {
  assert.equal(formerIsAgentSessionRunningNow(leaseRenewedWithoutObservation, NOW), true);
  // The control can fail: with the lease closed, the same row answers false, so
  // the `true` above is the lease speaking and not a predicate stuck on.
  assert.equal(
    formerIsAgentSessionRunningNow(
      session({
        runtimeObservedAt: new Date(NOW - 6 * HOUR).toISOString(),
        runtimeExpiresAt: new Date(NOW - 15_000).toISOString(),
      }),
      NOW,
    ),
    false,
  );
});

test("the reading separates what was observed from what the lease covers", () => {
  const reading = readAgentSessionRuntime(leaseRenewedWithoutObservation, NOW);
  assert.equal(reading.evidence, "observed_running_lease_current");
  assert.equal(reading.leaseCurrent, true);
  assert.equal(reading.lastObservedAt, leaseRenewedWithoutObservation.runtimeObservedAt);
  assert.equal(reading.observationAgeMs, 6 * HOUR);
  // The two facts are answerable apart, which is the whole repair: a caller can
  // say "last seen six hours ago, lease open" instead of "running".
  assert.equal(hasCurrentAgentSessionRuntimeLease(leaseRenewedWithoutObservation, NOW), true);
  assert.equal(wasAgentSessionObservedRunning(leaseRenewedWithoutObservation, NOW), true);
  // And no vocabulary anywhere in the reading asserts the present tense.
  assert.doesNotMatch(reading.evidence, /_now$|^running$/u);
});

test("no freshness threshold is invented: age is reported, never judged", () => {
  const ages = [0, HOUR, 6 * HOUR, 240 * HOUR];
  for (const age of ages) {
    const reading = readAgentSessionRuntime(
      session({
        runtimeObservedAt: new Date(NOW - age).toISOString(),
        runtimeExpiresAt: new Date(NOW + 15_000).toISOString(),
      }),
      NOW,
    );
    assert.equal(reading.observationAgeMs, age, `age ${age}`);
    // Identical evidence at every age. A threshold here would be a liveness
    // claim this build has no producer contract for.
    assert.equal(reading.evidence, "observed_running_lease_current", `age ${age}`);
    assert.equal(reading.leaseCurrent, true, `age ${age}`);
  }
});

test("a lapsed lease keeps the observation and stops claiming the window", () => {
  const lapsed = session({
    runtimeObservedAt: new Date(NOW - 90_000).toISOString(),
    runtimeExpiresAt: new Date(NOW - 1).toISOString(),
  });
  const reading = readAgentSessionRuntime(lapsed, NOW);
  assert.equal(reading.evidence, "observed_running_lease_expired");
  assert.equal(reading.leaseCurrent, false);
  assert.equal(reading.observationAgeMs, 90_000);
  assert.equal(wasAgentSessionObservedRunning(lapsed, NOW), true);
  assert.equal(hasCurrentAgentSessionRuntimeLease(lapsed, NOW), false);
});

test("intent, reported state and unusable timestamps stay distinguishable", () => {
  assert.equal(
    readAgentSessionRuntime(session({ requestState: "termination_pending" }), NOW).evidence,
    "not_intended_active",
  );
  assert.equal(readAgentSessionRuntime(session({ processState: "starting" }), NOW).evidence, "not_reported_running");
  assert.equal(readAgentSessionRuntime(session({ runtimeObservedAt: undefined }), NOW).evidence, "evidence_missing");
  assert.equal(readAgentSessionRuntime(session({ runtimeObservedAt: "whenever" }), NOW).evidence, "evidence_invalid");
  // An observation from the future beyond the accepted skew is not evidence.
  assert.equal(
    readAgentSessionRuntime(session({ runtimeObservedAt: new Date(NOW + 60_000).toISOString() }), NOW).evidence,
    "evidence_invalid",
  );
  assert.equal(readRuntimeWindow(session({ runtimeExpiresAt: undefined }), NOW).kind, "missing");
});

test("actionability names the lease it tests and carries both timestamps", () => {
  const machine = { id: "22222222-2222-4222-8222-222222222222", agent: "opencode", state: "running" };
  const current = classifySessionActionability({ session: leaseRenewedWithoutObservation, machine, now: NOW });
  assert.equal(current.baseState, "attachable");
  // The name says lease, because the lease is what was tested. It used to say
  // `runtime_evidence_current`, which a reader takes as "recently observed".
  assert.equal(current.reasonCode, "runtime_lease_current");
  assert.equal(current.lastObservedAt, leaseRenewedWithoutObservation.runtimeObservedAt);
  assert.equal(current.observationAgeMs, 6 * HOUR);
  assert.equal(current.leaseExpiresAt, leaseRenewedWithoutObservation.runtimeExpiresAt);
  // Attach admission is unchanged: the server's capability snapshot and terminal
  // grant remain the authority, and no age narrowed this.
  assert.equal(current.canAttach, true);
  assert.equal(current.recoveryAction, "attach");

  const lapsed = classifySessionActionability({
    session: session({
      runtimeObservedAt: new Date(NOW - 90_000).toISOString(),
      runtimeExpiresAt: new Date(NOW - 1).toISOString(),
    }),
    machine,
    now: NOW,
  });
  assert.equal(lapsed.baseState, "stale");
  assert.equal(lapsed.reasonCode, "runtime_lease_expired");
  // A stale row is exactly where "when was it last seen" is the question.
  assert.equal(lapsed.observationAgeMs, 90_000);
});
