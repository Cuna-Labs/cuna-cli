import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { orchestrateAgentJourney } from "../dist/journey/orchestrator.js";

const MACHINE = "10000000-0000-4000-8000-000000000001";
const MACHINE_2 = "10000000-0000-4000-8000-000000000002";
const BINDING = "20000000-0000-4000-8000-000000000001";
const SESSION = "30000000-0000-4000-8000-000000000001";
// The account authority the machine-create request identity is derived from.
const SCOPE = Object.freeze({
  userId: "40000000-0000-4000-8000-000000000001",
  workspaceId: "50000000-0000-4000-8000-000000000001",
});

function intent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    command: "claude",
    agent: "claude-code",
    target: "reconcile",
    machine: { kind: "automatic" },
    localPath: "C:\\work",
    syncMode: "enabled",
    newSession: false,
    ...overrides,
  };
}

function machine(overrides = {}) {
  return {
    id: MACHINE,
    name: "work",
    agent: "codex",
    requestedAgentSupport: "supported",
    state: "running",
    ownership: "owned",
    freshness: "fresh",
    recency: "recent",
    resources: { vcpus: 2, memoryMiB: 2048 },
    costStatus: "known",
    ...overrides,
  };
}

function effects(overrides = {}) {
  const calls = [];
  const value = {
    calls,
    async inspectWorkspace() { calls.push("inspect-workspace"); return { canonicalLocalRoot: "C:\\work" }; },
    async observeMachines() { calls.push("observe-machines"); return [machine()]; },
    async createMachine(input) { calls.push(["create-machine", input]); return { id: MACHINE, state: "creating" }; },
    async reconcileMachineCreate(input) { calls.push(["reconcile-create", input]); return { id: MACHINE, state: "creating" }; },
    async ensureMachineReady(input) { calls.push(["ready-machine", input]); return { id: input.machineId, state: "running" }; },
    async synchronizeWorkspace(input) {
      calls.push(["sync", input]);
      return { bindingId: BINDING, workspaceIdentity: BINDING, generation: 4, remoteCwd: "/workspace/projects/project" };
    },
    async observeAgentSessions(input) { calls.push(["observe-sessions", input]); return []; },
    async createAgentSession(input) { calls.push(["create-session", input]); return { id: SESSION, machineId: input.machineId }; },
    async ensureAgentSessionReady(input) { calls.push(["ready-session", input]); return { id: input.agentSessionId, machineId: MACHINE }; },
    async attach(input) { calls.push(["attach", input]); },
    async reconcileCancellation(input) { calls.push(["cancel-reconcile", input]); },
    ...overrides,
  };
  return value;
}

test("automatic journey composes selection, sync, AgentSession creation and exact attach", async () => {
  const fx = effects();
  const result = await orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE, idempotencyKey: "cuna-journey-test-0001" });
  assert.deepEqual(result, {
    machineId: MACHINE,
    agentSessionId: SESSION,
    workspaceBindingId: BINDING,
    workspaceGeneration: 4,
  });
  assert.deepEqual(fx.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "inspect-workspace", "observe-machines", "ready-machine", "sync", "observe-sessions", "create-session", "ready-session", "attach",
  ]);
  assert.equal(fx.calls.find((call) => Array.isArray(call) && call[0] === "create-session")[1].machineId, MACHINE);
});

test("explicit relative workspace paths are resolved before workspace inspection", async () => {
  let observedLocalPath;
  const fx = effects({
    async inspectWorkspace(input) {
      fx.calls.push("inspect-workspace");
      observedLocalPath = input.localPath;
      return { canonicalLocalRoot: resolve("project") };
    },
  });
  await orchestrateAgentJourney({
    intent: intent({ localPath: "project" }),
    effects: fx,
    scope: SCOPE,
    idempotencyKey: "cuna-journey-relative-path",
  });
  assert.equal(observedLocalPath, resolve("project"));
});

test("ambiguous machine authority performs no mutation", async () => {
  const fx = effects({
    async observeMachines() { fx.calls.push("observe-machines"); return [machine(), machine({ id: MACHINE_2, name: "other" })]; },
  });
  await assert.rejects(
    orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE }),
    (error) => error.code === "cuna.journey.ambiguous" && error.details.candidates.length === 2,
  );
  assert.deepEqual(fx.calls, ["inspect-workspace", "observe-machines"]);
});

test("unknown create outcome reconciles with the exact caller-known request ID", async () => {
  let createRequestId;
  let reconciledRequestId;
  const fx = effects({
    async observeMachines() { fx.calls.push("observe-machines"); return []; },
    async createMachine(input) { createRequestId = input.requestId; throw new Error("lost 201"); },
    async reconcileMachineCreate(input) {
      reconciledRequestId = input.requestId;
      fx.calls.push("reconciled");
      return { id: MACHINE, state: "creating" };
    },
  });
  await orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE });
  assert.match(createRequestId, /^[0-9a-f-]{36}$/u);
  assert.equal(reconciledRequestId, createRequestId);
  assert.equal(fx.calls.filter((call) => call === "reconciled").length, 1);
});

test("unreconcilable create outcome fails closed without duplicate creation", async () => {
  let creates = 0;
  const fx = effects({
    async observeMachines() { return []; },
    async createMachine() { creates += 1; throw new Error("lost response"); },
    async reconcileMachineCreate() { return "unreconcilable"; },
  });
  await assert.rejects(
    orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE }),
    (error) => error.code === "cuna.journey.machine_create_outcome_unreconcilable" && error.retryable === false,
  );
  assert.equal(creates, 1);
});

test("exhausted AgentSession create recovery fails closed before attach", async () => {
  let creates = 0;
  let attaches = 0;
  const fx = effects({
    async createAgentSession() { creates += 1; throw new Error("response lost"); },
    async attach() { attaches += 1; },
  });
  await assert.rejects(
    orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE }),
    (error) => error.code === "cuna.journey.agent_session_create_outcome_unreconcilable" &&
      error.details.recovery === "exhausted",
  );
  assert.equal(creates, 1);
  assert.equal(attaches, 0);
});

test("cancellation at every effect boundary stops downstream work and reconciles one ledger", async () => {
  const phases = [
    "inspect-workspace", "observe-machines", "ready-machine", "synchronize-workspace", "observe-agent-sessions",
    "create-agent-session", "ready-agent-session", "attach",
  ];
  for (const phase of phases) {
    const controller = new AbortController();
    let reconciliations = 0;
    const reached = [];
    const fx = effects({
      onPhase(current) {
        reached.push(current);
        if (current === phase) controller.abort(new Error("test cancellation"));
      },
      async reconcileCancellation({ ledger }) {
        reconciliations += 1;
        assert.equal(ledger.idempotencyKey.startsWith("cuna-journey-"), true);
      },
    });
    await assert.rejects(
      orchestrateAgentJourney({ intent: intent(), effects: fx, scope: SCOPE, signal: controller.signal }),
      (error) => error.code === "cuna.journey.cancelled",
    );
    assert.equal(reconciliations, 1, phase);
    assert.equal(reached.at(-1), phase);
  }
});
