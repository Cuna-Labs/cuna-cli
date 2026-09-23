import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCurrentAgentSessionRuntimeLease,
  isAgentSessionIntendedActive,
  isAgentSessionVisibleInPicker,
  readAgentSessionRuntime,
  readRuntimeWindow,
  wasAgentSessionObservedRunning,
} from "../dist/machines/session-visibility.js";
import { classifySessionActionability } from "../dist/machines/session-actionability.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
test("picker hides ended rows with a leftover running intent and retains unknown live candidates", () => {
  for (const processState of ["exited", "failed", "terminating", "terminated"]) {
    assert.equal(isAgentSessionVisibleInPicker(session({ processState })), false);
  }
  assert.equal(isAgentSessionVisibleInPicker(session({ requestState: "terminal" })), false);
  assert.equal(isAgentSessionVisibleInPicker(session({ requestState: "termination_pending" })), false);
  for (const processState of ["unknown", "starting", "ready", "running"]) {
    assert.equal(isAgentSessionVisibleInPicker(session({ processState })), true);
  }
});
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
    // A row a supervisor really established for this epoch. Stated explicitly
    // because it is a precondition of every "observed" assertion below: the
    // producer publishes this provenance, and a row without it is a different
    // case with its own test at the end of this file.
    processObservation: "observed",
    processEpoch: "33333333-3333-4333-8333-333333333333",
    runtimeObservedAt: new Date(NOW - 30_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 4,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T11:59:30.000Z",
    // Missing at 4fa037a, so every `session({...})` in this file returned the
    // base row and the counterexamples were the subject. `formerIsAgent
    // SessionRunningNow` then answered `true` for the closed-lease control at
    // line 72 and this file was red before any of the work around it. Repaired
    // here rather than worked around: a fixture that ignores its overrides is a
    // test that cannot fail for the reason it names.
    ...overrides,
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

/* --- CS4: a lease is not an observation, and the producer now says which ---
 * `process_observation` was published at producer commit 7cb7e37 for exactly
 * the row the file above reproduces: one whose lease keeps moving while nothing
 * observes the child. Before it, "the lease is open" was the only fact
 * available and a reader had to supply the caution. Now the producer supplies
 * the answer, and the reading must not out-claim it.
 */

test("CS4: a fresh lease alone never renders a fresh process observation", () => {
  const fresh = {
    runtimeObservedAt: new Date(NOW - 5_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
  };
  // POSITIVE CONTROL: with the producer saying a supervisor established it, the
  // very same timestamps do read as an observation. Without this the assertions
  // below would also hold for a build that never says `observed` at all.
  const established = readAgentSessionRuntime(session({ ...fresh, processObservation: "observed" }), NOW);
  assert.equal(established.evidence, "observed_running_lease_current");
  assert.equal(established.processObservation, "observed");
  assert.equal(wasAgentSessionObservedRunning(session({ ...fresh, processObservation: "observed" }), NOW), true);

  for (const [label, row] of [
    // The lease renewal that settled without observing the child.
    ["unproven", session({ ...fresh, processObservation: "unproven" })],
    // No provenance recorded for this epoch.
    ["unknown", session({ ...fresh, processObservation: "unknown" })],
    // A deployment older than the release that began recording it sends no
    // field at all. Absence is the same fact as `unknown`, never `observed`.
    ["absent", session({ ...fresh, processObservation: undefined })],
  ]) {
    const reading = readAgentSessionRuntime(row, NOW);
    assert.equal(reading.evidence, "reported_running_observation_unproven", label);
    assert.equal(reading.processObservation, label === "unproven" ? "unproven" : "unknown", label);
    // The lease is still reported, because it is still true. It is just not an
    // observation, and nothing here may read it as one.
    assert.equal(reading.leaseCurrent, true, label);
    assert.equal(hasCurrentAgentSessionRuntimeLease(row, NOW), true, label);
    assert.equal(wasAgentSessionObservedRunning(row, NOW), false, label);
    assert.doesNotMatch(reading.evidence, /^observed_/u, label);
  }
});

test("CS4: provenance travels on every reading, including the ones that decide nothing", () => {
  for (const state of ["observed", "unproven", "unknown"]) {
    assert.equal(
      readAgentSessionRuntime(session({ processObservation: state, processState: "starting" }), NOW).processObservation,
      state,
    );
    assert.equal(
      readAgentSessionRuntime(session({ processObservation: state, requestState: "termination_pending" }), NOW).processObservation,
      state,
    );
  }
});
