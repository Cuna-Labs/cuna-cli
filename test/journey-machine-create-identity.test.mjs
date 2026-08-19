import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, CunaError } from "../dist/index.js";
import { deriveMachineCreateIdentity } from "../dist/journey/derived-identity.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { orchestrateAgentJourney } from "../dist/journey/orchestrator.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const MACHINE = "55555555-5555-4555-8555-555555555555";
const SECOND_MACHINE = "66666666-6666-4666-8666-666666666666";
const BINDING = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const ROOT = "C:\\work\\project";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function identityInput(overrides = {}) {
  return {
    userId: USER,
    workspaceId: WORKSPACE,
    canonicalLocalRoot: ROOT,
    agent: "claude-code",
    machine: { kind: "automatic" },
    ...overrides,
  };
}

/**
 * A literal oracle, deliberately.
 *
 * Every other assertion in this file compares one derivation against another,
 * so a mutation that changes the derivation consistently — reordering the
 * fields, renaming the domain, swapping the hash — moves both sides together
 * and stays green. Only a written-out value catches that, and a change to it is
 * exactly the change that stops existing machines from being findable.
 */
test("the machine-create identity is a pinned projection of the invocation intent", () => {
  assert.deepEqual(deriveMachineCreateIdentity(identityInput()), {
    requestId: "438d4ad0-8e22-560f-9cc5-e8e3694aa696",
    idempotencyKey: "cuna-machine-create-36cb5e8ec25ac114f95878376494f462b8133bc1d6b92927677edb9e2f11911d",
    intentDigest: "36cb5e8ec25ac114f95878376494f462b8133bc1d6b92927677edb9e2f11911d",
  });
});

test("re-deriving the same invocation yields the same identity, and every input is load-bearing", () => {
  const base = deriveMachineCreateIdentity(identityInput());
  assert.deepEqual(deriveMachineCreateIdentity(identityInput()), base);

  const distinct = [
    ["a second principal", { userId: "77777777-7777-4777-8777-777777777777" }],
    ["a second workspace", { workspaceId: "88888888-8888-4888-8888-888888888888" }],
    ["a second project root", { canonicalLocalRoot: "C:\\work\\other" }],
    ["a second agent", { agent: "codex" }],
    ["an explicit --new", { machine: { kind: "new" } }],
    ["an explicit --machine NAME", { machine: { kind: "exact-name", name: "review" } }],
    ["a different --machine NAME", { machine: { kind: "exact-name", name: "staging" } }],
  ];
  const seen = new Map([[base.requestId, "the base invocation"]]);
  for (const [label, overrides] of distinct) {
    const derived = deriveMachineCreateIdentity(identityInput(overrides));
    const collision = seen.get(derived.requestId);
    assert.equal(collision, undefined, `${label} collides with ${collision}`);
    assert.notEqual(derived.idempotencyKey, base.idempotencyKey, label);
    seen.set(derived.requestId, label);
  }
});

test("an identity component that cannot be serialized unambiguously is refused, never guessed", () => {
  for (const [component, overrides] of [
    ["user_id", { userId: "" }],
    ["workspace_id", { workspaceId: "with\0separator" }],
    ["canonical_local_root", { canonicalLocalRoot: "" }],
    ["machine_selection", { machine: { kind: "somewhere-else" } }],
    ["machine_selection", { machine: { kind: "exact-name", name: "" } }],
  ]) {
    assert.throws(
      () => deriveMachineCreateIdentity(identityInput(overrides)),
      (error) =>
        error instanceof CunaError &&
        error.code === "cuna.journey.machine_create_identity_unavailable" &&
        error.exitCode === EXIT_CODES.policy &&
        error.details.component === component,
      component,
    );
  }
});

function capabilitySnapshot(subjectScope, subjectId, capabilityId) {
  return {
    schemaVersion: "1.0",
    subjectScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: "2026-08-09T12:00:00.000Z",
    expiresAt: "2026-08-09T12:00:30.000Z",
    etag: "fixture",
    capabilities: [{
      id: capabilityId,
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: [capabilityId.replace(".", ":")],
    }],
  };
}

function lost(code) {
  return new CunaError({ code, message: "The create response was lost.", exitCode: EXIT_CODES.network });
}

/**
 * A producer that behaves the way `0062_machine_create_idempotency` says it
 * does: one machine per distinct create-request identity, durably admitted
 * before any response is written, and findable afterwards by that identity.
 *
 * The rule under test is the CLIENT'S: whether a re-launched CLI presents the
 * identity it presented before. This fake never deduplicates on anything else,
 * so a client that mints a fresh identity gets a second machine — which is the
 * orphan this whole path exists to prevent, and the failure this test reports.
 */
function producer() {
  const admitted = new Map();
  const machines = new Map();
  const calls = [];
  let readsFail = false;
  return {
    calls,
    machines,
    set readsFail(value) { readsFail = value; },
    async discoverCapabilities(scope, resourceId) {
      return scope === "account"
        ? capabilitySnapshot("account", undefined, "machines.create")
        : capabilitySnapshot("machine", resourceId, "agent_sessions.create");
    },
    async listMachines() {
      calls.push(["list-machines"]);
      // The window this test is about: the provider has accepted the create and
      // the machine is not yet in the account listing, so the CLI cannot find
      // its own orphan by looking for it.
      return { items: [] };
    },
    async createMachine(input, idempotencyKey, requestId) {
      calls.push(["create-machine", { requestId, idempotencyKey, name: input.name }]);
      if (!admitted.has(requestId)) {
        const id = machines.size === 0 ? MACHINE : SECOND_MACHINE;
        machines.set(id, { id, name: input.name, state: "running" });
        admitted.set(requestId, id);
      }
      // The response never reaches this client. The effect is committed anyway.
      throw lost("cuna.client.response_budget_elapsed");
    },
    async getMachineCreateRequest(id) {
      calls.push(["get-machine-create", id]);
      if (readsFail) throw lost("cuna.network.failed");
      const machineId = admitted.get(id);
      if (machineId === undefined) {
        throw new CunaError({
          code: "cuna.remote.not_found",
          message: "No such machine create request.",
          exitCode: EXIT_CODES.remote,
        });
      }
      return {
        id,
        machineId,
        state: "settled",
        retryable: false,
        action: "none",
        updatedAt: "2026-08-09T12:00:00.000Z",
      };
    },
    async reconcileMachineCreateRequest(id) {
      return this.getMachineCreateRequest(id);
    },
    async getMachine(id) {
      calls.push(["get-machine", id]);
      const machine = machines.get(id);
      if (machine === undefined) {
        throw new CunaError({
          code: "cuna.remote.not_found",
          message: "No such machine.",
          exitCode: EXIT_CODES.remote,
        });
      }
      return machine;
    },
    async listAgentSessions() { return { items: [] }; },
    async createAgentSession(machineId, input) {
      calls.push(["create-agent-session", machineId]);
      return {
        id: SESSION,
        machineId,
        name: "claude-code",
        agent: input.agent,
        cwd: input.cwd,
        authMode: input.authMode,
        desiredState: "running",
        requestState: "launch_pending",
        processState: "ready",
        rowVersion: 0,
        workspaceBindingId: input.workspaceBindingId,
        workspaceGeneration: input.workspaceGeneration,
      };
    },
    async getAgentSession(id) {
      return { id, machineId: MACHINE, processState: "ready" };
    },
  };
}

function journey(client, attached) {
  return orchestrateAgentJourney({
    intent: {
      schemaVersion: "1.0",
      command: "claude",
      agent: "claude-code",
      target: "reconcile",
      machine: { kind: "automatic" },
      localPath: ROOT,
      syncMode: "enabled",
      newSession: false,
    },
    scope: { userId: USER, workspaceId: WORKSPACE },
    effects: createApiAgentJourneyEffects({
      client,
      async inspectWorkspace() { return { canonicalLocalRoot: ROOT }; },
      async synchronizeWorkspace() {
        return {
          bindingId: BINDING,
          workspaceIdentity: BINDING,
          generation: 4,
          remoteCwd: "/workspace/projects/project",
        };
      },
      async attach({ agentSessionId }) { attached.push(agentSessionId); },
      async authorizeMachineCreate() { return true; },
      now: () => NOW,
      async sleep() {},
    }),
  });
}

/**
 * The whole point of the derivation, exercised as the user meets it.
 *
 * Run one: the provider accepts the create and the CLI never learns the
 * outcome, then loses the network entirely, so it dies without recording
 * anything. Run two is the same command typed again. It must find the machine
 * run one created — not create a second one that bills forever beside it.
 *
 * The oracle is the producer's recorded calls and the number of machines that
 * came into existence, not anything the journey returned. A journey that
 * created a duplicate would also return a perfectly good machine.
 */
test("an interrupted journey re-run reconciles its own create instead of creating a second machine", async () => {
  const client = producer();
  const attached = [];

  client.readsFail = true;
  await assert.rejects(
    journey(client, attached),
    (error) => error instanceof CunaError && error.code === "cuna.network.failed",
  );
  const firstCreate = client.calls.find((call) => call[0] === "create-machine");
  assert.notEqual(firstCreate, undefined);
  assert.equal(client.machines.size, 1, "run one must have left exactly one machine behind");
  assert.deepEqual(attached, [], "run one must not have reached attach");

  client.calls.length = 0;
  client.readsFail = false;
  await journey(client, attached);

  assert.equal(
    client.machines.size,
    1,
    "the re-run created a second machine: its create-request identity did not survive the process",
  );
  const secondCreate = client.calls.find((call) => call[0] === "create-machine");
  assert.notEqual(secondCreate, undefined, "the re-run must still reach the create path");
  assert.deepEqual(secondCreate[1], firstCreate[1]);
  assert.deepEqual(
    client.calls.filter((call) => call[0] === "get-machine-create"),
    [["get-machine-create", firstCreate[1].requestId]],
    "the re-run must look the create up by the identity run one used",
  );
  assert.deepEqual(attached, [SESSION]);
  assert.deepEqual([...client.machines.keys()], [MACHINE]);
});

/**
 * The identity is recorded only once a create has actually been dispatched.
 * Claiming one earlier made every cancelled journey that merely selected an
 * existing machine ask the producer about a request it had never been told
 * about.
 */
test("a journey that never dispatches a create carries no create-request identity", async () => {
  const controller = new AbortController();
  const ledgers = [];
  await assert.rejects(
    orchestrateAgentJourney({
      intent: {
        schemaVersion: "1.0",
        command: "claude",
        agent: "claude-code",
        target: "reconcile",
        machine: { kind: "automatic" },
        localPath: ROOT,
        syncMode: "enabled",
        newSession: false,
      },
      scope: { userId: USER, workspaceId: WORKSPACE },
      signal: controller.signal,
      effects: {
        onPhase(phase) { if (phase === "observe-machines") controller.abort(new Error("interrupted")); },
        async inspectWorkspace() { return { canonicalLocalRoot: ROOT }; },
        async observeMachines() { return []; },
        async createMachine() { throw new Error("unexpected create"); },
        async reconcileMachineCreate() { throw new Error("unexpected reconcile"); },
        async ensureMachineReady() { throw new Error("unexpected ready"); },
        async synchronizeWorkspace() { throw new Error("unexpected sync"); },
        async observeAgentSessions() { throw new Error("unexpected observe"); },
        async createAgentSession() { throw new Error("unexpected create session"); },
        async ensureAgentSessionReady() { throw new Error("unexpected ready session"); },
        async attach() { throw new Error("unexpected attach"); },
        async reconcileCancellation({ ledger }) { ledgers.push(ledger); },
      },
    }),
    (error) => error instanceof CunaError && error.code === "cuna.journey.cancelled",
  );
  assert.equal(ledgers.length, 1);
  assert.equal(Object.hasOwn(ledgers[0], "machineCreateRequestId"), false);
});
