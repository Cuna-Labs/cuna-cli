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

/* -------------------------------------------------------------------------- */
/* AgentSession readiness: the error named the wrong subsystem                 */
/*                                                                            */
/* `cuna.journey.agent_session_ready_timeout` collapsed at least four causes   */
/* and exited with EXIT_CODES.network, on a run where the network answered     */
/* ninety times. It is the error that blocked completion conditions 6 and 7,   */
/* and it sent the reader to their connection while the fault was on the       */
/* machine.                                                                    */
/*                                                                            */
/* The oracles below are RELATIONS. The one that matters most is not "the code */
/* equals this string" — it is that the transport is proved to have ANSWERED   */
/* every poll, in the same test that asserts the exit status is not `network`. */
/* A relabelling cannot satisfy that pair.                                     */
/* -------------------------------------------------------------------------- */

function stalledClient(processState, observed) {
  return {
    async getAgentSession() {
      observed.polls += 1;
      return recoveredSession({ processState });
    },
  };
}

async function readinessFailure(processState) {
  const observed = { polls: 0 };
  let caught;
  await assert.rejects(
    effects(stalledClient(processState, observed)).ensureAgentSessionReady({
      agentSessionId: SESSION_ID,
      signal: new AbortController().signal,
    }),
    (error) => {
      caught = error;
      return error instanceof CunaError;
    },
  );
  return { error: caught, polls: observed.polls };
}

test("a readiness stall does not exit with a network status, because the network answered", async () => {
  for (const processState of ["starting", "unknown", "terminating"]) {
    const { error, polls } = await readinessFailure(processState);

    // The transport answered every single time. That is the whole reason
    // `network` was the wrong word, and it is measured here rather than assumed.
    assert.ok(polls > 1, `${processState}: the poll loop did not run`);
    assert.equal(
      error.details?.observations,
      String(polls),
      `${processState}: the error reports a different number of observations than were made`,
    );
    assert.notEqual(
      error.exitCode,
      EXIT_CODES.network,
      `${processState}: ${polls} answered polls still exit with the network status`,
    );

    // The state it actually observed travels with the error, so the next read
    // is decided by the message rather than by guessing.
    assert.equal(error.details?.observed_state, processState);
    assert.equal(error.details?.observed_states, processState);
  }
});

test("three different stalls are three different faults", async () => {
  const results = new Map();
  for (const processState of ["starting", "unknown", "terminating"]) {
    results.set(processState, (await readinessFailure(processState)).error);
  }
  const codes = [...results.values()].map((error) => error.code);
  assert.equal(
    new Set(codes).size,
    codes.length,
    `three stalls produced overlapping codes: ${codes.join(", ")}`,
  );

  // A session already shutting down is not the same decision as one that never
  // started, so it does not share their exit status either.
  assert.notEqual(
    results.get("terminating").exitCode,
    results.get("starting").exitCode,
    "a terminating session and one that never started exit identically",
  );

  // Literal oracle, so the inequalities above cannot be satisfied by renaming
  // everything to three arbitrary words.
  assert.equal(results.get("starting").code, "cuna.journey.agent_session_start_incomplete");
  assert.equal(results.get("unknown").code, "cuna.journey.agent_session_unobservable");
  assert.equal(results.get("terminating").code, "cuna.journey.agent_session_terminating");
  assert.equal(results.get("terminating").exitCode, EXIT_CODES.conflict);
});

test("a terminal AgentSession names which terminal state it reached", async () => {
  const reached = [];
  for (const processState of ["exited", "failed", "terminated"]) {
    const observed = { polls: 0 };
    let caught;
    await assert.rejects(
      effects(stalledClient(processState, observed)).ensureAgentSessionReady({
        agentSessionId: SESSION_ID,
        signal: new AbortController().signal,
      }),
      (error) => {
        caught = error;
        return error instanceof CunaError;
      },
    );
    assert.equal(observed.polls, 1, `${processState}: a terminal state must be refused on the first read`);
    assert.equal(caught.code, "cuna.journey.agent_session_failed");
    assert.equal(caught.details?.observed_state, processState);
    assert.notEqual(caught.exitCode, EXIT_CODES.network);
    reached.push(caught.message);
  }
  // One code, three messages: the code is the class, and the state it reached is
  // carried rather than discarded. Splitting the class further is a separate,
  // deliberate change to the error surface.
  assert.equal(new Set(reached).size, 3, "three terminal states rendered one message");
});

test("readiness returns as soon as the producer says ready or running", async () => {
  for (const processState of ["ready", "running"]) {
    const observed = { polls: 0 };
    const result = await effects(stalledClient(processState, observed)).ensureAgentSessionReady({
      agentSessionId: SESSION_ID,
      signal: new AbortController().signal,
    });
    assert.equal(observed.polls, 1, `${processState}: readiness was not decided on the first read`);
    assert.equal(result.id, SESSION_ID);
  }
});
