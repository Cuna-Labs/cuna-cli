import assert from "node:assert/strict";
import test from "node:test";

import {
  planAgentSessionSelection,
  planJourneySelection,
  planMachineSelection,
} from "../dist/journey/selection.js";

const MACHINE_A = "00000000-0000-4000-8000-000000000001";
const MACHINE_B = "00000000-0000-4000-8000-000000000002";
const MACHINE_C = "00000000-0000-4000-8000-000000000003";
const SESSION_A = "10000000-0000-4000-8000-000000000001";
const SESSION_B = "10000000-0000-4000-8000-000000000002";
const SESSION_C = "10000000-0000-4000-8000-000000000003";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";

function machine(overrides = {}) {
  return {
    id: MACHINE_A,
    name: "primary",
    agent: "claude-code",
    requestedAgentSupport: "supported",
    state: "running",
    ownership: "owned",
    freshness: "fresh",
    recency: "recent",
    resources: { vcpus: 2, memoryMiB: 4096 },
    costStatus: "known",
    ...overrides,
  };
}

function machineInput(machines, overrides = {}) {
  return {
    requestedAgent: "claude-code",
    forceNew: false,
    collectionFreshness: "fresh",
    machines,
    ...overrides,
  };
}

function agentSession(overrides = {}) {
  return {
    id: SESSION_A,
    machineId: MACHINE_A,
    name: "api work",
    agent: "claude-code",
    workspaceIdentity: WORKSPACE,
    workspaceGeneration: 7,
    cwd: "services/api",
    authMode: "interactive_login",
    processState: "running",
    attachment: "detached",
    freshness: "fresh",
    createdAt: "2026-08-09T12:00:00.000Z",
    ...overrides,
  };
}

function agentSessionInput(agentSessions, overrides = {}) {
  return {
    machineId: MACHINE_A,
    requestedAgent: "claude-code",
    workspaceIdentity: WORKSPACE,
    workspaceGeneration: 7,
    cwd: "services/api",
    authMode: "interactive_login",
    forceNewSession: false,
    collectionFreshness: "fresh",
    agentSessions,
    ...overrides,
  };
}

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

test("TC-007-01 fixed machine selection order is explicit, binding, then one compatible recent machine", () => {
  const first = machine({ id: MACHINE_A, name: "first", recency: "not_recent" });
  const second = machine({ id: MACHINE_B, name: "second" });
  const third = machine({ id: MACHINE_C, name: "third", recency: "not_recent" });

  const explicit = planMachineSelection(
    machineInput([first, second, third], {
      selector: { kind: "id", value: MACHINE_A },
      projectBinding: { machineId: MACHINE_B, freshness: "fresh" },
    }),
  );
  assert.equal(explicit.kind, "select");
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.machineId, MACHINE_A);

  const bound = planMachineSelection(
    machineInput([first, second, third], {
      projectBinding: { machineId: MACHINE_A, freshness: "fresh" },
    }),
  );
  assert.equal(bound.kind, "select");
  assert.equal(bound.source, "project-binding");
  assert.equal(bound.machineId, MACHINE_A);

  const recent = planMachineSelection(machineInput([first, second, third]));
  assert.equal(recent.kind, "select");
  assert.equal(recent.source, "unique-compatible");
  assert.equal(recent.machineId, MACHINE_B);
});

test("TC-007-02 machine ambiguity is stable under every input order and exposes only safe public fields", () => {
  const candidates = [
    machine({ id: MACHINE_C, name: "same", resources: { vcpus: 4 } }),
    machine({ id: MACHINE_A, name: "same", resources: { memoryMiB: 2048 } }),
    machine({ id: MACHINE_B, name: "same", costStatus: "unknown" }),
  ];
  for (const reordered of permutations(candidates)) {
    const plan = planMachineSelection(machineInput(reordered));
    assert.equal(plan.kind, "ambiguous");
    assert.deepEqual(plan.candidates.map((candidate) => candidate.id), [MACHINE_A, MACHINE_B, MACHINE_C]);
    assert.deepEqual(Object.keys(plan.candidates[0]).sort(), [
      "agent",
      "costStatus",
      "id",
      "name",
      "resources",
      "state",
    ]);
    assert.equal(Object.isFrozen(plan.candidates), true);
    assert.equal(Object.isFrozen(plan.candidates[0]), true);
  }
});

test("machine selectors never use name similarity and duplicate exact names abstain", () => {
  const machines = [
    machine({ id: MACHINE_A, name: "production" }),
    machine({ id: MACHINE_B, name: "production" }),
    machine({ id: MACHINE_C, name: "production-copy" }),
  ];
  const approximate = planMachineSelection(
    machineInput(machines, { selector: { kind: "name", value: "prod" } }),
  );
  assert.deepEqual(approximate, {
    kind: "unavailable",
    target: "machine",
    targetId: "prod",
    reason: "not-found",
  });

  const duplicate = planMachineSelection(
    machineInput(machines, { selector: { kind: "name", value: "production" } }),
  );
  assert.equal(duplicate.kind, "ambiguous");
  assert.equal(duplicate.reason, "duplicate-name");
  assert.deepEqual(duplicate.candidates.map((candidate) => candidate.id), [MACHINE_A, MACHINE_B]);
});

test("duplicate machine IDs, stale bindings, unknown authority and incompatible agents fail closed", () => {
  assert.equal(
    planMachineSelection(machineInput([machine(), machine({ name: "duplicate identity" })])).reason,
    "duplicate-id",
  );

  const staleBinding = planMachineSelection(
    machineInput([machine(), machine({ id: MACHINE_B })], {
      projectBinding: { machineId: MACHINE_C, freshness: "fresh" },
    }),
  );
  assert.deepEqual(staleBinding, {
    kind: "stale-binding",
    target: "machine",
    machineId: MACHINE_C,
    reason: "machine-missing",
  });

  const unknown = planMachineSelection(
    machineInput([machine({ state: "unknown" }), machine({ id: MACHINE_B, requestedAgentSupport: "unknown" })]),
  );
  assert.equal(unknown.kind, "unavailable");
  assert.equal(unknown.reason, "authority-observation-stale");

  const incompatible = planMachineSelection(
    machineInput([machine({ requestedAgentSupport: "unsupported" })], {
      selector: { kind: "id", value: MACHINE_A },
    }),
  );
  assert.deepEqual(incompatible, {
    kind: "incompatible",
    target: "machine",
    targetId: MACHINE_A,
    reason: "agent-mismatch",
  });
});

test("terminal machines with unavailable provider evidence do not block automatic creation", () => {
  for (const state of ["error", "deleted"]) {
    assert.deepEqual(
      planMachineSelection(machineInput([
        machine({ state, requestedAgentSupport: "unknown", recency: "unknown" }),
      ], { requestedAgent: "opencode" })),
      { kind: "create-required", target: "machine", reason: "no-compatible-candidate" },
      `${state} must not poison a new OpenCode machine selection`,
    );
  }

  const creating = planMachineSelection(machineInput([
    machine({ state: "creating", requestedAgentSupport: "unknown", recency: "unknown" }),
  ], { requestedAgent: "opencode" }));
  assert.equal(creating.kind, "unavailable");
  assert.equal(creating.reason, "authority-observation-stale");
});

test("an OpenCode supervisor repair blocks automatic allocation but not explicit --new", () => {
  const repairing = machine({
    agent: "opencode",
    requestedAgentSupport: "unsupported",
    requestedAgentBlocker: "opencode-supervisor-update-required",
  });
  assert.deepEqual(
    planMachineSelection(machineInput([repairing], { requestedAgent: "opencode" })),
    {
      kind: "unavailable",
      target: "machine",
      targetId: MACHINE_A,
      reason: "opencode-supervisor-update-required",
    },
  );
  assert.deepEqual(
    planMachineSelection(machineInput([repairing], { requestedAgent: "opencode", forceNew: true })),
    { kind: "create-required", target: "machine", reason: "forced" },
  );
});

test("PRD-033 legacy machine agent never blocks a different supported child agent", () => {
  const plan = planMachineSelection(machineInput([
    machine({ agent: "claude-code", requestedAgentSupport: "supported" }),
  ], { requestedAgent: "codex" }));
  assert.equal(plan.kind, "select");
  assert.equal(plan.machineId, MACHINE_A);
});

test("--new bypasses reuse but contradictory explicit reuse instructions are rejected", () => {
  assert.deepEqual(
    planMachineSelection(machineInput([machine()], { forceNew: true })),
    { kind: "create-required", target: "machine", reason: "forced" },
  );
  assert.equal(
    planMachineSelection(
      machineInput([machine()], {
        forceNew: true,
        selector: { kind: "id", value: MACHINE_A },
      }),
    ).reason,
    "contradictory-selection",
  );
});

test("TC-033-03 exact detached AgentSession reuse is stable and --new-session forces creation", () => {
  const reusable = agentSession();
  const selected = planAgentSessionSelection(agentSessionInput([reusable]));
  assert.equal(selected.kind, "select");
  assert.equal(selected.source, "unique-compatible");
  assert.equal(selected.agentSessionId, SESSION_A);

  const forced = planAgentSessionSelection(
    agentSessionInput([reusable], { forceNewSession: true }),
  );
  assert.deepEqual(forced, {
    kind: "create-required",
    target: "agent-session",
    machineId: MACHINE_A,
    reason: "forced",
  });
});

test("TC-033-03 several exact detached AgentSessions always abstain with sorted candidates", () => {
  const sessions = [
    agentSession({ id: SESSION_C, name: "third" }),
    agentSession({ id: SESSION_A, name: "first" }),
    agentSession({ id: SESSION_B, name: "second" }),
  ];
  for (const reordered of permutations(sessions)) {
    const plan = planAgentSessionSelection(agentSessionInput(reordered));
    assert.equal(plan.kind, "ambiguous");
    assert.deepEqual(plan.candidates.map((candidate) => candidate.id), [SESSION_A, SESSION_B, SESSION_C]);
    assert.deepEqual(Object.keys(plan.candidates[0]).sort(), [
      "agent",
      "createdAt",
      "cwd",
      "id",
      "name",
      "state",
    ]);
  }
});

test("explicit AgentSession IDs are bound to the selected machine and exact compatibility key", () => {
  const crossMachine = agentSession({ id: SESSION_A, machineId: MACHINE_B });
  assert.deepEqual(
    planAgentSessionSelection(
      agentSessionInput([crossMachine], { agentSessionId: SESSION_A }),
    ),
    {
      kind: "incompatible",
      target: "agent-session",
      targetId: SESSION_A,
      reason: "machine-mismatch",
    },
  );

  const mismatchCases = [
    ["agent", "codex", "agent-mismatch"],
    ["workspaceIdentity", "other-workspace", "workspace-identity-mismatch"],
    ["workspaceGeneration", 8, "workspace-generation-mismatch"],
    ["cwd", "services/web", "cwd-mismatch"],
    ["authMode", "credential_binding", "auth-mode-mismatch"],
  ];
  for (const [field, value, reason] of mismatchCases) {
    const plan = planAgentSessionSelection(
      agentSessionInput([agentSession({ [field]: value })], { agentSessionId: SESSION_A }),
    );
    assert.equal(plan.kind, "incompatible");
    assert.equal(plan.reason, reason);
  }
});

test("duplicate AgentSession IDs and stale or unknown child state cannot select or trigger creation", () => {
  assert.equal(
    planAgentSessionSelection(
      agentSessionInput([agentSession(), agentSession({ name: "duplicate identity" })]),
    ).reason,
    "duplicate-id",
  );
  // Each cause keeps its own name. These four used to answer one reason, and
  // only three of them were about an observation being old: `attachment` is a
  // hardcoded `"unknown"` because no per-AgentSession attachment authority is
  // published, so every exact match was refused as "stale" while its
  // observation was seconds old. Stale invites a retry; unobservable is a
  // missing prerequisite that no retry supplies, and a user told the wrong one
  // waits for something that cannot arrive.
  for (const [observation, expected] of [
    [agentSession({ freshness: "stale" }), "authority-observation-stale"],
    [agentSession({ processState: "unknown" }), "authority-observation-stale"],
    [agentSession({ processState: "starting" }), "authority-observation-stale"],
    [agentSession({ attachment: "unknown" }), "attachment-unobservable"],
  ]) {
    const plan = planAgentSessionSelection(agentSessionInput([observation]));
    assert.equal(plan.kind, "unavailable");
    assert.equal(plan.reason, expected);
  }
});

test("nonmatching and terminal children never substitute for an exact detached child", () => {
  const nonmatching = agentSession({ id: SESSION_A, cwd: "services/web" });
  const terminated = agentSession({ id: SESSION_C, processState: "terminated" });
  const plan = planAgentSessionSelection(agentSessionInput([nonmatching, terminated]));
  assert.deepEqual(plan, {
    kind: "create-required",
    target: "agent-session",
    machineId: MACHINE_A,
    reason: "no-compatible-candidate",
  });
});

test("a live exact session whose writer seat another client holds is refused by name, never shadowed by a sibling create", () => {
  const holder = "cli:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const held = agentSession({ id: SESSION_B, attachment: "attached", attachmentHolder: holder });
  const plan = planAgentSessionSelection(agentSessionInput([held]));
  assert.deepEqual(plan, {
    kind: "unavailable",
    target: "agent-session",
    targetId: SESSION_B,
    holder,
    reason: "already-attached",
  });

  // The holder is display data, not a precondition: a held seat with no
  // recorded holder is still held.
  const anonymous = planAgentSessionSelection(agentSessionInput([agentSession({ id: SESSION_B, attachment: "attached" })]));
  assert.equal(anonymous.reason, "already-attached");
  assert.equal(Object.hasOwn(anonymous, "holder"), false);

  // A free exact session still wins over a held one; the held one is not an
  // ambiguity because it was never a candidate.
  const free = agentSession({ id: SESSION_A, attachment: "detached" });
  const reused = planAgentSessionSelection(agentSessionInput([held, free]));
  assert.equal(reused.kind, "select");
  assert.equal(reused.agentSessionId, SESSION_A);

  // Explicit selection of the held session says the same thing.
  const explicit = planAgentSessionSelection(agentSessionInput([held], { agentSessionId: SESSION_B }));
  assert.equal(explicit.reason, "already-attached");
  assert.equal(explicit.holder, holder);

  // Terminal state is judged before the seat: a terminated session with a
  // stale holder is not "already attached", it is not reusable.
  const dead = agentSession({ id: SESSION_C, processState: "terminated", attachment: "attached", attachmentHolder: holder });
  assert.equal(planAgentSessionSelection(agentSessionInput([dead])).reason, "no-compatible-candidate");
  assert.equal(planAgentSessionSelection(agentSessionInput([dead], { agentSessionId: SESSION_C })).reason, "state-not-reusable");
});

test("an unobservable seat is named as such on both the automatic and the explicit path", () => {
  const unobservable = agentSession({ id: SESSION_B, attachment: "unknown" });
  const automatic = planAgentSessionSelection(agentSessionInput([unobservable]));
  assert.deepEqual(automatic, {
    kind: "unavailable",
    target: "agent-session",
    targetId: SESSION_B,
    reason: "attachment-unobservable",
  });
  const explicit = planAgentSessionSelection(agentSessionInput([unobservable], { agentSessionId: SESSION_B }));
  assert.equal(explicit.reason, "attachment-unobservable");
  assert.equal(explicit.targetId, SESSION_B);
});

test("a holder reported beside a seat that is not held is invalid authority data", () => {
  for (const attachment of ["detached", "unknown"]) {
    const plan = planAgentSessionSelection(
      agentSessionInput([agentSession({ attachment, attachmentHolder: "cli:x" })]),
    );
    assert.equal(plan.reason, "authority-data-invalid", attachment);
  }
  const unsafe = planAgentSessionSelection(
    agentSessionInput([agentSession({ attachment: "attached", attachmentHolder: "cli\u0007bell" })]),
  );
  assert.equal(unsafe.reason, "authority-data-invalid");
});

test("the central journey planner never evaluates AgentSessions until one machine is selected", () => {
  const machineAmbiguity = planJourneySelection({
    machine: machineInput([
      machine({ id: MACHINE_A }),
      machine({ id: MACHINE_B }),
    ]),
    agentSession: {
      ...agentSessionInput([agentSession()]),
      agentSessions: [agentSession()],
    },
  });
  assert.equal(machineAmbiguity.kind, "ambiguous");
  assert.equal(machineAmbiguity.target, "machine");

  const sessionPlan = planJourneySelection({
    machine: machineInput([machine()]),
    agentSession: {
      requestedAgent: "claude-code",
      workspaceIdentity: WORKSPACE,
      workspaceGeneration: 7,
      cwd: "services/api",
      authMode: "interactive_login",
      forceNewSession: false,
      collectionFreshness: "fresh",
      agentSessions: [agentSession()],
    },
  });
  assert.equal(sessionPlan.kind, "select");
  assert.equal(sessionPlan.target, "agent-session");
  assert.equal(sessionPlan.machineId, MACHINE_A);
});
