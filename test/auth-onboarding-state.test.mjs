import assert from "node:assert/strict";
import test from "node:test";

import { deriveOnboardingDecision } from "../dist/index.js";

const now = Date.parse("2026-08-09T00:00:00.000Z");
const fresh = (value) => ({ value, observedAt: "2026-08-08T23:59:00.000Z", expiresAt: "2026-08-09T00:01:00.000Z" });

function readyEvidence() {
  return {
    identity: fresh("active"),
    admission: fresh("admitted"),
    workspace: { ...fresh("assigned"), workspaceId: "123e4567-e89b-12d3-a456-426614174000" },
    cliAuth: fresh("signed_in"),
  };
}

test("only four fresh satisfied authorities admit intent resumption", () => {
  const result = deriveOnboardingDecision(readyEvidence(), now);
  assert.deepEqual(result, {
    status: "ready",
    nextAction: "resume_intent",
    mayResumeIntent: true,
    mayCreateMachineWithoutConfirmation: false,
    reason: "all_authorities_fresh_and_satisfied",
  });
});

test("browser-era partial states never collapse into signed-in readiness", () => {
  const cases = [
    ["identity", fresh("signup_required"), "start_signup"],
    ["identity", fresh("verification_required"), "verify_identity"],
    ["admission", fresh("not_requested"), "join_waitlist"],
    ["admission", fresh("waitlisted"), "wait_for_admission"],
    ["workspace", fresh("required"), "select_workspace"],
    ["cliAuth", fresh("authorizing"), "start_login"],
    ["cliAuth", fresh("reauthentication_required"), "reauthenticate"],
  ];
  for (const [field, value, expected] of cases) {
    const evidence = readyEvidence();
    evidence[field] = value;
    const result = deriveOnboardingDecision(evidence, now);
    assert.equal(result.status, "unfinished", field);
    assert.equal(result.nextAction, expected, field);
    assert.equal(result.mayResumeIntent, false, field);
    assert.equal(result.mayCreateMachineWithoutConfirmation, false, field);
  }
});

test("stale, malformed, and unavailable authorities abstain before mutation", () => {
  for (const mutation of [
    (value) => { value.identity.expiresAt = "2026-08-08T23:00:00.000Z"; },
    (value) => { value.admission.observedAt = "not-a-time"; },
    (value) => { value.workspace = fresh("unavailable"); },
    (value) => { value.identity = fresh("unknown"); },
  ]) {
    const evidence = structuredClone(readyEvidence());
    mutation(evidence);
    const result = deriveOnboardingDecision(evidence, now);
    assert.equal(result.status, "unknown");
    assert.equal(result.nextAction, "retry_status");
    assert.equal(result.mayResumeIntent, false);
  }
});

test("disabled, denied, and suspended states are blocked rather than retry-success", () => {
  for (const [field, value] of [["identity", "disabled"], ["admission", "denied"], ["admission", "suspended"]]) {
    const evidence = readyEvidence();
    evidence[field] = fresh(value);
    const result = deriveOnboardingDecision(evidence, now);
    assert.equal(result.status, "blocked");
    assert.equal(result.nextAction, "contact_support");
  }
});

