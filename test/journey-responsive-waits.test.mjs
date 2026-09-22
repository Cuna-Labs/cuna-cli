import assert from "node:assert/strict";
import test from "node:test";

import { observationBudgetElapsed } from "../dist/core/observation-budget.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { orchestrateAgentJourney } from "../dist/journey/orchestrator.js";
import { AGENT_SESSION_READY_DEADLINE_MS, MACHINE_READY_DEADLINE_MS } from "../dist/journey/wait-policy.js";

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const SCOPE = Object.freeze({
  userId: "40000000-0000-4000-8000-000000000001",
  workspaceId: "50000000-0000-4000-8000-000000000001",
});
const START = Date.parse("2026-09-22T02:33:22.723Z");

function fakeClock(startAt = START) {
  let value = startAt;
  return { now: () => value, advance(milliseconds) { value += milliseconds; } };
}

function budgetElapsed(path) {
  return observationBudgetElapsed({
    kind: "response",
    operation: `GET ${path}`,
    budgetMs: 15_000,
    details: { method: "GET", path },
  });
}

function session(overrides = {}) {
  return {
    id: SESSION_ID,
    machineId: MACHINE_ID,
    name: "claude-code",
    agent: "claude-code",
    cwd: "/workspace/projects/project",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launch_pending",
    processState: "running",
    rowVersion: 0,
    workspaceBindingId: BINDING_ID,
    workspaceGeneration: 7,
    ...overrides,
  };
}

function terminalCapability(availability = "supported", reasonCode) {
  return {
    schemaVersion: "1.0",
    subjectScope: "agent_session",
    subjectId: SESSION_ID,
    observedAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 30_000).toISOString(),
    etag: "terminal",
    capabilities: [{
      id: "terminal_connections.create",
      availability,
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["terminal_connections:create"],
      ...(reasonCode === undefined ? {} : { reasonCode }),
    }],
  };
}

/**
 * Build the real API effects over a hand-driven clock. The clock advances only
 * inside the fake sleep and inside a read that is meant to burn its budget, so
 * every elapsed figure the policy reports is one this test decided.
 */
function effects(client, options = {}) {
  const clock = options.clock ?? fakeClock();
  const waits = [];
  const value = createApiAgentJourneyEffects({
    client,
    requestedAgent: "claude-code",
    async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return options.authorizeMachineCreate ?? false; },
    now: clock.now,
    async sleep(milliseconds) { clock.advance(milliseconds); },
    onWait: (wait) => waits.push(wait),
  });
  return { effects: value, waits, clock };
}

test("a slow AgentSession read is re-issued and the journey reaches attach", async () => {
  // Reproduces run `cold1` of prds/cuna-cli-latency-before-20260922.md: one
  // GET /v1/agent-sessions/<id> burns the 15 000 ms budget while the session
  // is healthy. The journey has 180 000 ms of its own and must keep going.
  const h = effects({
    async getAgentSession(id) {
      if (reads++ === 0) { h.clock.advance(15_000); throw budgetElapsed(`/v1/agent-sessions/${id}`); }
      return session();
    },
    async discoverCapabilities() { return terminalCapability(); },
  });
  let reads = 0;
  const ready = await h.effects.ensureAgentSessionReady({
    agentSessionId: SESSION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(ready, { id: SESSION_ID, machineId: MACHINE_ID });
  assert.equal(reads, 2);
  assert.deepEqual(h.waits.map((wait) => wait.waitingFor), ["Cuna to answer the AgentSession read"]);
  assert.equal(h.waits[0].deadlineMs, AGENT_SESSION_READY_DEADLINE_MS);
  assert.equal(h.waits[0].elapsedMs, 15_000);
});

test("NEGATIVE CONTROL: the same slow read aborts once the journey is out of time", async () => {
  // The old behaviour, reproduced by removing the only thing that changed --
  // journey time left. Run `cold1` exited 5 here with the budget refusal.
  const clock = fakeClock();
  let reads = 0;
  const h = effects({
    async getAgentSession(id) {
      reads += 1;
      clock.advance(AGENT_SESSION_READY_DEADLINE_MS + 1_000);
      throw budgetElapsed(`/v1/agent-sessions/${id}`);
    },
    async discoverCapabilities() { return terminalCapability(); },
  }, { clock });
  await assert.rejects(
    h.effects.ensureAgentSessionReady({ agentSessionId: SESSION_ID, signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, "cuna.journey.agent_session_ready_timeout");
      assert.equal(error.details.agent_session_id, SESSION_ID);
      assert.equal(error.details.waiting_for, "Cuna to answer the AgentSession read");
      assert.equal(error.details.deadline_ms, AGENT_SESSION_READY_DEADLINE_MS);
      assert.ok(error.details.elapsed_ms >= AGENT_SESSION_READY_DEADLINE_MS);
      assert.equal(error.cause.code, "cuna.client.response_budget_elapsed");
      assert.equal(error.cause.details.remote_outcome, "unobserved");
      return true;
    },
  );
  assert.equal(reads, 1, "a journey with no time left must not re-issue");
});

test("a non-idempotent step keeps today's behaviour: the create is never re-issued", async () => {
  // R5's other half. The machine create commits — `POST /v1/sessions`, per
  // `api/client.ts` — so an unobserved response is an unknown outcome, and
  // asking again would be a blind retry of an effect.
  let creates = 0;
  const h = effects({
    async discoverCapabilities() {
      return {
        schemaVersion: "1.0",
        subjectScope: "account",
        observedAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 30_000).toISOString(),
        etag: "machines-create",
        capabilities: [{
          id: "machines.create", availability: "supported", interaction: "native",
          mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: ["machines:create"],
        }],
      };
    },
    async createMachine() { creates += 1; throw budgetElapsed("/v1/machines"); },
  }, { authorizeMachineCreate: true });
  await assert.rejects(
    h.effects.createMachine({
      requestedAgent: "claude-code", idempotencyKey: "k",
      requestId: "9c11250a-0000-4000-8000-000000000001",
      onDispatch() {}, signal: new AbortController().signal,
    }),
    (error) => error.code === "cuna.client.response_budget_elapsed",
  );
  assert.equal(creates, 1, "exactly one dispatch, and its unobserved outcome propagates");
  assert.deepEqual(h.waits, [], "a mutation must never render as a wait it intends to repeat");
});

for (const [reasonCode, waitingFor] of [
  ["supervisor_registry_unavailable", "the machine's terminal supervisor to register"],
  ["agent_session_not_ready", "the session to accept a terminal"],
  ["runtime_lease_expired", "a fresh runtime observation"],
]) {
  test(`the wait names ${reasonCode} instead of one unchanging sentence`, async () => {
    // Measured 2026-09-22 § 3: `Starting Claude Code · still working` held for
    // 61 259 ms across every one of these, so three causes rendered alike.
    let capabilityReads = 0;
    const h = effects({
      async getAgentSession() { return session(); },
      async discoverCapabilities() {
        return capabilityReads++ === 0
          ? terminalCapability("unknown", reasonCode)
          : terminalCapability();
      },
    });
    await h.effects.ensureAgentSessionReady({ agentSessionId: SESSION_ID, signal: new AbortController().signal });
    assert.deepEqual(h.waits.map((wait) => wait.waitingFor), [waitingFor]);
    assert.equal(h.waits[0].deadlineMs, AGENT_SESSION_READY_DEADLINE_MS);
  });
}

test("a process that has not started yet is named as such", async () => {
  let reads = 0;
  const h = effects({
    async getAgentSession() { return session({ processState: reads++ === 0 ? "pending" : "running" }); },
    async discoverCapabilities() { return terminalCapability(); },
  });
  await h.effects.ensureAgentSessionReady({ agentSessionId: SESSION_ID, signal: new AbortController().signal });
  assert.deepEqual(h.waits.map((wait) => wait.waitingFor), ["the session process to start"]);
});

test("machine readiness re-issues its own slow read under its own deadline", async () => {
  let reads = 0;
  const h = effects({
    async getMachine(id) {
      if (reads++ === 0) { h.clock.advance(15_000); throw budgetElapsed(`/v1/machines/${id}`); }
      return { id: MACHINE_ID, state: "running" };
    },
  });
  const ready = await h.effects.ensureMachineReady({
    machineId: MACHINE_ID, observedState: "creating", signal: new AbortController().signal,
  });
  assert.deepEqual(ready, { id: MACHINE_ID, state: "running" });
  assert.deepEqual(h.waits.map((wait) => wait.waitingFor), ["Cuna to answer the machine read"]);
  assert.equal(h.waits[0].deadlineMs, MACHINE_READY_DEADLINE_MS);
});

test("machine readiness names what it waits for and stops at its declared deadline", async () => {
  const clock = fakeClock();
  const h = effects({
    async getMachine() { return { id: MACHINE_ID, state: "creating" }; },
  }, { clock });
  await assert.rejects(
    h.effects.ensureMachineReady({ machineId: MACHINE_ID, observedState: "creating", signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, "cuna.journey.machine_ready_timeout");
      assert.equal(error.details.waiting_for, "the machine to reach running");
      assert.equal(error.details.deadline_ms, MACHINE_READY_DEADLINE_MS);
      return true;
    },
  );
  assert.ok(h.waits.length > 1);
  assert.deepEqual([...new Set(h.waits.map((wait) => wait.waitingFor))], ["the machine to reach running"]);
  // The elapsed figure must move, or the line repeats and the dwell returns.
  assert.ok(h.waits.at(-1).elapsedMs > h.waits[0].elapsedMs);
});

/* -------------------------------------------------------------------------- */
/* The created|reused line                                                    */
/* -------------------------------------------------------------------------- */

function journeyEffects(overrides = {}) {
  const dispositions = [];
  return {
    dispositions,
    value: {
      async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work" }; },
      async observeMachines() {
        return [{
          id: MACHINE_ID, name: "work", agent: "claude-code", requestedAgentSupport: "supported",
          state: "running", ownership: "owned", freshness: "fresh", recency: "recent",
          resources: { vcpus: 2, memoryMiB: 2048 }, costStatus: "known",
        }];
      },
      async createMachine() { throw new Error("unused"); },
      async reconcileMachineCreate() { throw new Error("unused"); },
      async ensureMachineReady(input) { return { id: input.machineId, state: "running" }; },
      async synchronizeWorkspace() {
        return {
          bindingId: BINDING_ID, workspaceIdentity: BINDING_ID, generation: 4,
          remoteCwd: "/workspace/projects/project",
        };
      },
      async observeAgentSessions() { return []; },
      async createAgentSession(input) { return { id: SESSION_ID, machineId: input.machineId }; },
      async ensureAgentSessionReady(input) { return { id: input.agentSessionId, machineId: MACHINE_ID }; },
      async attach() {},
      async reconcileCancellation() {},
      onAgentSession(event) { dispositions.push(event); },
      ...overrides,
    },
  };
}

function intent(overrides = {}) {
  return {
    schemaVersion: "1.0", command: "claude", agent: "claude-code", target: "reconcile",
    machine: { kind: "automatic" }, localPath: "C:\\work", syncMode: "enabled", newSession: false,
    ...overrides,
  };
}

test("a created AgentSession is announced as created, before readiness is waited on", async () => {
  const order = [];
  const fx = journeyEffects({
    async createAgentSession(input) { order.push("create"); return { id: SESSION_ID, machineId: input.machineId }; },
    async ensureAgentSessionReady(input) { order.push("ready"); return { id: input.agentSessionId, machineId: MACHINE_ID }; },
    onAgentSession(event) { order.push(`announce:${event.disposition}`); },
  });
  await orchestrateAgentJourney({ intent: intent(), effects: fx.value, scope: SCOPE, idempotencyKey: "cuna-journey-test-0001" });
  // The 2026-09-22 measurement found the row existing 11 446 ms before the
  // screen changed. The announcement must precede the wait, not follow it.
  assert.deepEqual(order, ["create", "announce:created", "ready"]);
});

test("a reused AgentSession is announced as reused, with its id and machine", async () => {
  const fx = journeyEffects({
    async observeAgentSessions() {
      return [{
        id: SESSION_ID, machineId: MACHINE_ID, name: "claude-code", agent: "claude-code",
        workspaceIdentity: BINDING_ID, workspaceKind: "binding", workspaceGeneration: 4,
        cwd: "projects/project", authMode: "interactive_login", processState: "running",
        attachment: "detached", freshness: "fresh", createdAt: new Date(START).toISOString(),
      }];
    },
    async createAgentSession() { assert.fail("an existing session must not be recreated"); },
  });
  await orchestrateAgentJourney({ intent: intent(), effects: fx.value, scope: SCOPE, idempotencyKey: "cuna-journey-test-0002" });
  assert.deepEqual(fx.dispositions, [{
    agentSessionId: SESSION_ID, machineId: MACHINE_ID, disposition: "reused",
  }]);
});

test("a journey that never settles on an AgentSession announces nothing", async () => {
  const fx = journeyEffects({
    async synchronizeWorkspace() { throw new Error("sync refused"); },
  });
  await assert.rejects(
    orchestrateAgentJourney({ intent: intent(), effects: fx.value, scope: SCOPE, idempotencyKey: "cuna-journey-test-0003" }),
  );
  assert.deepEqual(fx.dispositions, [], "no line may claim a row this journey never chose");
});
