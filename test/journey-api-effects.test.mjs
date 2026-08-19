import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, CunaError } from "../dist/index.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { machineCreatePrompt } from "../dist/cli/run.js";
import { planMachineSelection } from "../dist/journey/selection.js";

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function recoveredSession(overrides = {}) {
  return {
    id: SESSION_ID,
    machineId: MACHINE_ID,
    name: "claude-code",
    agent: "claude-code",
    cwd: "/workspace/projects/project",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launch_pending",
    processState: "unknown",
    rowVersion: 0,
    workspaceBindingId: BINDING_ID,
    workspaceGeneration: 7,
    ...overrides,
  };
}

function capability() {
  return {
    schemaVersion: "1.0",
    subjectScope: "machine",
    subjectId: MACHINE_ID,
    observedAt: "2026-08-09T12:00:00.000Z",
    expiresAt: "2026-08-09T12:00:30.000Z",
    etag: "agent-create",
    capabilities: [{
      id: "agent_sessions.create",
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["agent_sessions:create"],
    }],
  };
}

function effects(client) {
  return createApiAgentJourneyEffects({
    client,
    async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: () => NOW,
    async sleep() {},
  });
}
test("machine-create authorization carries each planner reason to a distinct prompt", async () => {
  const machine = (overrides = {}) => ({ id: MACHINE_ID, name: "existing", agent: "unknown", requestedAgentSupport: "supported", state: "running", ownership: "owned", freshness: "fresh", recency: "recent", resources: {}, costStatus: "unknown", ...overrides });
  const selectionInput = (machines) => ({ requestedAgent: "claude-code", forceNew: false, collectionFreshness: "fresh", machines });
  const cases = [
    { machines: [], reason: "no-machines" },
    { machines: [machine({ ownership: "foreign" })], reason: "foreign-machines" },
    { machines: [machine({ requestedAgentSupport: "unsupported" })], reason: "unsupported-agent" },
    { machines: [machine({ state: "stopped" })], reason: "stopped-machine" },
    { machines: [machine({ state: "error" })], reason: "no-reusable-machine" },
  ];
  const prompts = [];
  const captured = [];
  const journeyEffects = createApiAgentJourneyEffects({
    client: {
      async discoverCapabilities() { return { schemaVersion: "1.0", subjectScope: "account", observedAt: "2026-08-09T12:00:00.000Z", expiresAt: "2026-08-09T12:00:30.000Z", etag: "machine-create", capabilities: [{ id: "machines.create", availability: "supported", interaction: "native", mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: [] }] }; },
    },
    async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate(authorization) {
      assert.notEqual(authorization.reason, undefined, "planner reason must cross the authorization interface");
      if (authorization.reason === "stopped-machine") assert.equal(authorization.stoppedMachineId, MACHINE_ID);
      captured.push(authorization);
      prompts.push(machineCreatePrompt(authorization));
      return false;
    },
    now: () => NOW,
    async sleep() {},
  });
  for (const expected of cases) {
    const plan = planMachineSelection(selectionInput(expected.machines));
    assert.equal(plan.kind, "create-required");
    assert.equal(plan.reason, expected.reason);
    await assert.rejects(
      journeyEffects.createMachine({
        requestedAgent: "claude-code",
        reason: plan.reason,
        ...(plan.reason === "stopped-machine" ? { stoppedMachineId: plan.stoppedMachineId } : {}),
        idempotencyKey: "machine-create-reason-test",
        requestId: "machine-create-reason-test",
        signal: new AbortController().signal,
      }),
      (error) => error?.code === "cuna.journey.machine_create_not_authorized",
    );
  }
  assert.equal(captured.length, cases.length);
  assert.equal(new Set(prompts).size, cases.length);
  assert.match(prompts.find((prompt) => prompt.includes("cuna machines start")) ?? "", new RegExp(MACHINE_ID, "u"));
});


test("uncertain AgentSession create recovers by the exact original idempotency key", async () => {
  const calls = [];
  const client = {
    async discoverCapabilities() { return capability(); },
    async createAgentSession() {
      calls.push("create");
      throw new CunaError({
        code: "cuna.client.response_budget_elapsed",
        message: "unknown dispatch",
        exitCode: EXIT_CODES.network,
      });
    },
    async inspectAgentSessionCreate(key) {
      calls.push(["inspect", key]);
      return recoveredSession();
    },
  };
  const result = await effects(client).createAgentSession({
    machineId: MACHINE_ID,
    agent: "claude-code",
    authMode: "interactive_login",
    workspace: {
      bindingId: BINDING_ID,
      workspaceIdentity: BINDING_ID,
      generation: 7,
      remoteCwd: "/workspace/projects/project",
    },
    idempotencyKey: "stable-agent-create-key",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { id: SESSION_ID, machineId: MACHINE_ID });
  assert.deepEqual(calls, ["create", ["inspect", "stable-agent-create-key"]]);
});

test("recovered AgentSession with substituted authority is rejected before attach", async () => {
  const client = {
    async discoverCapabilities() { return capability(); },
    async createAgentSession() {
      throw new CunaError({
        code: "cuna.network.failed",
        message: "unknown dispatch",
        exitCode: EXIT_CODES.network,
      });
    },
    async inspectAgentSessionCreate() {
      return recoveredSession({ machineId: "44444444-4444-4444-8444-444444444444" });
    },
  };
  await assert.rejects(
    effects(client).createAgentSession({
      machineId: MACHINE_ID,
      agent: "claude-code",
      authMode: "interactive_login",
      workspace: {
        bindingId: BINDING_ID,
        workspaceIdentity: BINDING_ID,
        generation: 7,
        remoteCwd: "/workspace/projects/project",
      },
      idempotencyKey: "stable-agent-create-key",
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof CunaError &&
      error.code === "cuna.journey.agent_session_create_authority_mismatch",
  );
});
