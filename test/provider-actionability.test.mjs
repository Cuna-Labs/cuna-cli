import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySessionActionability,
  displaySessionActionability,
  machineProviderAvailability,
  mergeSessionActionabilityObservation,
  providerAuthLabel,
  providerDisplayName,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const MACHINE_ID = "22222222-2222-4222-8222-222222222222";

function machine(overrides = {}) {
  return { id: MACHINE_ID, name: "dev", state: "running", agent: "claude-code", ...overrides };
}

function session(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: MACHINE_ID,
    name: "main",
    agent: "claude-code",
    cwd: "/workspace/project",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    processEpoch: "epoch-1",
    runtimeObservedAt: new Date(NOW - 1_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 1,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

test("provider inventory derives only the declared machine provider and never aliases unknown values to OpenCode", () => {
  assert.deepEqual(machineProviderAvailability(machine()), {
    machineId: MACHINE_ID,
    declaredId: "claude-code",
    agent: "claude-code",
    displayName: "Claude",
    usability: "declared-installed",
    actionable: true,
  });
  assert.deepEqual(machineProviderAvailability(machine({ agent: "future-agent" })), {
    machineId: MACHINE_ID,
    declaredId: "future-agent",
    displayName: "Unknown (future-agent)",
    usability: "declared-installed",
    actionable: false,
    reasonCode: "provider_not_supported_by_cli",
  });
  assert.equal(providerDisplayName("future-agent"), "Unknown (future-agent)");
  assert.equal(providerAuthLabel("claude-code"), "Claude auth");
  assert.equal(providerAuthLabel("codex"), "Codex auth");
  assert.equal(providerAuthLabel("opencode"), "OpenCode auth");
  assert.equal(providerAuthLabel("future-agent"), "Unknown (future-agent) auth");
  assert.equal(machineProviderAvailability(machine({ agent: "openclaw" })).actionable, false);
  assert.equal(machineProviderAvailability(machine({ agent: "openclaw" })).usability, "unavailable");
  assert.deepEqual(machineProviderAvailability(machine({ agent: "opencode" })), {
    machineId: MACHINE_ID,
    declaredId: "opencode",
    agent: "opencode",
    displayName: "OpenCode",
    usability: "declared-installed",
    actionable: true,
  });
});

test("shared actionability policy covers lifecycle, clock, provider, refresh, and auth boundaries", () => {
  const cases = [
    ["live", {}, {}, {}, "attachable", true, "attach"],
    ["starting", { processState: "starting", requestState: "runtime_claimed" }, {}, {}, "starting", false, "wait"],
    ["missing observation", { runtimeObservedAt: undefined }, {}, {}, "stale", false, "refresh"],
    ["expired lease", { runtimeExpiresAt: new Date(NOW).toISOString() }, {}, {}, "stale", false, "refresh"],
    ["future observation", { runtimeObservedAt: new Date(NOW + 5_001).toISOString() }, {}, {}, "stale", false, "refresh"],
    ["failed", { processState: "failed" }, {}, {}, "failed", false, "show-failure"],
    ["terminated", { desiredState: "terminated", processState: "terminated" }, {}, {}, "terminated", false, "none"],
    ["provider mismatch", {}, { agent: "codex" }, {}, "unsupported", false, "none"],
    ["unknown provider", {}, { agent: "future-agent" }, {}, "unsupported", false, "none"],
    ["login", {}, {}, { authState: "login_required" }, "login-required", false, "authenticate"],
  ];
  for (const [name, sessionOverrides, machineOverrides, options, state, canAttach, recovery] of cases) {
    const result = classifySessionActionability({
      session: session(sessionOverrides),
      machine: machine(machineOverrides),
      now: NOW,
      ...options,
    });
    assert.equal(result.baseState, state, name);
    assert.equal(result.refreshStatus, "idle", name);
    assert.equal(result.canAttach, canAttach, name);
    assert.equal(result.recoveryAction, recovery, name);
    assert.equal(typeof result.reasonCode, "string", name);
    assert.equal(result.observationRevision, 1, name);
  }
});

test("pending refresh is an overlay and missing/lower/equal revisions retain the confirmed base state", () => {
  const confirmed = classifySessionActionability({
    session: session(),
    machine: machine(),
    now: NOW,
  });
  for (const candidate of [
    undefined,
    classifySessionActionability({ session: session({ rowVersion: 0, processState: "failed" }), machine: machine(), now: NOW }),
    classifySessionActionability({ session: session({ rowVersion: 1, processState: "failed" }), machine: machine(), now: NOW }),
  ]) {
    const result = mergeSessionActionabilityObservation({ confirmed, candidate, refreshStatus: "pending" });
    assert.equal(result.baseState, "attachable");
    assert.equal(result.refreshStatus, "pending");
    assert.equal(result.recoveryAction, "attach");
    assert.equal(result.observationRevision, 1);
    assert.equal(displaySessionActionability(result), "attachable · checking");
    assert.equal(Object.values(result).includes("checking"), false, "checking must not be stored as a base state");
  }

  const higher = classifySessionActionability({
    session: session({ rowVersion: 2, processState: "failed" }),
    machine: machine(),
    now: NOW,
  });
  const advanced = mergeSessionActionabilityObservation({ confirmed, candidate: higher, refreshStatus: "idle" });
  assert.equal(advanced.baseState, "failed");
  assert.equal(advanced.recoveryAction, "show-failure");
  assert.equal(advanced.observationRevision, 2);
});
