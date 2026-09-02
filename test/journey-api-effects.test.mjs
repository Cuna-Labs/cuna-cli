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

function effects(client, requestedAgent = "claude-code") {
  return createApiAgentJourneyEffects({
    client,
    requestedAgent,
    async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: () => NOW,
    async sleep() {},
  });
}

test("machine observation rejects a provider mismatch before capability discovery", async () => {
  let capabilityReads = 0;
  const observed = await createApiAgentJourneyEffects({
    client: {
      async listMachines() {
        return { items: [{ id: MACHINE_ID, name: "claude-only", state: "running", agent: "claude-code" }] };
      },
      async discoverCapabilities() { capabilityReads += 1; return capability(); },
    },
    requestedAgent: "codex",
    async inspectWorkspace() { throw new Error("unused"); },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: () => NOW,
  }).observeMachines({ signal: new AbortController().signal });
  assert.equal(capabilityReads, 0);
  assert.equal(observed[0].requestedAgentSupport, "unsupported");
  assert.equal(observed[0].agent, "claude-code");
});

test("OpenCode machine observation preserves a supervisor-repair blocker without inventing a provider", async () => {
  const unavailable = capability();
  unavailable.capabilities = [{
    ...unavailable.capabilities[0],
    availability: "unsupported",
    reasonCode: "opencode_supervisor_upgrade_required",
  }];
  const observed = await createApiAgentJourneyEffects({
    client: {
      async listMachines() {
        return { items: [{ id: MACHINE_ID, name: "open-repair", state: "running", agent: "opencode" }] };
      },
      async discoverCapabilities() { return unavailable; },
    },
    requestedAgent: "opencode",
    async inspectWorkspace() { throw new Error("unused"); },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: () => NOW,
  }).observeMachines({ signal: new AbortController().signal });

  assert.deepEqual(observed[0], {
    id: MACHINE_ID,
    name: "open-repair",
    agent: "opencode",
    requestedAgentSupport: "unsupported",
    requestedAgentBlocker: "opencode-supervisor-update-required",
    state: "running",
    ownership: "owned",
    freshness: "fresh",
    recency: "unknown",
    resources: {},
    costStatus: "unknown",
  });
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

test("OpenCode supervisor capability rejection happens before any create dispatch", async () => {
  let creates = 0;
  const unavailable = capability();
  unavailable.capabilities = [{
    ...unavailable.capabilities[0],
    availability: "unsupported",
    reasonCode: "opencode_supervisor_upgrade_required",
  }];
  const client = {
    async discoverCapabilities() { return unavailable; },
    async createAgentSession() { creates += 1; throw new Error("unreachable"); },
  };
  await assert.rejects(
    effects(client, "opencode").createAgentSession({
      machineId: MACHINE_ID,
      agent: "opencode",
      authMode: "interactive_login",
      workspace: {
        bindingId: BINDING_ID,
        workspaceIdentity: BINDING_ID,
        generation: 7,
        remoteCwd: "/workspace/projects/project",
      },
      idempotencyKey: "opencode-supervisor-upgrade",
      signal: new AbortController().signal,
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.opencode_supervisor_upgrade_required" &&
      error.details?.reason === "opencode_supervisor_upgrade_required" &&
      /No OpenCode AgentSession was created/u.test(error.hint ?? ""),
  );
  assert.equal(creates, 0);
});

test("OpenCode runtime verification remains a transient no-create result", async () => {
  let creates = 0;
  const unavailable = capability();
  unavailable.capabilities = [{
    ...unavailable.capabilities[0],
    availability: "temporarily_unavailable",
    reasonCode: "opencode_runtime_unverified",
  }];
  const client = {
    async discoverCapabilities() { return unavailable; },
    async createAgentSession() { creates += 1; throw new Error("unreachable"); },
  };
  await assert.rejects(
    effects(client, "opencode").createAgentSession({
      machineId: MACHINE_ID,
      agent: "opencode",
      authMode: "interactive_login",
      workspace: {
        bindingId: BINDING_ID,
        workspaceIdentity: BINDING_ID,
        generation: 7,
        remoteCwd: "/workspace/projects/project",
      },
      idempotencyKey: "opencode-runtime-unverified",
      signal: new AbortController().signal,
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.opencode_runtime_unverified" &&
      error.retryable === true &&
      /No OpenCode AgentSession was created/u.test(error.hint ?? "") &&
      /will not create another Machine/u.test(error.hint ?? ""),
  );
  assert.equal(creates, 0);
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

const OWN_CLIENT = "cli:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLIENT = "cli:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seat(overrides = {}) {
  return {
    agentSessionId: SESSION_ID,
    processEpoch: "33333333-3333-4333-8333-333333333333",
    state: "available",
    unavailableReason: null,
    writerEpoch: 1,
    writerClientInstanceId: null,
    observedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function seatEffects(seatResult, clientInstanceId = OWN_CLIENT, session = recoveredSession({ processState: "running" })) {
  const seatReads = [];
  const value = createApiAgentJourneyEffects({
    client: {
      async listAgentSessions() { return { items: [session] }; },
      async getAgentSessionTerminalSeat(id) {
        seatReads.push(id);
        if (seatResult instanceof Error) throw seatResult;
        return seatResult;
      },
    },
    requestedAgent: "claude-code",
    // `null` means "this caller has no client instance id"; `undefined` would
    // only select the parameter default.
    ...(clientInstanceId === null ? {} : { clientInstanceId }),
    async inspectWorkspace() { throw new Error("unused"); },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: () => NOW,
  });
  return { effects: value, seatReads };
}

test("session observation maps the durable writer seat onto attachment", async () => {
  const signal = new AbortController().signal;
  for (const [label, seatResult, ownId, expected] of [
    ["available, nobody holds it", seat(), OWN_CLIENT, { attachment: "detached" }],
    ["available, another client holds it", seat({ writerClientInstanceId: OTHER_CLIENT }), OWN_CLIENT,
      { attachment: "attached", attachmentHolder: OTHER_CLIENT }],
    ["available, this client holds it", seat({ writerClientInstanceId: OWN_CLIENT }), OWN_CLIENT, { attachment: "detached" }],
    ["available, held, and we have no own id", seat({ writerClientInstanceId: OWN_CLIENT }), null,
      { attachment: "attached", attachmentHolder: OWN_CLIENT }],
    ["owner_unrecoverable", seat({ state: "owner_unrecoverable", unavailableReason: "master_not_attested" }), OWN_CLIENT,
      { attachment: "unknown" }],
    ["none", seat({ state: "none", processEpoch: null, writerEpoch: 0 }), OWN_CLIENT, { attachment: "unknown" }],
  ]) {
    const { effects: fx, seatReads } = seatEffects(seatResult, ownId);
    const [observed] = await fx.observeAgentSessions({ machineId: MACHINE_ID, signal });
    assert.deepEqual(seatReads, [SESSION_ID], label);
    assert.equal(observed.attachment, expected.attachment, label);
    assert.equal(observed.attachmentHolder, expected.attachmentHolder, label);
    assert.equal(Object.hasOwn(observed, "attachmentHolder"), expected.attachmentHolder !== undefined, label);
  }
});

test("an edge that does not serve the seat route leaves attachment unknown; any other failure propagates", async () => {
  const signal = new AbortController().signal;
  for (const code of ["cuna.remote.operation_not_served", "cuna.remote.not_found"]) {
    const { effects: fx } = seatEffects(new CunaError({ code, message: "absent", exitCode: EXIT_CODES.remote }));
    const [observed] = await fx.observeAgentSessions({ machineId: MACHINE_ID, signal });
    assert.equal(observed.attachment, "unknown", code);
    assert.equal(observed.attachmentHolder, undefined, code);
  }
  for (const failure of [
    new CunaError({ code: "cuna.remote.malformed_response", message: "off contract", exitCode: EXIT_CODES.remote }),
    new CunaError({ code: "cuna.auth.rejected", message: "refused", exitCode: EXIT_CODES.auth }),
    new CunaError({ code: "cuna.network.failed", message: "down", exitCode: EXIT_CODES.network }),
  ]) {
    const { effects: fx } = seatEffects(failure);
    await assert.rejects(
      fx.observeAgentSessions({ machineId: MACHINE_ID, signal }),
      (error) => error === failure,
      failure.code,
    );
  }
});

test("only a live session is asked for its seat", async () => {
  const signal = new AbortController().signal;
  for (const processState of ["unknown", "starting", "exited", "failed", "terminating", "terminated"]) {
    const { effects: fx, seatReads } = seatEffects(seat(), OWN_CLIENT, recoveredSession({ processState }));
    const [observed] = await fx.observeAgentSessions({ machineId: MACHINE_ID, signal });
    assert.deepEqual(seatReads, [], processState);
    assert.equal(observed.attachment, "unknown", processState);
  }
  for (const processState of ["ready", "running"]) {
    const { effects: fx, seatReads } = seatEffects(seat(), OWN_CLIENT, recoveredSession({ processState }));
    const [observed] = await fx.observeAgentSessions({ machineId: MACHINE_ID, signal });
    assert.deepEqual(seatReads, [SESSION_ID], processState);
    assert.equal(observed.attachment, "detached", processState);
  }
});
