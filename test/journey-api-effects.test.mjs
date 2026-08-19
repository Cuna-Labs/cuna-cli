import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, CunaError } from "../dist/index.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";

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

test("machine readiness exhaustion is a retryable observation-budget outcome", async () => {
  let reads = 0;
  const client = {
    async getMachine(id) {
      reads += 1;
      return { id, name: "dev", state: "creating" };
    },
  };

  await assert.rejects(
    effects(client).ensureMachineReady({
      machineId: MACHINE_ID,
      observedState: "creating",
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof CunaError &&
      error.code === "cuna.client.convergence_budget_elapsed" &&
      error.retryable === true &&
      error.details.budget_ms === 91_100 &&
      error.details.settle_with === "cuna machines list" &&
      error.details.remote_outcome === "unobserved",
  );
  assert.equal(reads, 60);
});

test("AgentSession readiness exhaustion is a retryable observation-budget outcome", async () => {
  let reads = 0;
  const client = {
    async getAgentSession() {
      reads += 1;
      return recoveredSession({ processState: "unknown" });
    },
  };

  await assert.rejects(
    effects(client).ensureAgentSessionReady({
      agentSessionId: SESSION_ID,
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof CunaError &&
      error.code === "cuna.client.convergence_budget_elapsed" &&
      error.retryable === true &&
      error.details.budget_ms === 139_100 &&
      error.details.settle_with === `cuna agent-sessions get ${SESSION_ID}` &&
      error.details.remote_outcome === "unobserved",
  );
  assert.equal(reads, 90);
});
