import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const EXECUTION_WORKSPACE = "99999999-9999-4999-8999-999999999999";
const PROFILE = "77777777-7777-4777-8777-777777777777";
const REMOTE_CWD = `/workspace/workspaces/${EXECUTION_WORKSPACE}`;
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
  const sessions = new Map();
  const calls = [];
  let readsFail = false;
  return {
    calls,
    machines,
    sessions,
    set readsFail(value) { readsFail = value; },
    async discoverCapabilities(scope, resourceId) {
      if (scope === "account") return capabilitySnapshot("account", undefined, "machines.create");
      // The launch is complete only once the terminal seat is attestable, so
      // readiness asks the session's own scope for it.
      if (scope === "agent_session") return capabilitySnapshot("agent_session", resourceId, "terminal_connections.create");
      return capabilitySnapshot("machine", resourceId, "agent_sessions.create");
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
    // The retired pre-V2 create. A journey that reaches it has stopped using
    // the published-Workspace profile path this product now launches through.
    async createAgentSession() { throw new Error("retired agent-session create must not be dispatched"); },
    async createProviderSessionV2(machineId, request) {
      calls.push(["create-provider-session", { machineId, operationId: request.operation_id,
        executionWorkspaceId: request.execution_workspace_id, generation: request.workspace_generation,
        profileId: request.profile_id, profileRevision: request.profile_revision }]);
      sessions.set(SESSION, { machineId });
      return {
        agentSession: {
          id: SESSION,
          machineId,
          name: "claude-code",
          agent: request.agent,
          cwd: request.cwd,
          authMode: "interactive_login",
          desiredState: "running",
          requestState: "launch_pending",
          processState: "ready",
          rowVersion: 0,
        },
      };
    },
    async getAgentSession(id) {
      return { id, machineId: MACHINE, processState: "ready" };
    },
  };
}

/**
 * The workspace receipt a launch actually runs on.
 *
 * A canonical V2 launch is admitted against a *published execution Workspace*
 * and a selected provider profile; a receipt without an
 * `executionWorkspaceId` is refused before dispatch, by design. The fixture
 * carries the full receipt so the create this test is about is the create the
 * product performs. `workspaceless` keeps the refusal itself under test.
 */
function workspaceReceipt(overrides = {}) {
  return {
    bindingId: BINDING,
    workspaceIdentity: BINDING,
    executionWorkspaceId: EXECUTION_WORKSPACE,
    generation: 4,
    remoteCwd: REMOTE_CWD,
    ...overrides,
  };
}

function journey(client, attached, stateDirectory, workspace = workspaceReceipt()) {
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
      requestedAgent: "claude-code",
      // The durable launch identity lives on disk precisely so a re-run
      // presents the operation identity the interrupted run may have sent.
      providerLaunchState: { stateDirectory, ownerId: USER, workspaceId: WORKSPACE },
      async selectProviderPreset() {
        return { kind: "native_interactive", agent: "claude-code", label: "Selected preset",
          profile_id: PROFILE, profile_revision: 2 };
      },
      async inspectWorkspace() { return { canonicalLocalRoot: ROOT }; },
      async synchronizeWorkspace() { return workspace; },
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
test("an interrupted journey re-run reconciles its own create instead of creating a second machine", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cuna-create-identity-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const client = producer();
  const attached = [];

  client.readsFail = true;
  await assert.rejects(
    journey(client, attached, stateDirectory),
    (error) => error instanceof CunaError && error.code === "cuna.network.failed",
  );
  const firstCreate = client.calls.find((call) => call[0] === "create-machine");
  assert.notEqual(firstCreate, undefined);
  assert.equal(client.machines.size, 1, "run one must have left exactly one machine behind");
  assert.deepEqual(attached, [], "run one must not have reached attach");
  assert.equal(client.sessions.size, 0, "run one died before any child was requested");

  client.calls.length = 0;
  client.readsFail = false;
  await journey(client, attached, stateDirectory);

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
  // One machine and one child. The launch is admitted against the published
  // execution Workspace and the selected profile the journey actually chose,
  // under a single durable operation identity.
  const childCreates = client.calls.filter((call) => call[0] === "create-provider-session");
  assert.equal(childCreates.length, 1, "the re-run requested more than one child");
  assert.deepEqual([...client.sessions.keys()], [SESSION]);
  assert.deepEqual(childCreates[0][1], {
    machineId: MACHINE,
    operationId: childCreates[0][1].operationId,
    executionWorkspaceId: EXECUTION_WORKSPACE,
    generation: 4,
    profileId: PROFILE,
    profileRevision: 2,
  });
  assert.match(childCreates[0][1].operationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
});

/**
 * The same re-run, minus the published execution Workspace.
 *
 * The recovery path must not become a place where the launch policy relaxes:
 * a receipt the product would refuse on a first run is refused on a re-run
 * too, before dispatch, and leaves no second machine and no child behind.
 */
test("a recovered journey without a published execution Workspace still refuses before dispatch", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cuna-create-identity-refused-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const client = producer();
  const attached = [];
  const workspaceless = workspaceReceipt({ executionWorkspaceId: undefined });

  client.readsFail = true;
  await assert.rejects(
    journey(client, attached, stateDirectory, workspaceless),
    (error) => error instanceof CunaError && error.code === "cuna.network.failed",
  );

  client.readsFail = false;
  await assert.rejects(
    journey(client, attached, stateDirectory, workspaceless),
    (error) => error instanceof CunaError &&
      error.code === "cuna.journey.agent_session_create_outcome_unreconcilable" &&
      error.details.failure_stage === "local_pre_admission" &&
      error.details.cause_code === "cuna.provider.v2_unavailable",
  );
  assert.equal(client.machines.size, 1, "a refused launch must not leave a second machine");
  assert.equal(client.sessions.size, 0, "a refused launch must not leave a child");
  assert.deepEqual(attached, []);
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
