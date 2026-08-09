import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeTerminalFrame, encodeTerminalControl, encodeTerminalFrame, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";
import { requireVerifiedPtyAdapter } from "../dist/pty/evidence-gate.js";
import { createNodeProcessAdapter } from "../dist/pty/node-process.js";
import { admitCapability } from "../dist/runtime/capability-gate.js";
import { RunaRuntimeBoundary } from "../dist/runtime/boundary.js";
import { RuntimeBoundaryError } from "../dist/runtime/errors.js";
import { createUnavailableTerminalControlPlane, validateTerminalGrant } from "../dist/runtime/terminal-transport.js";

const NOW = 1_800_000_000_000;
const CAPABILITY_ID = "terminal_connections.create";
const API_ORIGIN = "https://api.runacode.io";

function capabilitySnapshot(agentSessionId, overrides = {}) {
  return {
    schemaVersion: "1",
    subjectScope: "agent_session",
    subjectId: agentSessionId,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    etag: `etag-${agentSessionId}`,
    capabilities: [{
      id: CAPABILITY_ID,
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["terminal.connect"],
    }],
    ...overrides,
  };
}

function observation(agentSessionId, processEpoch = `epoch-${agentSessionId}`) {
  return {
    authority: "runa_agent_session_supervisor",
    userId: "user-1",
    machineId: "machine-1",
    agentSessionId,
    processEpoch,
    state: "running",
    observedAt: new Date(NOW - 500).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
    evidenceRevision: `revision-${agentSessionId}`,
  };
}

class AsyncByteQueue {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class FakeWireConnection {
  constructor(id, initialBytes) {
    this.connectionId = id;
    this.incoming = new AsyncByteQueue();
    this.sent = [];
    this.closeCalls = [];
    if (initialBytes !== undefined) this.incoming.push(initialBytes);
  }

  receive() { return this.incoming; }
  async send(bytes) { this.sent.push(bytes); }
  async close(input) {
    this.closeCalls.push(input);
    this.incoming.close();
  }
}

class FakeTerminalSystem {
  constructor() {
    this.grants = new Map();
    this.connections = [];
    this.createCalls = [];
    this.connectCalls = [];
    this.epochs = new Map();
    this.generation = 0;
    this.outputOnReady = new Map();
    this.connectionsWithoutReady = new Set();
    this.connector = {
      connect: async (input) => {
        this.connectCalls.push({ ...input, token: "redacted-by-test" });
        const grant = this.grants.get(input.token);
        assert.ok(grant, "connector receives a producer-issued token");
        const ready = encodeTerminalControl("ready", 1n, {
          protocol: TERMINAL_PROTOCOL,
          agentSessionId: grant.agentSessionId,
          processEpoch: grant.processEpoch,
          fencingGeneration: grant.attachmentGeneration,
          resizeCapability: "live",
        });
        const output = this.outputOnReady.get(grant.agentSessionId);
        let initial = this.connectionsWithoutReady.has(this.connections.length + 1) ? undefined : ready;
        if (output !== undefined) {
          const frame = encodeTerminalFrame({ type: "output", critical: true, sequence: 1n, payload: output });
          if (initial !== undefined) {
            initial = new Uint8Array(ready.byteLength + frame.byteLength);
            initial.set(ready);
            initial.set(frame, ready.byteLength);
          }
        }
        const connection = new FakeWireConnection(grant.terminalSessionId, initial);
        this.connections.push(connection);
        return connection;
      },
    };
    this.controlPlane = {
      discoverCapabilities: async (_scope, resourceId) => capabilitySnapshot(resourceId),
      observeAgentSession: async (agentSessionId) => observation(agentSessionId, this.epochs.get(agentSessionId)),
      createTerminalConnection: async (input) => {
        this.createCalls.push(input);
        this.generation += 1;
        const observed = observation(input.agentSessionId, this.epochs.get(input.agentSessionId));
        const terminalSessionId = `00000000-0000-4000-8000-${String(this.generation).padStart(12, "0")}`;
        const token = `runa_tc_${"A".repeat(42)}${this.generation}`;
        const grant = {
          terminalSessionId,
          resumeHandle: "66666666-6666-4666-8666-666666666666",
          connectUrl: `wss://api.runacode.io/v1/terminal-connections/${terminalSessionId}/stream`,
          connectToken: token,
          protocol: TERMINAL_PROTOCOL,
          capabilities: [
            { name: "acknowledgement", availability: "supported" },
            { name: "heartbeat", availability: "supported" },
            { name: "live_resize", availability: "supported" },
            { name: "resume", availability: "supported" },
            { name: "signals", availability: "supported" },
          ],
          expiresAt: new Date(NOW + 30_000).toISOString(),
          agentSessionId: observed.agentSessionId,
          processEpoch: observed.processEpoch,
          attachmentGeneration: this.generation,
        };
        this.grants.set(token, grant);
        return grant;
      },
    };
  }
}

function createRuntime(system, extra = {}) {
  const states = [];
  const outputs = [];
  const runtime = new RunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedRunaOrigins: [API_ORIGIN],
    terminalCapabilityId: CAPABILITY_ID,
    clientInstanceId: "client-1",
    clock: () => NOW,
    idempotencyKey: (() => {
      let value = 0;
      return () => `idempotency-${++value}`;
    })(),
    readyTimeoutMs: 1_000,
    onTerminalState: (state) => states.push(state),
    onTerminalOutput: (event) => outputs.push(event),
    ...extra,
  });
  runtime.start({
    endpointOwnership: "verified",
    durableState: "verified",
    source: "test-independent-local-probe",
    observedAt: NOW - 1,
    expiresAt: NOW + 60_000,
  });
  return { runtime, states, outputs };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

test("runtime capability admission fails closed for expired, ambiguous, and non-native evidence", () => {
  assert.throws(
    () => admitCapability(capabilitySnapshot("agent-1", { expiresAt: new Date(NOW).toISOString() }), {
      id: CAPABILITY_ID,
      scope: "agent_session",
      subjectId: "agent-1",
      interaction: "native",
    }, NOW),
    (error) => error instanceof RuntimeBoundaryError && error.code === "capability_snapshot_expired",
  );
  const ambiguous = capabilitySnapshot("agent-1");
  ambiguous.capabilities.push({ ...ambiguous.capabilities[0] });
  assert.throws(
    () => admitCapability(ambiguous, { id: CAPABILITY_ID, scope: "agent_session", subjectId: "agent-1" }, NOW),
    (error) => error instanceof RuntimeBoundaryError && error.code === "capability_unknown",
  );
  const browserOnly = capabilitySnapshot("agent-1");
  browserOnly.capabilities[0] = { ...browserOnly.capabilities[0], interaction: "browser_handoff" };
  assert.throws(
    () => admitCapability(browserOnly, {
      id: CAPABILITY_ID,
      scope: "agent_session",
      subjectId: "agent-1",
      interaction: "native",
    }, NOW),
    (error) => error instanceof RuntimeBoundaryError && error.code === "capability_unsupported",
  );
});

test("terminal grants reject non-Runa origins, query secrets, and incomplete capability evidence", () => {
  const terminalSessionId = "55555555-5555-4555-8555-555555555555";
  const valid = {
    terminalSessionId,
    resumeHandle: "66666666-6666-4666-8666-666666666666",
    connectUrl: `wss://api.runacode.io/v1/terminal-connections/${terminalSessionId}/stream`,
    connectToken: `runa_tc_${"A".repeat(43)}`,
    protocol: TERMINAL_PROTOCOL,
    capabilities: [
      { name: "acknowledgement", availability: "supported" },
      { name: "heartbeat", availability: "supported" },
      { name: "live_resize", availability: "supported" },
      { name: "resume", availability: "supported" },
      { name: "signals", availability: "supported" },
    ],
    expiresAt: new Date(NOW + 30_000).toISOString(),
  };
  assert.equal(validateTerminalGrant({
    grant: valid,
    allowedRunaOrigins: [API_ORIGIN],
    requiredCapabilities: ["acknowledgement", "heartbeat"],
    now: NOW,
  }), valid);
  for (const grant of [
    { ...valid, connectUrl: `wss://evil.example/v1/terminal-connections/${terminalSessionId}/stream` },
    { ...valid, connectUrl: `${valid.connectUrl}?token=${valid.connectToken}` },
    { ...valid, capabilities: valid.capabilities.slice(0, 4) },
  ]) {
    assert.throws(
      () => validateTerminalGrant({
        grant,
        allowedRunaOrigins: [API_ORIGIN],
        requiredCapabilities: ["acknowledgement", "heartbeat"],
        now: NOW,
      }),
      RuntimeBoundaryError,
    );
  }
});

test("runtime multiplexes AgentSessions without cross-routing input and preserves post-ready output in one chunk", async () => {
  const system = new FakeTerminalSystem();
  system.outputOnReady.set("agent-a", new TextEncoder().encode("first-output"));
  const { runtime, outputs } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await runtime.attach({ tabId: "tab-b", agentSessionId: "agent-b", columns: 80, rows: 24 });
  assert.equal(outputs.length, 1, "output adjacent to ready is not dropped");
  assert.equal(new TextDecoder().decode(outputs[0].bytes), "first-output");

  await runtime.sendInput(new TextEncoder().encode("to-a"));
  runtime.switchActive("tab-b");
  await runtime.sendInput(new TextEncoder().encode("to-b"));

  const firstSent = system.connections[0].sent.map(decodeTerminalFrame).filter(Boolean);
  const secondSent = system.connections[1].sent.map(decodeTerminalFrame).filter(Boolean);
  assert.deepEqual(firstSent.filter((frame) => frame.type === "input").map((frame) => new TextDecoder().decode(frame.payload)), ["to-a"]);
  assert.deepEqual(secondSent.filter((frame) => frame.type === "input").map((frame) => new TextDecoder().decode(frame.payload)), ["to-b"]);
  assert.notEqual(runtime.listTerminals()[0].viewId, runtime.listTerminals()[1].viewId);
  await runtime.shutdown();
});

test("concurrent terminal input, resize, and signal writes remain serialized and monotonic", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const connection = system.connections[0];
  let inFlight = 0;
  let peakInFlight = 0;
  connection.send = async (bytes) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    connection.sent.push(bytes);
    inFlight -= 1;
  };

  await Promise.all([
    runtime.sendInput(new TextEncoder().encode("first"), "tab-a"),
    runtime.resize(100, 30, "tab-a"),
    runtime.signal("interrupt", "tab-a"),
  ]);

  const frames = connection.sent.map(decodeTerminalFrame);
  assert.equal(peakInFlight, 1);
  assert.deepEqual(frames.map((frame) => frame.sequence), [1n, 2n, 3n]);
  assert.deepEqual(frames.map((frame) => frame.type), ["input", "resize", "signal"]);
  await runtime.shutdown();
});

test("terminal-generated responses require the exact tab authority and never follow active-tab focus", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  const first = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await runtime.attach({ tabId: "tab-b", agentSessionId: "agent-b", columns: 80, rows: 24 });
  runtime.switchActive("tab-b");
  const response = {
    tabId: "tab-a",
    binding: {
      userId: "user-1",
      machineId: first.machineId,
      agentSessionId: first.agentSessionId,
      processEpoch: first.processEpoch,
      fencingGeneration: first.fencingGeneration,
    },
    bytes: new TextEncoder().encode("\u001b[1;1R"),
  };
  await runtime.sendTerminalResponse(response);

  const firstInput = system.connections[0].sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input");
  const secondInput = system.connections[1].sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input");
  assert.equal(firstInput.length, 1);
  assert.equal(secondInput.length, 0);

  for (const invalid of [
    { ...response, binding: { ...response.binding, userId: "user-sibling" } },
    { ...response, binding: { ...response.binding, agentSessionId: "agent-b" } },
    { ...response, binding: { ...response.binding, processEpoch: "stale-epoch" } },
    { ...response, binding: { ...response.binding, fencingGeneration: first.fencingGeneration + 1 } },
  ]) {
    await assert.rejects(
      runtime.sendTerminalResponse(invalid),
      (error) => error instanceof RuntimeBoundaryError && error.code === "grant_scope_mismatch",
    );
  }
  assert.equal(system.connections[0].sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input").length, 1);
  assert.equal(system.connections[1].sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input").length, 0);
  await runtime.shutdown();
});

test("runtime reconnect obtains a fresh grant, preserves process epoch, and never reuses the old token", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");
  const reconnected = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(reconnected.state, "active");
  assert.equal(reconnected.outputContinuity, "unknown", "continuity remains unknown until producer resume evidence arrives");
  assert.equal(system.createCalls.length, 2);
  assert.equal(system.createCalls[1].resumeHandle, "66666666-6666-4666-8666-666666666666");
  assert.notEqual(system.connections[0].connectionId, system.connections[1].connectionId);
  assert.equal(system.connectCalls.length, 2);
  await runtime.shutdown();
});

test("a transient reconnect handshake timeout preserves the old view authority for a later retry", async () => {
  const system = new FakeTerminalSystem();
  system.connectionsWithoutReady.add(2);
  const { runtime } = createRuntime(system, { readyTimeoutMs: 5 });
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");

  await assert.rejects(
    runtime.reconnect({ tabId: "tab-a" }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_timeout",
  );
  const afterTimeout = runtime.listTerminals()[0];
  assert.equal(afterTimeout.state, "interrupted");
  assert.equal(afterTimeout.viewId, attached.viewId, "an unproven attachment cannot replace the active view authority");
  assert.equal(afterTimeout.outputContinuity, "unknown");

  const retried = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(retried.state, "active");
  assert.notEqual(retried.viewId, attached.viewId);
  assert.equal(retried.outputContinuity, "unknown");
  assert.equal(system.createCalls.length, 3);
  await runtime.shutdown();
});

test("runtime rejects reconnect to a replacement process before issuing a second grant", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");
  system.epochs.set("agent-a", "replacement-epoch");
  await assert.rejects(
    runtime.reconnect({ tabId: "tab-a" }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "session_discontinuous",
  );
  assert.equal(system.createCalls.length, 1, "no new connection grant is issued for a replacement process");
  await runtime.shutdown();
});

test("missing remote AgentSession producer fails before opening a terminal", async () => {
  let connectorCalls = 0;
  const system = {
    controlPlane: createUnavailableTerminalControlPlane(),
    connector: { connect: async () => { connectorCalls += 1; throw new Error("must not run"); } },
  };
  const { runtime } = createRuntime(system);
  await assert.rejects(
    runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "control_plane_unavailable",
  );
  assert.equal(connectorCalls, 0);
  await runtime.shutdown();
});

test("PTY adapter is usable only with current platform-bound live evidence", async () => {
  const adapter = {
    probe: async () => ({
      status: "verified",
      adapterId: "test-pty",
      protocol: "runa.local-pty.v1",
      platform: process.platform,
      observedAt: NOW - 100,
      expiresAt: NOW + 10_000,
      artifactDigest: `sha256:${"a".repeat(64)}`,
      capabilities: { rawInput: true, resize: true, signals: true, utf8: true },
    }),
    spawn: () => { throw new Error("not used by this gate test"); },
  };
  const verified = await requireVerifiedPtyAdapter({ adapter, now: NOW, platform: process.platform });
  assert.equal(verified.evidence.status, "verified");
  const expired = { ...adapter, probe: async () => ({ ...(await adapter.probe()), expiresAt: NOW }) };
  await assert.rejects(
    requireVerifiedPtyAdapter({ adapter: expired, now: NOW, platform: process.platform }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "pty_evidence_invalid",
  );
});

test("Node process adapter executes argv without a shell and excludes credential-shaped environment", async () => {
  const adapter = createNodeProcessAdapter();
  const child = adapter.spawn({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({value:'ok',secret:process.env.RUNA_API_KEY??null}))"],
  });
  let stdout = "";
  for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  const exit = await child.wait();
  assert.equal(exit.exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), { value: "ok", secret: null });
  assert.throws(
    () => adapter.spawn({ executable: process.execPath, args: ["-e", ""], environment: { RUNA_API_KEY: "must-not-pass" } }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "process_invalid",
  );
});

test("runtime sync boundary acquires one durable journal writer and begins in reconciliation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runa-runtime-sync-"));
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  try {
    const configuration = {
      bindingId: "binding-1",
      bindingGeneration: 1,
      canonicalRoot: path.join(directory, "workspace"),
      policyDigest: `sha256:${"b".repeat(64)}`,
      epoch: "epoch-1",
    };
    const handle = await runtime.openSync({
      configuration,
      journalDirectory: path.join(directory, "journal"),
      ownerId: "runtime-owner-1",
    });
    assert.ok(handle.fence >= 1);
    assert.equal(handle.supervisor.snapshot.state, "reconciling");
    assert.equal(handle.supervisor.snapshot.incrementalApplyPaused, true);
    await assert.rejects(
      runtime.openSync({
        configuration,
        journalDirectory: path.join(directory, "journal"),
        ownerId: "runtime-owner-2",
      }),
      (error) => error instanceof RuntimeBoundaryError && error.code === "session_conflict",
    );
    await handle.close();
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime startup rejects unverified local endpoint evidence", () => {
  const system = new FakeTerminalSystem();
  const runtime = new RunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedRunaOrigins: [API_ORIGIN],
    terminalCapabilityId: CAPABILITY_ID,
    clientInstanceId: "client-1",
    clock: () => NOW,
  });
  assert.throws(
    () => runtime.start({
      endpointOwnership: "unverified",
      durableState: "verified",
      source: "self-report",
      observedAt: NOW - 1,
      expiresAt: NOW + 1,
    }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "remote_state_unproven",
  );
  assert.equal(runtime.daemon.state, "recovery_required");
});

test("runtime startup evidence expiry revokes readiness before later mutations", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  const runtime = new RunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedRunaOrigins: [API_ORIGIN],
    terminalCapabilityId: CAPABILITY_ID,
    clientInstanceId: "client-1",
    clock: () => now,
  });
  runtime.start({
    endpointOwnership: "verified",
    durableState: "verified",
    source: "independent-live-probe",
    observedAt: NOW - 1,
    expiresAt: NOW + 1,
  });
  now = NOW + 1;
  await assert.rejects(
    runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "remote_state_unproven",
  );
  assert.equal(runtime.daemon.state, "recovery_required");
  assert.equal(system.createCalls.length, 0);
  await runtime.shutdown();
});
