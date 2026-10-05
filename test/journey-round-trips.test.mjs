import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { createApiTerminalControlPlane } from "../dist/runtime/api-terminal-control-plane.js";
import { CunaRuntimeBoundary } from "../dist/runtime/boundary.js";
import { encodeTerminalControl, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";

/*
 * Round trips a new session's journey no longer spends. Measured 2026-09-30
 * against Edge v242 on Machine cd0696a7 (_meta_audit/2026-09-30-journey-speed):
 * every attach read `GET /v1/me` three times and ran each admission's reads
 * one after another; the create re-read the Machine capability selection had
 * just read; and the readiness loop slept 1.6 s between reads. Each behaviour
 * test below fails on c0dc53b; each control passes on both.
 */

const NOW = 1_800_000_000_000;
const SESSION = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";
const TERMINAL = "terminal_connections.create";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function snapshot(scope, subjectId, id, expiresInMs = 30_000, now = NOW) {
  return {
    schemaVersion: "1.0", subjectScope: scope, subjectId,
    observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + expiresInMs).toISOString(),
    etag: `etag-${subjectId}`,
    capabilities: [{ id, availability: "supported", interaction: id === "agent_sessions.workspace.read" ? "read_only" : "native",
      mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: [] }],
  };
}

function row(overrides = {}) {
  return {
    id: SESSION, machineId: MACHINE, name: "opencode", agent: "opencode",
    cwd: "/workspace/workspaces/33333333-3333-4333-8333-333333333333",
    authMode: "interactive_login", desiredState: "running", requestState: "launched", processState: "running",
    processEpoch: "44444444-4444-4444-8444-444444444444",
    runtimeObservedAt: new Date(NOW - 100).toISOString(), runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 3, createdAt: new Date(NOW - 20_000).toISOString(), ...overrides,
  };
}

function apiClient(events) {
  return {
    async getIdentity() { events.push("me"); return { id: "user-1", workspaceAssigned: true }; },
    async getAgentSession(id) { events.push("session:start"); await tick(); events.push("session:end"); return row({ id }); },
    async discoverCapabilities(scope, id) { events.push(`capability:${scope}`); return snapshot(scope, id, "agent_sessions.workspace.read"); },
    async getAgentSessionWorkspaceContext(id) {
      events.push("context");
      return { agentSessionId: id, machineId: MACHINE, executionWorkspaceId: "33333333-3333-4333-8333-333333333333",
        workspaceGeneration: 1, remoteRoot: "/workspace/workspaces/33333333-3333-4333-8333-333333333333" };
    },
  };
}

test("one attach reads its principal once, however often it observes its session", async () => {
  const events = [];
  const plane = createApiTerminalControlPlane({ client: apiClient(events), clock: () => NOW });
  for (let round = 0; round < 3; round += 1) await plane.observeAgentSession(SESSION);
  assert.equal(events.filter((event) => event === "me").length, 1);
});

test("a session already known to run in a Workspace is asked for it beside its row", async () => {
  const events = [];
  const plane = createApiTerminalControlPlane({ client: apiClient(events), clock: () => NOW });
  await plane.observeAgentSession(SESSION);
  events.length = 0;
  await plane.observeAgentSession(SESSION);
  assert.ok(events.indexOf("capability:agent_session") < events.indexOf("session:end"),
    `the Workspace read leaves before the row answers: ${events.join(" ")}`);
  assert.ok(events.indexOf("capability:agent_session") < events.indexOf("context"), "its capability is still read before the context");
});

class Wire {
  constructor(id, ready) {
    this.connectionId = id;
    this.queue = [ready];
    this.waiters = [];
    this.closed = false;
  }
  receive() {
    return { [Symbol.asyncIterator]: () => ({
      next: () => this.queue.length > 0 ? Promise.resolve({ done: false, value: this.queue.shift() })
        : this.closed ? Promise.resolve({ done: true, value: undefined })
          : new Promise((resolve) => this.waiters.push(resolve)),
    }) };
  }
  async send() {}
  async close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }); }
}

function terminalFakes(events) {
  const epoch = "44444444-4444-4444-8444-444444444444";
  const observation = () => ({ authority: "cuna_agent_session_supervisor", userId: "user-1", machineId: MACHINE,
    agentSessionId: SESSION, processEpoch: epoch, workspaceBindingId: null, workspaceBindingGeneration: null, state: "running",
    observedAt: new Date(NOW - 100).toISOString(), expiresAt: new Date(NOW + 30_000).toISOString(), evidenceRevision: "row:3" });
  const grant = {
    terminalSessionId: "55555555-5555-4555-8555-555555555555", resumeHandle: "66666666-6666-4666-8666-666666666666",
    connectUrl: "wss://api.getcuna.com/v1/terminal-connections/55555555-5555-4555-8555-555555555555/stream",
    connectToken: `runa_tc_${"A".repeat(43)}`, protocol: TERMINAL_PROTOCOL,
    capabilities: ["acknowledgement", "heartbeat", "live_resize", "resume", "signals"].map((name) => ({ name, availability: "supported" })),
    expiresAt: new Date(NOW + 30_000).toISOString(), agentSessionId: SESSION, processEpoch: epoch, attachmentGeneration: 1,
  };
  return {
    observation,
    controlPlane: {
      async discoverCapabilities(_scope, id) { events.push("capability:start"); await tick(); events.push("capability:end"); return snapshot("agent_session", id, TERMINAL); },
      async observeAgentSession() { events.push("observe:start"); await tick(); return observation(); },
      async createTerminalConnection() { events.push("grant"); return grant; },
      async cancelTerminalConnection() { return { cancelled: true }; },
    },
    connector: {
      async connect() {
        events.push("connect");
        return new Wire(grant.terminalSessionId, encodeTerminalControl("ready", 1n, { protocol: TERMINAL_PROTOCOL,
          agentSessionId: SESSION, processEpoch: epoch, fencingGeneration: 1, resizeCapability: "live", accessMode: "writer", writerEpoch: 1 }));
      },
    },
  };
}

function runtimeFor(fakes) {
  const runtime = new CunaRuntimeBoundary({
    controlPlane: fakes.controlPlane, terminalConnector: fakes.connector, allowedCunaOrigins: ["https://api.getcuna.com"],
    terminalCapabilityId: TERMINAL, clientInstanceId: "client-1", clock: () => NOW, readyTimeoutMs: 1_000,
  });
  runtime.start({ endpointOwnership: "verified", durableState: "verified", source: "test", observedAt: NOW - 1, expiresAt: NOW + 60_000 });
  return runtime;
}

test("an admission asks for its capability and its session together, before and after the grant", async () => {
  const events = [];
  const fakes = terminalFakes(events);
  const runtime = runtimeFor(fakes);
  await runtime.attach({ tabId: "tab-1", agentSessionId: SESSION, columns: 80, rows: 24 });
  const grant = events.indexOf("grant");
  const before = events.slice(0, grant), after = events.slice(grant + 1, events.indexOf("connect"));
  for (const [phase, reads] of [["pre-grant", before], ["post-grant", after]]) {
    assert.ok(reads.includes("observe:start") && reads.includes("capability:end"), `${phase} reads both: ${events.join(" ")}`);
    assert.ok(reads.indexOf("observe:start") < reads.indexOf("capability:end"), `${phase} reads them together: ${events.join(" ")}`);
  }
  await runtime.shutdown();
});

test("a refused capability still decides the admission: no grant, whatever the session read says", async () => {
  const events = [];
  const fakes = terminalFakes(events);
  fakes.controlPlane.discoverCapabilities = async (_scope, id) => {
    events.push("capability:start");
    return { ...snapshot("agent_session", id, TERMINAL), capabilities: [{ ...snapshot("agent_session", id, TERMINAL).capabilities[0], availability: "unsupported" }] };
  };
  const runtime = runtimeFor(fakes);
  await assert.rejects(runtime.attach({ tabId: "tab-1", agentSessionId: SESSION, columns: 80, rows: 24 }), /unsupported/u);
  assert.equal(events.includes("grant"), false);
  await runtime.shutdown();
});

async function selectThenCreate(clockAfterSelection) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cuna-round-trips-"));
  let now = NOW;
  let machineReads = 0;
  const execution = "33333333-3333-4333-8333-333333333333";
  const workspace = { bindingId: "b", workspaceIdentity: "b", executionWorkspaceId: execution, generation: 1, remoteCwd: `/workspace/workspaces/${execution}` };
  const effects = createApiAgentJourneyEffects({
    client: {
      async listMachines() { return { items: [{ id: MACHINE, name: "qa", state: "running", agent: "opencode" }] }; },
      async discoverCapabilities(scope) { if (scope === "machine") machineReads += 1; return snapshot("machine", MACHINE, "agent_sessions.create", 30_000, now); },
      async createProviderSessionV2() { return { agentSession: row({ cwd: workspace.remoteCwd, workspaceBindingId: undefined, workspaceGeneration: undefined, requestState: "launch_pending" }) }; },
    },
    requestedAgent: "opencode",
    providerLaunchState: { stateDirectory, ownerId: "owner", workspaceId: "account" },
    async inspectWorkspace() { return { canonicalLocalRoot: "x" }; },
    async synchronizeWorkspace() { return workspace; },
    async attach() {},
    async authorizeMachineCreate() { return false; },
    selectProviderPreset: async () => ({ kind: "provider_preset", agent: "opencode", label: "Default", profile_id: "55555555-5555-4555-8555-555555555555", profile_revision: 2 }),
    now: () => now,
    async sleep() {},
  });
  try {
    await effects.observeMachines({ requestedAgent: "opencode", signal: new AbortController().signal });
    now = clockAfterSelection;
    await effects.createAgentSession({ machineId: MACHINE, agent: "opencode", authMode: "interactive_login", workspace, idempotencyKey: "k", signal: new AbortController().signal });
    return machineReads;
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

test("the create gate uses the Machine capability selection has just read", async () => {
  assert.equal(await selectThenCreate(NOW + 3_000), 1);
});

test("a selection snapshot past its lease is read again before the create", async () => {
  assert.equal(await selectThenCreate(NOW + 31_000), 2);
});

async function readinessPauses(startingReads) {
  const pauses = [];
  let reads = 0;
  let now = NOW;
  const effects = createApiAgentJourneyEffects({
    client: {
      async getAgentSession() { reads += 1; return row({ processState: reads <= startingReads ? "starting" : "running", requestState: "launch_pending" }); },
      async discoverCapabilities(scope, id) { return snapshot(scope, id, TERMINAL, 30_000, now); },
    },
    requestedAgent: "opencode",
    async inspectWorkspace() { throw new Error("unused"); },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() {},
    async authorizeMachineCreate() { return false; },
    now: () => now,
    async sleep(ms) { pauses.push(ms); now += ms; },
  });
  await effects.ensureAgentSessionReady({ agentSessionId: SESSION, signal: new AbortController().signal });
  return pauses;
}

test("a starting session is read at least every half second while its launch is expected", async () => {
  const pauses = await readinessPauses(8);
  assert.equal(pauses.length, 8);
  assert.ok(Math.max(...pauses) <= 500, `pauses: ${pauses.join(", ")}`);
});

test("a launch still starting after thirty seconds returns to the slower cadence", async () => {
  const pauses = await readinessPauses(80);
  let elapsed = 0;
  const late = pauses.filter((pause) => { const inWindow = elapsed < 30_000; elapsed += pause; return !inWindow; });
  assert.ok(late.length > 0 && late.every((pause) => pause === 1_600), `late pauses: ${late.join(", ")}`);
});
