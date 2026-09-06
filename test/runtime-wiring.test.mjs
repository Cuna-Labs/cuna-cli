import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

import { decodeTerminalControl, decodeTerminalFrame, encodeTerminalControl, encodeTerminalFrame, TERMINAL_PROTOCOL, TerminalProtocolError } from "../dist/terminal/codec.js";
import { requireVerifiedPtyAdapter } from "../dist/pty/evidence-gate.js";
import { createNodeProcessAdapter } from "../dist/pty/node-process.js";
import { createApiTerminalControlPlane } from "../dist/runtime/api-terminal-control-plane.js";
import { admitCapability } from "../dist/runtime/capability-gate.js";
import { CunaRuntimeBoundary } from "../dist/runtime/boundary.js";
import { RuntimeBoundaryError } from "../dist/runtime/errors.js";
import { DurableSyncJournal } from "../dist/sync/journal.js";
import { createUnavailableTerminalControlPlane, validateTerminalGrant } from "../dist/runtime/terminal-transport.js";

const NOW = 1_800_000_000_000;
const CAPABILITY_ID = "terminal_connections.create";
const API_ORIGIN = "https://api.getcuna.com";

/**
 * Temporary trees go through the owned-temp authority, never a bare
 * `rm(recursive)`.
 *
 * On Windows, unlinking a file whose handle is still open leaves a
 * delete-pending entry: it disappears from `readdir` but keeps the parent
 * directory un-removable, so `rmdir` fails ENOTEMPTY on a directory that reads
 * as empty. The two journal tests below used a bare `rm` and failed that way
 * roughly one run in four under parallel load -- measured here as
 * `code=ENOTEMPTY remaining=[] recoveredAfterMs=2`. Because `prepack` is
 * `typecheck && test`, that made `npm pack` and `npm publish` fail at random
 * from a Windows machine.
 *
 * `removeOwnedTempDirectory` already retries (maxRetries 3, retryDelay 100) and
 * seven other test files in this repository already pass the same options
 * inline. These two sites were the only ones that did not.
 */
const resources = new TestResourceLedger();
test.after(() => resources.cleanup());

function capabilitySnapshot(agentSessionId, overrides = {}) {
  return {
    schemaVersion: "1.0",
    subjectScope: "agent_session",
    subjectId: agentSessionId,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 59_000).toISOString(),
    etag: `etag-${agentSessionId}`,
    capabilities: [CAPABILITY_ID, "terminal_writers.transfer"].map(id => ({
      id,
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["terminal.connect"],
    })),
    ...overrides,
  };
}

function observation(agentSessionId, processEpoch = `epoch-${agentSessionId}`) {
  return {
    authority: "cuna_agent_session_supervisor",
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
  constructor(id, initialBytes, onSend) {
    this.connectionId = id;
    this.incoming = new AsyncByteQueue();
    this.sent = [];
    this.closeCalls = [];
    this.onSend = onSend;
    if (initialBytes !== undefined) this.incoming.push(initialBytes);
  }

  receive() { return this.incoming; }
  async send(bytes) {
    this.sent.push(bytes);
    await this.onSend?.(bytes);
  }
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
    // The seat READY announces per AgentSession; a writer at epoch 1 unless a
    // test says the terminal is already held.
    this.seatOnReady = new Map();
    this.outputSequenceOnReady = new Map();
    this.retainedOutputOnResume = new Map();
    this.connectionsWithoutReady = new Set();
    this.connector = {
      connect: async (input) => {
        this.connectCalls.push({ ...input, token: "redacted-by-test" });
        const grant = this.grants.get(input.token);
        assert.ok(grant, "connector receives a producer-issued token");
        const ready = encodeTerminalControl("ready", 1n, {
          ...(this.canonicalViews ? { terminalViewProtocol: { name: "cuna.terminal-view.v1", operation: "new", history: "current_view" } } : {}),
          protocol: TERMINAL_PROTOCOL,
          agentSessionId: grant.agentSessionId,
          processEpoch: grant.processEpoch,
          fencingGeneration: grant.attachmentGeneration,
          resizeCapability: "live",
          accessMode: this.seatOnReady.get(grant.agentSessionId)?.accessMode ?? "writer",
          writerEpoch: this.seatOnReady.get(grant.agentSessionId)?.writerEpoch ?? 1,
        });
        const output = this.outputOnReady.get(grant.agentSessionId);
        let initial = this.connectionsWithoutReady.has(this.connections.length + 1) ? undefined : ready;
        if (output !== undefined) {
          const frame = encodeTerminalFrame({
            type: "output",
            critical: true,
            sequence: this.outputSequenceOnReady.get(grant.agentSessionId) ?? 1n,
            payload: output,
          });
          if (initial !== undefined) {
            initial = new Uint8Array(ready.byteLength + frame.byteLength);
            initial.set(ready);
            initial.set(frame, ready.byteLength);
          }
        }
        if (initial !== undefined && this.extraFramesOnReady !== undefined) initial = Buffer.concat([initial, ...this.extraFramesOnReady]);
        let connection;
        connection = new FakeWireConnection(grant.terminalSessionId, initial, async (bytes) => {
          if (decodeTerminalFrame(bytes)?.type !== "resume") return;
          const retained = this.retainedOutputOnResume.get(grant.agentSessionId);
          if (retained === undefined) return;
          connection.incoming.push(encodeTerminalFrame({
            type: "output",
            critical: true,
            sequence: 1n,
            payload: retained,
          }));
        });
        this.connections.push(connection);
        return connection;
      },
    };
    this.controlPlane = {
      discoverCapabilities: async (_scope, resourceId) => capabilitySnapshot(resourceId),
      cancelTerminalConnection: async () => ({ cancelled: true }),
      observeAgentSession: async (agentSessionId) => observation(agentSessionId, this.epochs.get(agentSessionId)),
      createTerminalConnection: async (input) => {
        this.createCalls.push(input);
        this.generation += 1;
        const observed = observation(input.agentSessionId, this.epochs.get(input.agentSessionId));
        const terminalSessionId = `00000000-0000-4000-8000-${String(this.generation).padStart(12, "0")}`;
        const token = `runa_tc_${"A".repeat(40)}${String(this.generation).padStart(3, "0")}`;
        const resumeHandle = this.generation === 1
          ? "66666666-6666-4666-8666-666666666666"
          : `66666666-6666-4666-8666-${String(this.generation).padStart(12, "0")}`;
        const grant = {
          terminalSessionId,
          resumeHandle,
          connectUrl: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
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
  const runtime = new CunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedCunaOrigins: [API_ORIGIN],
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

function geometryWire(payload, critical=false) {
  const bytes=encodeTerminalControl("heartbeat",999n,payload);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  view.setUint16(6,18,false);view.setUint8(5,critical?1:0);return bytes;
}

const VIEW_ID = "11111111-2222-4333-8444-555555555555";
const viewStart = (id = VIEW_ID) => encodeTerminalControl("view_started", 0n, { protocol: "cuna.terminal-view.v1", operation: "new", viewId: id, columns: 80, rows: 24 });
const viewReady = (sequence = "1", id = VIEW_ID) => encodeTerminalControl("view_ready", 0n, { viewId: id, afterOutputSequence: sequence });
const viewOutput = (sequence = 1n) => encodeTerminalFrame({ type: "output", critical: true, sequence, payload: new TextEncoder().encode("CURRENT") });

test("canonical view waits for reset and rendered boundary, then reconnect starts at one", async () => {
  const system = new FakeTerminalSystem(); system.canonicalViews = true;
  let release; let resetEntered = false;
  const resetGate = new Promise(resolve => { release = resolve; });
  const { runtime, outputs } = createRuntime(system, { canonicalTerminalViews: true,
    onTerminalViewStarted: async () => { resetEntered = true; await resetGate; } });
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    assert.equal(system.connectCalls[0].terminalViewProtocol, "cuna.terminal-view.v1");
    assert.equal(runtime.listTerminals()[0].outputContinuity, "unknown");
    await assert.rejects(runtime.sendInput(new Uint8Array([65]), "tab-a"));
    const connection = system.connections[0]; connection.incoming.push(Buffer.concat([viewStart(), viewOutput(), viewReady()]));
    await waitUntil(() => resetEntered, "reset entered"); assert.equal(outputs.length, 0);
    release(); await waitUntil(() => runtime.listTerminals()[0].terminalView.ready, "canonical ready");
    assert.equal(runtime.listTerminals()[0].outputContinuity, "unknown");
    await runtime.sendInput(new Uint8Array([65]), "tab-a");
    assert.equal(outputs[0].provenance, "replay_or_unknown");
    connection.incoming.push(viewOutput(2n)); await waitUntil(() => outputs.length === 2, "live delta");
    assert.equal(outputs[1].provenance, "live");
    await connection.close(); await waitUntil(() => runtime.listTerminals()[0].state === "interrupted", "interrupted");
    await runtime.reconnect({ tabId: "tab-a" });
    const next = system.connections[1]; const resume = next.sent.map(decodeTerminalFrame).find(x => x.type === "resume");
    assert.equal(decodeTerminalControl(resume).afterOutputSequence, "0");
    assert.equal(runtime.listTerminals()[0].outputSequence, 0n);
    next.incoming.push(Buffer.concat([viewStart("22222222-2222-4333-8444-555555555555"), viewOutput(), viewReady("1", "22222222-2222-4333-8444-555555555555")]));
    await waitUntil(() => outputs.length === 3, "fresh output one"); assert.equal(outputs[2].sequence, 1n);
  } finally { release(); await runtime.shutdown(); }
});

for (const [name, frames] of [
  ["output before start", [viewOutput()]], ["duplicate start", [viewStart(), viewStart()]],
  ["sequence gap", [viewStart(), viewOutput(2n)]],
  ["cross-view ready", [viewStart(), viewOutput(), viewReady("1", "22222222-2222-4333-8444-555555555555")]],
  ["wrong ready boundary", [viewStart(), viewOutput(), viewReady("2")]],
  ["duplicate ready", [viewStart(), viewOutput(), viewReady(), viewReady()]],
]) test(`canonical view refuses ${name}`, async () => {
  const system = new FakeTerminalSystem(); system.canonicalViews = true;
  const { runtime } = createRuntime(system, { canonicalTerminalViews: true, onTerminalViewStarted: async () => {} });
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    system.connections[0].incoming.push(Buffer.concat(frames));
    await waitUntil(() => runtime.listTerminals()[0].state === "failed", name);
  } finally { await runtime.shutdown(); }
});

test("canonical missing readiness fails by deadline despite an open transport", async () => {
  const system = new FakeTerminalSystem(); system.canonicalViews = true;
  const { runtime } = createRuntime(system, { canonicalTerminalViews: true, readyTimeoutMs: 30, onTerminalViewStarted: async () => {} });
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    await waitUntil(() => runtime.listTerminals()[0].state === "failed", "missing view deadline");
  } finally { await runtime.shutdown(); }
});

test("same-packet canonical ready waits for delayed output consumption", async () => {
  const system=new FakeTerminalSystem();system.canonicalViews=true;
  system.extraFramesOnReady=[viewStart(),viewOutput(),viewReady()];
  let entered=false;let release;const gate=new Promise(resolve=>{release=resolve;});
  const {runtime}=createRuntime(system,{canonicalTerminalViews:true,onTerminalViewStarted:async()=>{},onTerminalOutput:async()=>{entered=true;await gate;}});
  try {
    const attaching=runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:80,rows:24});
    await waitUntil(()=>entered,"output consumer entered");
    assert.equal(runtime.listTerminals()[0].terminalView.ready,false);
    await assert.rejects(runtime.sendInput(new Uint8Array([65]),"tab-a"));
    release();const result=await attaching;assert.equal(result.terminalView.ready,true);
  } finally {release();await runtime.shutdown();}
});

test("canonical fragmented bytes preserve exact start/output/ready ordering", async () => {
  const system=new FakeTerminalSystem();system.canonicalViews=true;
  const {runtime,outputs}=createRuntime(system,{canonicalTerminalViews:true,onTerminalViewStarted:async()=>{}});
  try {
    await runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:80,rows:24});
    for(const byte of Buffer.concat([viewStart(),viewOutput(),viewReady()]))system.connections[0].incoming.push(Uint8Array.of(byte));
    await waitUntil(()=>runtime.listTerminals()[0].terminalView.ready,"fragmented ready");
    assert.equal(outputs.length,1);assert.equal(outputs[0].sequence,1n);
  } finally {await runtime.shutdown();}
});

test("only an attachment's RESUME-correlated completion proves live output", async () => {
  const system = new FakeTerminalSystem();
  const { runtime, outputs } = createRuntime(system);
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 60, rows: 22 });
    const wire = system.connections[0];
    const resume = wire.sent.map(decodeTerminalFrame).find((frame) => frame?.type === "resume");
    const output = (sequence) => encodeTerminalFrame({ type: "output", critical: true, sequence, payload: Uint8Array.of(65) });
    wire.incoming.push(output(1n));
    await waitUntil(() => outputs.length === 1, "legacy output remains visible");
    assert.equal(outputs[0].provenance, "replay_or_unknown");
    wire.incoming.push(encodeTerminalControl("heartbeat", resume.sequence - 1n, {}));
    wire.incoming.push(output(2n));
    await waitUntil(() => outputs.length === 2, "unrelated heartbeat does not establish boundary");
    assert.equal(outputs[1].provenance, "replay_or_unknown");
    wire.incoming.push(encodeTerminalControl("heartbeat", resume.sequence, {}));
    wire.incoming.push(output(3n));
    await waitUntil(() => outputs.length === 3, "output after explicit boundary delivered");
    assert.equal(outputs[2].provenance, "live");
    await wire.close();
    await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "old attachment closed");
    await runtime.reconnect({ tabId: "tab-a" });
    const replacement = system.connections.at(-1);
    replacement.incoming.push(output(4n));
    await waitUntil(() => outputs.length === 4, "replacement output delivered");
    assert.equal(outputs[3].provenance, "replay_or_unknown");
  } finally { await runtime.shutdown(); }
});

test("remote geometry is unknown until an exact epoch notice, awaited before following output", async () => {
  const system=new FakeTerminalSystem();system.seatOnReady.set("agent-a",{accessMode:"observer",writerEpoch:1});
  let entered=false,release; const events=[];
  const {runtime}=createRuntime(system,{
    onTerminalGeometry:async event=>{entered=true;events.push(event.snapshot.geometry);await new Promise(resolve=>{release=resolve;});events.push("resized");},
    onTerminalOutput:event=>events.push(new TextDecoder().decode(event.bytes)),
  });
  try {
    const first=await runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:60,rows:22});
    assert.equal(first.geometry,null);
    const wire=system.connections[0];
    wire.incoming.push(geometryWire({columns:143,rows:51,writerEpoch:1}));
    wire.incoming.push(encodeTerminalFrame({type:"output",critical:true,sequence:1n,payload:new TextEncoder().encode("after-size")}));
    await waitUntil(()=>entered,"geometry callback entered");
    assert.equal(events.length,1);release();
    await waitUntil(()=>events.length===3,"output follows completed geometry application");
    assert.deepEqual(events,[{columns:143,rows:51,writerEpoch:1},"resized","after-size"]);
    assert.equal(wire.sent.map(decodeTerminalFrame).some(frame=>frame?.type==="resize"),false);
  } finally { release?.();await runtime.shutdown(); }
});

test("remote geometry rejects malformed, critical, stale epoch and bounded stalled consumers", async () => {
  for (const [payload,critical,stall] of [
    [{columns:0,rows:24,writerEpoch:1},false,false],
    [{columns:80,rows:24,writerEpoch:2},false,false],
    [{columns:80,rows:24,writerEpoch:1},true,false],
    [{columns:80,rows:24,writerEpoch:1,extra:true},false,false],
    [{columns:80,rows:24,writerEpoch:1},false,true],
  ]) {
    const system=new FakeTerminalSystem();let seen=0;let signal;
    const {runtime,states}=createRuntime(system,{outputDeliveryTimeoutMs:20,onTerminalGeometry:async event=>{seen++;signal=event.signal;if(stall)await new Promise(()=>{});}});
    try {
      await runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:80,rows:24});
      system.connections[0].incoming.push(geometryWire(payload,critical));
      await waitUntil(()=>states.some(state=>state.state==="failed"),"geometry fails closed");
      assert.equal(seen,stall?1:0);if(stall)assert.equal(signal.aborted,true);
    } finally { await runtime.shutdown(); }
  }
});

test("same-chunk initial geometry timeout cancels its consumer before failed attach returns", async () => {
  const system=new FakeTerminalSystem();const connect=system.connector.connect;
  system.connector.connect=async input=>{
    const wire=await connect(input);const first=await wire.incoming.next();
    const geometry=geometryWire({columns:143,rows:51,writerEpoch:1});
    const combined=new Uint8Array(first.value.length+geometry.length);combined.set(first.value);combined.set(geometry,first.value.length);
    wire.incoming.push(combined);return wire;
  };
  let signal;
  const {runtime}=createRuntime(system,{outputDeliveryTimeoutMs:20,onTerminalGeometry:async event=>{signal=event.signal;await new Promise(()=>{});}});
  try {
    await assert.rejects(runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:60,rows:22}));
    assert.ok(signal);assert.equal(signal.aborted,true);
  } finally { await runtime.shutdown(); }
});

test("reconnect and writer epoch changes invalidate prior authoritative geometry", async () => {
  const system=new FakeTerminalSystem();const {runtime,states}=createRuntime(system);
  try {
    await runtime.attach({tabId:"tab-a",agentSessionId:"agent-a",columns:80,rows:24});
    system.connections[0].incoming.push(geometryWire({columns:143,rows:51,writerEpoch:1}));
    await waitUntil(()=>states.at(-1)?.geometry?.columns===143,"initial geometry");
    system.connections[0].incoming.push(encodeTerminalControl("writer_epoch",1n,{writerEpoch:2,writerClientInstanceId:"other",accessMode:"observer"}));
    await waitUntil(()=>states.at(-1)?.writerEpoch===2,"new epoch");assert.equal(states.at(-1).geometry,null);
    system.connections[0].incoming.push(geometryWire({columns:167,rows:59,writerEpoch:2}));
    await waitUntil(()=>states.at(-1)?.geometry?.columns===167,"new geometry");
    system.seatOnReady.set("agent-a",{accessMode:"observer",writerEpoch:2});
    system.connections[0].incoming.close();
    await waitUntil(()=>states.at(-1)?.state==="interrupted","transport interrupted before reconnect");
    const next=await runtime.reconnect({tabId:"tab-a"});assert.equal(next.geometry,null);
  } finally { await runtime.shutdown(); }
});

test("TC-055-12 foreground readiness remains distinct from daemon and cannot authorize sync", async () => {
  const system = new FakeTerminalSystem();
  const runtime = new CunaRuntimeBoundary({
    mode: "foreground",
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedCunaOrigins: [API_ORIGIN],
    terminalCapabilityId: CAPABILITY_ID,
    clientInstanceId: "foreground-client",
    clock: () => NOW,
  });
  assert.equal(runtime.daemon.state, "absent");
  assert.equal(runtime.foreground.state, "absent");
  assert.throws(() => runtime.start({
    endpointOwnership: "verified",
    durableState: "verified",
    source: "forged-daemon-evidence",
    observedAt: NOW - 1,
    expiresAt: NOW + 1_000,
  }), /cannot claim daemon readiness/u);
  runtime.startForeground();
  assert.equal(runtime.foreground.state, "ready");
  assert.equal(runtime.daemon.state, "absent");
  await assert.rejects(runtime.openSync({
    configuration: {
      bindingId: "binding-1",
      bindingGeneration: 1,
      localRoot: "/workspace",
      remoteRoot: "/workspace",
      conflictPolicy: "manual",
    },
    journalDirectory: "/not/reached",
    ownerId: "owner-1",
  }), /cannot own workspace synchronization/u);
  await runtime.shutdown();
  assert.equal(runtime.foreground.state, "stopped");
  assert.equal(runtime.daemon.state, "absent");
});

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

test("runtime capability admission fails closed for expired, ambiguous, and non-native evidence", () => {
  assert.throws(
    () => admitCapability(capabilitySnapshot("agent-1", { schemaVersion: "2.0" }), {
      id: CAPABILITY_ID,
      scope: "agent_session",
      subjectId: "agent-1",
      interaction: "native",
    }, NOW),
    (error) => error instanceof RuntimeBoundaryError && error.code === "capability_unknown",
  );
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
  const supervisorPending = capabilitySnapshot("agent-1");
  supervisorPending.capabilities[0] = {
    ...supervisorPending.capabilities[0],
    availability: "unknown",
    reasonCode: "supervisor_registry_unavailable",
  };
  assert.throws(
    () => admitCapability(supervisorPending, {
      id: CAPABILITY_ID,
      scope: "agent_session",
      subjectId: "agent-1",
      interaction: "native",
    }, NOW),
    (error) => error instanceof RuntimeBoundaryError &&
      error.code === "capability_unknown" &&
      error.safeDetails?.reason_code === "supervisor_registry_unavailable",
  );
});

test("terminal grants reject non-Runa origins, query secrets, and incomplete capability evidence", () => {
  const terminalSessionId = "55555555-5555-4555-8555-555555555555";
  const valid = {
    terminalSessionId,
    resumeHandle: "66666666-6666-4666-8666-666666666666",
    connectUrl: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
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
    allowedCunaOrigins: [API_ORIGIN],
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
        allowedCunaOrigins: [API_ORIGIN],
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

test("a new attachment requests retained PTY output before the user provides input", async () => {
  const system = new FakeTerminalSystem();
  system.retainedOutputOnResume.set("agent-a", new TextEncoder().encode("retained Claude screen"));
  const { runtime, outputs } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });

  const resumeWire = system.connections[0].sent.find(
    (bytes) => decodeTerminalFrame(bytes)?.type === "resume",
  );
  assert.ok(resumeWire, "initial attach must request the supervisor replay buffer");
  const resume = decodeTerminalControl(decodeTerminalFrame(resumeWire));
  assert.equal(resume.resumeHandle, "66666666-6666-4666-8666-666666666666");
  assert.equal(resume.afterOutputSequence, "0");
  const initialResize = system.connections[0].sent
    .map(decodeTerminalFrame)
    .find((frame) => frame?.type === "resize");
  assert.deepEqual(decodeTerminalControl(initialResize), { columns: 80, rows: 24 });
  assert.equal(
    system.connections[0].sent.some((bytes) => decodeTerminalFrame(bytes)?.type === "input"),
    false,
  );

  await waitUntil(
    () => outputs.some((item) => new TextDecoder().decode(item.bytes) === "retained Claude screen"),
    "retained output should reach the terminal without synthetic keyboard input",
  );
  await runtime.shutdown();
});

test("TC-055-17 input acknowledgement tracks only input frames and exposes unacknowledged delivery as uncertain", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(runtime.listTerminals()[0].inputContinuity, "none");
  await runtime.sendInput(new TextEncoder().encode("first"), "tab-a");
  await runtime.resize(81, 24, "tab-a");
  await runtime.sendInput(new TextEncoder().encode("second"), "tab-a");
  assert.equal(runtime.listTerminals()[0].inputSequence, 5n);
  assert.equal(runtime.listTerminals()[0].inputContinuity, "uncertain");
  system.connections[0].incoming.push(encodeTerminalControl("acknowledgement", 2n, {
    clientSequence: "5",
    meaning: "durably_accepted_not_executed",
  }));
  await waitUntil(() => runtime.listTerminals()[0]?.acknowledgedInputSequence === 5n, "input ACK should commit the cumulative input cursor");
  assert.equal(runtime.listTerminals()[0].inputContinuity, "complete");
  await runtime.shutdown();

  const invalidSystem = new FakeTerminalSystem();
  const { runtime: invalidRuntime } = createRuntime(invalidSystem);
  await invalidRuntime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await invalidRuntime.sendInput(new TextEncoder().encode("first"), "tab-a");
  await invalidRuntime.resize(81, 24, "tab-a");
  invalidSystem.connections[0].incoming.push(encodeTerminalControl("acknowledgement", 2n, {
    clientSequence: "4",
    meaning: "durably_accepted_not_executed",
  }));
  await waitUntil(() => invalidRuntime.listTerminals()[0]?.state === "failed", "a control-frame sequence cannot impersonate an input ACK");
  assert.equal(invalidRuntime.listTerminals()[0].inputContinuity, "uncertain");
  await invalidRuntime.shutdown();
});

test("two-phase attach initializes the fenced consumer before awaiting same-chunk output", async () => {
  const system = new FakeTerminalSystem();
  system.outputOnReady.set("agent-a", new TextEncoder().encode("early-output"));
  const order = [];
  let releaseOutput;
  const outputGate = new Promise((resolve) => { releaseOutput = resolve; });
  const { runtime } = createRuntime(system, {
    onTerminalReady: async (state) => {
      order.push(`ready:${state.fencingGeneration}`);
    },
    onTerminalOutput: async (event) => {
      order.push(`output:${new TextDecoder().decode(event.bytes)}`);
      await outputGate;
    },
  });

  let settled = false;
  const attaching = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 })
    .then((value) => { settled = true; return value; });
  await waitUntil(() => order.length === 2, "ready and early output callbacks should run");
  assert.deepEqual(order, ["ready:1", "output:early-output"]);
  assert.equal(settled, false, "attach may not outrun the early-output consumer");
  releaseOutput();
  const attached = await attaching;
  assert.equal(attached.state, "active");
  await runtime.shutdown();
});

test("TC-055-13 shutdown fences an attach waiting on remote admission", async () => {
  const system = new FakeTerminalSystem();
  const originalDiscover = system.controlPlane.discoverCapabilities;
  let releaseAdmission;
  let admissionEntered = false;
  system.controlPlane.discoverCapabilities = async (...args) => {
    admissionEntered = true;
    await new Promise((resolve) => { releaseAdmission = resolve; });
    return await originalDiscover(...args);
  };
  const { runtime } = createRuntime(system);
  const attaching = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await waitUntil(() => admissionEntered, "attachment should wait on admission");
  const stopping = runtime.shutdown();
  releaseAdmission();
  await stopping;
  await assert.rejects(attaching, (error) =>
    error instanceof RuntimeBoundaryError &&
    (error.code === "runtime_closed" || error.code === "terminal_disconnected"));
  assert.equal(runtime.daemon.state, "stopped");
  assert.equal(runtime.listTerminals().length, 0);
  assert.equal(system.connections.length, 0);
});

test("shutdown retains failed terminal cleanup authority and retries it to completion", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const connection = system.connections[0];
  const close = connection.close.bind(connection);
  let failOnce = true;
  connection.close = async (input) => {
    if (failOnce) {
      failOnce = false;
      connection.closeCalls.push(input);
      throw new Error("simulated close failure");
    }
    await close(input);
  };

  await assert.rejects(runtime.shutdown(), AggregateError);
  assert.equal(runtime.listTerminals().length, 1, "failed cleanup remains owned for retry");
  await runtime.shutdown();
  assert.equal(runtime.listTerminals().length, 0);
  assert.equal(connection.closeCalls.length, 2);
  await runtime.shutdown();
  assert.equal(connection.closeCalls.length, 2, "completed shutdown is idempotent");
});

function assertSyncShutdownOutcome(outcome) {
  if (outcome.error === undefined) {
    assert.equal(outcome.state, "stopped");
    return;
  }
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  const deadline = outcome.error.errors[0];
  assert.ok(deadline instanceof RuntimeBoundaryError);
  assert.equal(deadline.code, "runtime_cleanup_timeout");
  assert.equal(deadline.message, "Workspace synchronization is still closing. Retry shutdown to finish cleanup.");
  assert.equal(deadline.retryable, true);
  assert.equal(outcome.state, "recovery_required", "a cleanup deadline must not claim stopped");
}

async function assertSyncLeaseReleased(journalDirectory, bindingId) {
  await assert.rejects(access(path.join(journalDirectory, "writer.lease")), (error) => error.code === "ENOENT");
  // File absence alone cannot prove release of the separate writer authority.
  const successor = await DurableSyncJournal.open({
    directory: journalDirectory, bindingId, bindingGeneration: 1, ownerId: "successor-owner", clock: () => NOW,
  });
  try { assert.equal(successor.fence, 2); } finally { await successor.close(); }
  await assert.rejects(access(path.join(journalDirectory, "writer.lease")), (error) => error.code === "ENOENT");
}

test("shutdown fences an in-flight sync open and releases or retains cleanup authority", async () => {
  const directory = await resources.createTempDirectory("cuna-runtime-sync-shutdown-");
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  const journalDirectory = path.join(directory, "journal");
  const opening = assert.rejects(runtime.openSync({
    configuration: {
      bindingId: "binding-shutdown", bindingGeneration: 1, canonicalRoot: path.join(directory, "workspace"),
      policyDigest: `sha256:${"c".repeat(64)}`, epoch: "epoch-shutdown",
    },
    journalDirectory, ownerId: "runtime-owner",
  }), (error) => error instanceof RuntimeBoundaryError && error.code === "runtime_closed");
  // Observe both outcomes immediately: slow real I/O may exceed the factory's
  // one-second budget while openSync still owns and completes lease cleanup.
  const stopping = runtime.shutdown().then(
    () => ({ state: runtime.daemon.state }),
    (error) => ({ error, state: runtime.daemon.state }),
  );
  await opening;
  assertSyncShutdownOutcome(await stopping);
  await assert.rejects(access(path.join(journalDirectory, "writer.lease")), (error) => error.code === "ENOENT");
  await runtime.shutdown();
  assert.equal(runtime.daemon.state, "stopped");
  await assertSyncLeaseReleased(journalDirectory, "binding-shutdown");
});

test("shutdown deadline preserves a held sync lease until open cleanup settles", async (t) => {
  const directory = await resources.createTempDirectory("cuna-runtime-sync-shutdown-deadline-");
  const journalDirectory = path.join(directory, "journal");
  const { runtime } = createRuntime(new FakeTerminalSystem(), { readyTimeoutMs: 5 });
  const originalOpen = DurableSyncJournal.open;
  let releaseOpen;
  const held = new Promise((resolve) => { releaseOpen = resolve; });
  let acquired;
  let failedAcquisition;
  const entered = new Promise((resolve, reject) => { acquired = resolve; failedAcquisition = reject; });
  let ownedJournal;
  const interception = t.mock.method(DurableSyncJournal, "open", async function (input) {
    try {
      ownedJournal = await originalOpen.call(this, input);
      acquired();
      await held;
      return ownedJournal;
    } catch (error) { failedAcquisition(error); throw error; }
  });
  const opening = runtime.openSync({
    configuration: {
      bindingId: "binding-held-shutdown", bindingGeneration: 1, canonicalRoot: path.join(directory, "workspace"),
      policyDigest: `sha256:${"c".repeat(64)}`, epoch: "epoch-held-shutdown",
    },
    journalDirectory, ownerId: "runtime-owner",
  }).then((value) => ({ value }), (error) => ({ error }));
  let stopping;
  try {
    await entered; // Real journal/lease exists before the controlled deadline starts.
    stopping = runtime.shutdown().then(
      () => ({ state: runtime.daemon.state }),
      (error) => ({ error, state: runtime.daemon.state }),
    );
    const timedOut = await stopping;
    assert.ok(timedOut.error, "shutdown must not succeed while the owned open is held");
    assertSyncShutdownOutcome(timedOut);
    await access(path.join(journalDirectory, "writer.lease"));
    releaseOpen();
    const opened = await opening;
    assert.ok(opened.error instanceof RuntimeBoundaryError);
    assert.equal(opened.error.code, "runtime_closed");
    await assert.rejects(access(path.join(journalDirectory, "writer.lease")), (error) => error.code === "ENOENT");
    await runtime.shutdown();
    assert.equal(runtime.daemon.state, "stopped");
    interception.mock.restore();
    await assertSyncLeaseReleased(journalDirectory, "binding-held-shutdown");
  } finally {
    releaseOpen();
    await opening;
    await stopping;
    interception.mock.restore();
    if (ownedJournal !== undefined) await ownedJournal.close();
    await runtime.shutdown();
  }
});

test("TC-055-13 concurrent attach reserves both tab and AgentSession identities before awaiting", async () => {
  const system = new FakeTerminalSystem();
  const originalDiscover = system.controlPlane.discoverCapabilities;
  let releaseAdmission;
  let admissionBlocked = false;
  system.controlPlane.discoverCapabilities = async (...args) => {
    if (!admissionBlocked) {
      admissionBlocked = true;
      await new Promise((resolve) => { releaseAdmission = resolve; });
    }
    return await originalDiscover(...args);
  };
  const { runtime } = createRuntime(system);
  const first = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await assert.rejects(
    runtime.attach({ tabId: "tab-b", agentSessionId: "agent-a", columns: 80, rows: 24 }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "session_conflict",
  );
  await assert.rejects(
    runtime.attach({ tabId: "tab-a", agentSessionId: "agent-b", columns: 80, rows: 24 }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "session_conflict",
  );
  releaseAdmission();
  await first;
  assert.equal(runtime.listTerminals().length, 1);
  await runtime.shutdown();
});

test("TC-055-13 cancellation during remote admission creates no terminal grant", async () => {
  const system = new FakeTerminalSystem();
  const originalDiscover = system.controlPlane.discoverCapabilities;
  let releaseAdmission;
  let admissionBlocked = false;
  system.controlPlane.discoverCapabilities = async (...args) => {
    if (!admissionBlocked) {
      admissionBlocked = true;
      await new Promise((resolve) => { releaseAdmission = resolve; });
    }
    return await originalDiscover(...args);
  };
  const controller = new AbortController();
  const { runtime } = createRuntime(system);
  const attaching = runtime.attach({
    tabId: "tab-a",
    agentSessionId: "agent-a",
    columns: 80,
    rows: 24,
    signal: controller.signal,
  });
  await waitUntil(() => releaseAdmission !== undefined, "attachment should enter remote admission");
  controller.abort(new Error("user_cancelled"));
  releaseAdmission();
  await assert.rejects(attaching, (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected");
  assert.equal(system.createCalls.length, 0);
  assert.equal(system.connectCalls.length, 0);
  await runtime.shutdown();
});

test("terminal output applies backpressure and preserves order across a slow consumer", async () => {
  const system = new FakeTerminalSystem();
  const received = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { runtime } = createRuntime(system, {
    outputDeliveryTimeoutMs: 1_000,
    onTerminalOutput: async (event) => {
      received.push(Number(event.sequence));
      if (event.sequence === 1n) await firstGate;
    },
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const first = encodeTerminalFrame({ type: "output", critical: true, sequence: 1n, payload: new Uint8Array([1]) });
  const second = encodeTerminalFrame({ type: "output", critical: true, sequence: 2n, payload: new Uint8Array([2]) });
  const batch = new Uint8Array(first.byteLength + second.byteLength);
  batch.set(first);
  batch.set(second, first.byteLength);
  system.connections[0].incoming.push(batch);
  await waitUntil(() => received.length === 1, "the first output should reach the consumer");
  assert.deepEqual(received, [1]);
  releaseFirst();
  await waitUntil(() => received.length === 2, "the second output should follow release of the first");
  assert.deepEqual(received, [1, 2]);
  await runtime.shutdown();
});

test("TC-055-15 resume cursor advances only after output delivery commits", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  let deliveryEntered = false;
  const { runtime } = createRuntime(system, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
    onTerminalOutput: async (event) => {
      deliveryEntered = true;
      await new Promise((_resolve, reject) => {
        const fail = () => reject(event.signal.reason ?? new Error("delivery aborted"));
        if (event.signal.aborted) fail();
        else event.signal.addEventListener("abort", fail, { once: true });
      });
    },
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.push(encodeTerminalFrame({
    type: "output",
    critical: true,
    sequence: 1n,
    payload: Uint8Array.of(1),
  }));
  await waitUntil(() => deliveryEntered, "output delivery should be in flight");
  now += 1_001;
  assert.throws(() => runtime.refreshTerminalLiveness("tab-a"), RuntimeBoundaryError);
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "aborted delivery should interrupt the tab");
  assert.equal(runtime.listTerminals()[0].outputSequence, 0n);
  await runtime.reconnect({ tabId: "tab-a" });
  const resume = system.connections[1].sent.map(decodeTerminalFrame).find((frame) => frame?.type === "resume");
  assert.equal(decodeTerminalControl(resume).afterOutputSequence, "0");
  await runtime.shutdown();
});

test("TC-055-15 exit revokes later output decoded from the same transport message", async () => {
  const system = new FakeTerminalSystem();
  const { runtime, outputs } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const exited = encodeTerminalControl("exit", 2n, { exitCode: 0, reason: "exited" });
  const late = encodeTerminalFrame({ type: "output", critical: true, sequence: 3n, payload: Uint8Array.of(9) });
  const batch = new Uint8Array(exited.byteLength + late.byteLength);
  batch.set(exited);
  batch.set(late, exited.byteLength);
  system.connections[0].incoming.push(batch);
  await waitUntil(() => runtime.listTerminals().length === 0, "exit should release the closed tab");
  assert.equal(outputs.length, 0);
  assert.equal(system.connections[0].closeCalls.at(-1).reason, "cuna_remote_process_exit");
  await runtime.shutdown();
});

test("a stalled terminal output consumer fails only its tab within a bounded deadline", async () => {
  const system = new FakeTerminalSystem();
  const { runtime, states } = createRuntime(system, {
    outputDeliveryTimeoutMs: 10,
    onTerminalOutput: async () => await new Promise(() => undefined),
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.push(encodeTerminalFrame({
    type: "output",
    critical: true,
    sequence: 1n,
    payload: new Uint8Array([1]),
  }));
  await waitUntil(() => states.some((state) => state.tabId === "tab-a" && state.state === "failed"), "stalled output should quarantine the tab");
  assert.equal(runtime.listTerminals()[0].state, "failed");
  assert.equal(system.connections[0].closeCalls.at(-1).reason, "cuna_terminal_protocol_failure");
  await runtime.shutdown();
});

test("illegal post-attach protocol frames fail the tab instead of entering reconnect churn", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.push(encodeTerminalFrame({
    type: "input",
    critical: true,
    sequence: 2n,
    payload: Uint8Array.of(1),
  }));
  await waitUntil(() => runtime.listTerminals()[0]?.state === "failed", "illegal server input should fail the tab");
  assert.equal(system.connections[0].closeCalls.at(-1).reason, "cuna_terminal_protocol_failure");
  await runtime.shutdown();
});

test("heartbeat expiry fences input while a fresh heartbeat extends the attachment lease", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  const { runtime, states } = createRuntime(system, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
  });
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(attached.resizeCapability, "live");
  assert.equal(attached.heartbeatExpiresAt, NOW + 1_000);

  now += 750;
  system.connections[0].incoming.push(encodeTerminalControl("heartbeat", 2n, {}));
  await waitUntil(() => runtime.listTerminals()[0].heartbeatObservedAt === now, "heartbeat should renew the observed lease");
  now += 750;
  assert.equal(runtime.refreshTerminalLiveness("tab-a").state, "active");

  now += 251;
  const sendsBeforeExpiry = system.connections[0].sent.length;
  await assert.rejects(runtime.sendInput(new Uint8Array([65]), "tab-a"), (error) =>
    error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected" && error.retryable === true,
  );
  assert.equal(system.connections[0].sent.length, sendsBeforeExpiry, "stale input must not reach the wire");
  assert.equal(runtime.listTerminals()[0].reason, "heartbeat_expired");
  assert.ok(states.some((state) => state.state === "interrupted" && state.reason === "heartbeat_expired"));
  assert.equal(system.connections[0].closeCalls.at(-1).reason, "cuna_heartbeat_expired");
  await runtime.shutdown();
});

test("an idle CLI emits the client heartbeat the gateway requires and accepts its echo", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  const { runtime } = createRuntime(system, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await waitUntil(
    () => system.connections[0].sent.some((bytes) => decodeTerminalFrame(bytes)?.type === "heartbeat"),
    "an idle attachment should send a heartbeat before the gateway deadline",
  );
  const heartbeatWire = system.connections[0].sent.find(
    (bytes) => decodeTerminalFrame(bytes)?.type === "heartbeat",
  );
  assert.ok(heartbeatWire);
  const heartbeat = decodeTerminalFrame(heartbeatWire);
  assert.equal(heartbeat.type, "heartbeat");
  now += 300;
  system.connections[0].incoming.push(heartbeatWire);
  await waitUntil(
    () => runtime.listTerminals()[0]?.heartbeatObservedAt === now,
    "the supervisor heartbeat echo should renew local attachment evidence",
  );
  assert.equal(runtime.listTerminals()[0].state, "active");
  await runtime.shutdown();
});

test("heartbeat watchdog interrupts an idle dead terminal without waiting for user input", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  const { runtime, states } = createRuntime(system, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  now += 1_001;
  await new Promise((resolve) => setTimeout(resolve, 1_025));

  assert.equal(runtime.listTerminals()[0].state, "interrupted");
  assert.equal(runtime.listTerminals()[0].reason, "heartbeat_expired");
  assert.ok(states.some((state) => state.state === "interrupted" && state.reason === "heartbeat_expired"));
  assert.equal(system.connections[0].closeCalls.at(-1).reason, "cuna_heartbeat_expired");
  await runtime.shutdown();
});

test("late or replayed heartbeat frames cannot renew attachment authority", async () => {
  const lateSystem = new FakeTerminalSystem();
  let now = NOW;
  const { runtime: lateRuntime } = createRuntime(lateSystem, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
  });
  await lateRuntime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  now += 1_001;
  lateSystem.connections[0].incoming.push(encodeTerminalControl("heartbeat", 2n, {}));
  await waitUntil(() => lateRuntime.listTerminals()[0].state === "interrupted", "late heartbeat should interrupt the tab");
  assert.equal(lateRuntime.listTerminals()[0].heartbeatObservedAt, NOW);
  await lateRuntime.shutdown();

  const replaySystem = new FakeTerminalSystem();
  let replayNow = NOW;
  const { runtime: replayRuntime } = createRuntime(replaySystem, { clock: () => replayNow });
  await replayRuntime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  replayNow += 10;
  replaySystem.connections[0].incoming.push(encodeTerminalControl("heartbeat", 2n, {}));
  await waitUntil(() => replayRuntime.listTerminals()[0].heartbeatObservedAt === replayNow, "fresh heartbeat should be accepted");
  replaySystem.connections[0].incoming.push(encodeTerminalControl("heartbeat", 2n, {}));
  await waitUntil(() => replayRuntime.listTerminals()[0].state === "failed", "replayed heartbeat should fail the tab");
  assert.equal(replaySystem.connections[0].closeCalls.at(-1).reason, "cuna_terminal_protocol_failure");
  await replayRuntime.shutdown();
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
  assert.deepEqual(frames.map((frame) => frame.sequence), [1n, 2n, 3n, 4n, 5n]);
  assert.deepEqual(frames.map((frame) => frame.type), ["resize", "resume", "input", "resize", "signal"]);
  await runtime.shutdown();
});

test("queued input from an interrupted attachment cannot cross the reconnect fence", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  const { runtime } = createRuntime(system, { clock: () => now, heartbeatTimeoutMs: 1_000 });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const oldConnection = system.connections[0];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let sendCount = 0;
  oldConnection.send = async (bytes) => {
    sendCount += 1;
    if (sendCount === 1) await firstGate;
    oldConnection.sent.push(bytes);
  };
  const first = runtime.sendInput(new TextEncoder().encode("first"), "tab-a");
  await waitUntil(() => sendCount === 1, "first input should hold the old send tail");
  const stale = runtime.sendInput(new TextEncoder().encode("stale"), "tab-a");
  now += 1_001;
  assert.throws(() => runtime.refreshTerminalLiveness("tab-a"), RuntimeBoundaryError);
  const reconnected = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(reconnected.state, "active");
  releaseFirst();
  await first;
  await assert.rejects(stale, (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected");
  const replacementInputs = system.connections[1].sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input");
  assert.equal(replacementInputs.length, 0, "pre-disconnect input must not execute on the replacement attachment");
  await runtime.shutdown();
});

test("receipt-time input authority rejects a tab that reconnected before the coordinator drained its queue", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  const original = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const oldBinding = {
    userId: original.userId,
    machineId: original.machineId,
    agentSessionId: original.agentSessionId,
    processEpoch: original.processEpoch,
    fencingGeneration: original.fencingGeneration,
  };
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "the original attachment should be interrupted");
  const replacement = await runtime.reconnect({ tabId: "tab-a" });
  assert.ok(replacement.fencingGeneration > oldBinding.fencingGeneration);

  const replacementWire = system.connections.at(-1);
  const sentBefore = replacementWire.sent.length;
  await assert.rejects(
    runtime.sendInput(new TextEncoder().encode("old receipt"), "tab-a", oldBinding),
    (error) => error instanceof RuntimeBoundaryError && error.code === "grant_scope_mismatch",
  );
  assert.equal(replacementWire.sent.length, sentBefore);
  await runtime.shutdown();
});

test("detach is a revocation barrier for queued writes and waits for the admitted send tail", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  const connection = system.connections[0];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let sendCount = 0;
  connection.send = async (bytes) => {
    sendCount += 1;
    if (sendCount === 1) await firstGate;
    connection.sent.push(bytes);
  };
  const first = runtime.sendInput(new TextEncoder().encode("first"), "tab-a");
  await waitUntil(() => sendCount === 1, "first send should own the old connection");
  const stale = runtime.sendInput(new TextEncoder().encode("stale"), "tab-a");
  let detached = false;
  const detaching = runtime.detach("tab-a").then(() => { detached = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached, false, "detach cannot report completion while an admitted send remains pending");
  releaseFirst();
  await first;
  await assert.rejects(stale, (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected");
  await detaching;
  assert.equal(connection.sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input").length, 1);
  await runtime.shutdown();
});

test("detach aborts and drains an in-flight terminal output consumer", async () => {
  const system = new FakeTerminalSystem();
  let entered = false;
  let cancelled = false;
  const { runtime } = createRuntime(system, {
    onTerminalOutput: async (event) => {
      entered = true;
      await new Promise((resolve) => {
        const done = () => { cancelled = true; resolve(); };
        if (event.signal.aborted) done();
        else event.signal.addEventListener("abort", done, { once: true });
      });
    },
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.push(encodeTerminalFrame({
    type: "output",
    critical: true,
    sequence: 1n,
    payload: new Uint8Array([1]),
  }));
  await waitUntil(() => entered, "output consumer should be active");
  await runtime.detach("tab-a");
  assert.equal(cancelled, true);
  assert.equal(runtime.listTerminals().length, 0);
  await runtime.shutdown();
});

test("heartbeat lease begins only after delayed readiness is proven", async () => {
  const system = new FakeTerminalSystem();
  system.connectionsWithoutReady.add(1);
  let now = NOW;
  const { runtime } = createRuntime(system, { clock: () => now, heartbeatTimeoutMs: 1_000, readyTimeoutMs: 2_000 });
  const attaching = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await waitUntil(() => system.connections.length === 1, "attachment should wait for producer readiness");
  now += 1_100;
  const grant = [...system.grants.values()][0];
  system.connections[0].incoming.push(encodeTerminalControl("ready", 1n, {
    protocol: TERMINAL_PROTOCOL,
    agentSessionId: grant.agentSessionId,
    processEpoch: grant.processEpoch,
    fencingGeneration: grant.attachmentGeneration,
    resizeCapability: "live",
    accessMode: "writer",
    writerEpoch: 1,
  }));
  const attached = await attaching;
  assert.equal(attached.heartbeatObservedAt, now);
  assert.equal(attached.heartbeatExpiresAt, now + 1_000);
  assert.equal(runtime.refreshTerminalLiveness("tab-a").state, "active");
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
  assert.equal(system.createCalls[1].resumeHandle, undefined, "a replacement grant must mint a fresh grant-scoped handle");
  assert.notEqual(system.connections[0].connectionId, system.connections[1].connectionId);
  assert.equal(system.connectCalls.length, 2);
  const reconnectHandshake = system.connections[1].sent.map(decodeTerminalFrame);
  assert.deepEqual(
    reconnectHandshake.slice(0, 2).map((frame) => frame.type),
    ["resize", "resume"],
    "reconnect must restore PTY geometry before requesting retained output",
  );
  assert.deepEqual(decodeTerminalControl(reconnectHandshake[0]), { columns: 80, rows: 24 });
  assert.equal(
    decodeTerminalControl(reconnectHandshake[1]).resumeHandle,
    "66666666-6666-4666-8666-000000000002",
    "resume must use the replacement grant's handle",
  );
  await runtime.shutdown();
});

test("TC-055-14 reconnect cancellation during admission preserves the old transport and creates no grant", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");
  const originalDiscover = system.controlPlane.discoverCapabilities;
  let releaseAdmission;
  system.controlPlane.discoverCapabilities = async (...args) => {
    await new Promise((resolve) => { releaseAdmission = resolve; });
    return await originalDiscover(...args);
  };
  const controller = new AbortController();
  const reconnecting = runtime.reconnect({ tabId: "tab-a", signal: controller.signal });
  await waitUntil(() => releaseAdmission !== undefined, "reconnect should enter remote admission");
  controller.abort(new Error("user_cancelled"));
  releaseAdmission();
  await assert.rejects(reconnecting, (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected");
  assert.equal(system.createCalls.length, 1, "cancelled admission cannot create a replacement grant");
  assert.equal(system.connections[0].closeCalls.length, 0, "cancellation before grant cannot mutate the old transport");
  await runtime.shutdown();
});

test("TC-055-14 reconnect rejects reassignment of any AgentSession authority field", async () => {
  for (const [field, replacement] of [["userId", "user-2"], ["machineId", "machine-2"]]) {
    const system = new FakeTerminalSystem();
    const originalObserve = system.controlPlane.observeAgentSession;
    const { runtime } = createRuntime(system);
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    system.connections[0].incoming.close();
    await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal should become interrupted");
    system.controlPlane.observeAgentSession = async (...args) => ({ ...(await originalObserve(...args)), [field]: replacement });
    await assert.rejects(
      runtime.reconnect({ tabId: "tab-a" }),
      (error) => error instanceof RuntimeBoundaryError && error.code === "session_discontinuous",
      field,
    );
    assert.equal(runtime.listTerminals()[0].state, "failed");
    await runtime.shutdown();
  }
});

test("detached terminal state is fully released and tab identities can be reused", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  for (let index = 0; index < 25; index += 1) {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    await runtime.detach("tab-a");
    assert.equal(runtime.listTerminals().length, 0);
  }
  assert.equal(system.connections.length, 25);
  await runtime.shutdown();
});

test("reconnect installs the new fenced consumer before delivering same-chunk resumed output", async () => {
  const system = new FakeTerminalSystem();
  const order = [];
  system.outputOnReady.set("agent-a", new TextEncoder().encode("initial"));
  const { runtime } = createRuntime(system, {
    onTerminalReady: async (state) => {
      order.push(`ready:${state.fencingGeneration}`);
    },
    onTerminalOutput: async (event) => {
      order.push(`output:${event.sequence}:${new TextDecoder().decode(event.bytes)}`);
    },
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");
  system.outputOnReady.set("agent-a", new TextEncoder().encode("resumed"));
  system.outputSequenceOnReady.set("agent-a", 2n);

  await runtime.reconnect({ tabId: "tab-a" });

  assert.deepEqual(order, [
    "ready:1",
    "output:1:initial",
    "ready:2",
    "output:2:resumed",
  ]);
  await runtime.shutdown();
});

test("a stale pump cannot interrupt or close the replacement connection", async () => {
  const system = new FakeTerminalSystem();
  let now = NOW;
  let releaseOldOutput;
  let oldOutputEntered = false;
  const oldOutputGate = new Promise((resolve) => { releaseOldOutput = resolve; });
  const { runtime } = createRuntime(system, {
    clock: () => now,
    heartbeatTimeoutMs: 1_000,
    onTerminalOutput: async () => {
      oldOutputEntered = true;
      await oldOutputGate;
      throw new Error("stale renderer failure");
    },
  });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.push(encodeTerminalFrame({
    type: "output",
    critical: true,
    sequence: 1n,
    payload: new Uint8Array([1]),
  }));
  await waitUntil(() => oldOutputEntered, "old output consumer should be in flight");
  now += 1_001;
  assert.throws(() => runtime.refreshTerminalLiveness("tab-a"), RuntimeBoundaryError);

  const reconnected = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(reconnected.state, "active");
  releaseOldOutput();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runtime.listTerminals()[0].state, "active");
  assert.equal(system.connections[1].closeCalls.length, 0, "stale pump must not close the fresh connection");
  await runtime.shutdown();
});

test("detach during reconnect permanently wins over a late ready frame", async () => {
  const system = new FakeTerminalSystem();
  system.connectionsWithoutReady.add(2);
  const { runtime } = createRuntime(system, { readyTimeoutMs: 1_000 });
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  system.connections[0].incoming.close();
  await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "terminal did not become interrupted");

  const reconnecting = runtime.reconnect({ tabId: "tab-a" });
  await waitUntil(() => system.connections.length === 2, "replacement connection should be waiting for ready");
  await runtime.detach("tab-a");
  const replacementGrant = [...system.grants.values()].at(-1);
  system.connections[1].incoming.push(encodeTerminalControl("ready", 1n, {
    protocol: TERMINAL_PROTOCOL,
    agentSessionId: replacementGrant.agentSessionId,
    processEpoch: replacementGrant.processEpoch,
    fencingGeneration: replacementGrant.attachmentGeneration,
    resizeCapability: "live",
    accessMode: "writer",
    writerEpoch: 1,
  }));

  await assert.rejects(
    reconnecting,
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected",
  );
  assert.equal(runtime.listTerminals().length, 0);
  assert.equal(system.connections[1].closeCalls.at(-1).reason, "cuna_resume_rejected");
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
  assert.notEqual(
    system.createCalls[1].idempotencyKey,
    system.createCalls[2].idempotencyKey,
    "a consumed replacement grant cannot be retried with its old mutation identity",
  );
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

test("API terminal control plane derives fresh public observation and sends only the grant intent", async () => {
  const calls = [];
  const client = {
    async getIdentity() {
      return { id: "11111111-1111-4111-8111-111111111111", email: "dev@example.test", workspaceAssigned: true };
    },
    async getAgentSession(id) {
      assert.equal(id, "agent-a");
      return {
        id,
        machineId: "22222222-2222-4222-8222-222222222222",
        name: "primary",
        agent: "claude-code",
        cwd: "/workspace",
        authMode: "interactive_login",
        desiredState: "running",
        requestState: "launched",
        processState: "running",
        processEpoch: "33333333-3333-4333-8333-333333333333",
        runtimeObservedAt: new Date(NOW - 1_000).toISOString(),
        runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
        rowVersion: 7,
        createdAt: new Date(NOW - 60_000).toISOString(),
        updatedAt: new Date(NOW - 1_000).toISOString(),
      };
    },
    async discoverCapabilities(_scope, resourceId) { return capabilitySnapshot(resourceId); },
    async createTerminalConnection(agentSessionId, intent, key) {
      calls.push({ agentSessionId, intent, key });
      return {
        terminalSessionId: "55555555-5555-4555-8555-555555555555",
        resumeHandle: "66666666-6666-4666-8666-666666666666",
        connectUrl: "wss://api.getcuna.com/v1/terminal-connections/55555555-5555-4555-8555-555555555555/stream",
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
    },
  };
  const controlPlane = createApiTerminalControlPlane({ client, clock: () => NOW });
  const evidence = await controlPlane.observeAgentSession("agent-a");
  assert.equal(evidence.processEpoch, "33333333-3333-4333-8333-333333333333");
  assert.equal(evidence.expiresAt, new Date(NOW + 30_000).toISOString());
  assert.equal(evidence.evidenceRevision, "agent-session-row:7");
  const admission = admitCapability(capabilitySnapshot("agent-a"), {
    id: CAPABILITY_ID,
    scope: "agent_session",
    subjectId: "agent-a",
    surface: "cli",
    interaction: "native",
  }, NOW);
  await controlPlane.createTerminalConnection({
    agentSessionId: "agent-a",
    protocol: TERMINAL_PROTOCOL,
    clientInstanceId: "client-1",
    idempotencyKey: "terminal-operation-1",
    capabilityEvidence: admission,
  });
  assert.deepEqual(calls, [{
    agentSessionId: "agent-a",
    intent: {
      protocol: TERMINAL_PROTOCOL,
      clientInstanceId: "client-1",
    },
    key: "terminal-operation-1",
  }]);
});

test("API terminal control plane preserves structural identity but does not preempt backend attach authority", async () => {
  const base = {
    cwd: "/workspace",
    id: "agent-a",
    machineId: "22222222-2222-4222-8222-222222222222",
    processState: "running",
    processEpoch: "33333333-3333-4333-8333-333333333333",
    runtimeObservedAt: new Date(NOW - 1_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 7,
  };
  const missingIdentity = [
    { ...base, processEpoch: undefined },
    { ...base, runtimeObservedAt: undefined },
    { ...base, runtimeExpiresAt: undefined },
  ];
  for (const session of missingIdentity) {
    const controlPlane = createApiTerminalControlPlane({
      clock: () => NOW,
      client: {
        async getIdentity() {
          return { id: "11111111-1111-4111-8111-111111111111", workspaceAssigned: true };
        },
        async getAgentSession() { return session; },
      },
    });
    await assert.rejects(
      controlPlane.observeAgentSession("agent-a"),
      (error) => error instanceof RuntimeBoundaryError && error.code === "remote_state_unproven",
    );
  }

  const expired = {
    ...base,
    runtimeObservedAt: new Date(NOW - 60_000).toISOString(),
    runtimeExpiresAt: new Date(NOW - 30_000).toISOString(),
  };
  const controlPlane = createApiTerminalControlPlane({
    clock: () => NOW,
    client: {
      async getIdentity() {
        return { id: "11111111-1111-4111-8111-111111111111", workspaceAssigned: true };
      },
      async getAgentSession() { return expired; },
    },
  });
  const evidence = await controlPlane.observeAgentSession("agent-a");
  assert.equal(evidence.observedAt, expired.runtimeObservedAt);
  assert.equal(evidence.expiresAt, expired.runtimeExpiresAt);
});

test("API terminal control plane accepts a backend-current lease renewed after an older observation", async () => {
  const session = {
    cwd: "/workspace",
    id: "agent-a",
    machineId: "22222222-2222-4222-8222-222222222222",
    processState: "running",
    processEpoch: "33333333-3333-4333-8333-333333333333",
    runtimeObservedAt: new Date(NOW - 20 * 60_000).toISOString(),
    runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 9,
  };
  const controlPlane = createApiTerminalControlPlane({
    clock: () => NOW,
    client: {
      async getIdentity() {
        return { id: "11111111-1111-4111-8111-111111111111", workspaceAssigned: true };
      },
      async getAgentSession() { return session; },
    },
  });
  const evidence = await controlPlane.observeAgentSession("agent-a");
  assert.equal(evidence.observedAt, session.runtimeObservedAt);
  assert.equal(evidence.expiresAt, session.runtimeExpiresAt);
});

test("PTY adapter is usable only with current platform-bound live evidence", async () => {
  const adapter = {
    probe: async () => ({
      status: "verified",
      adapterId: "test-pty",
      protocol: "cuna.local-pty.v1",
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
    args: ["-e", "process.stdout.write(JSON.stringify({value:'ok',secret:process.env.CUNA_API_KEY??null}))"],
  });
  let stdout = "";
  for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  const exit = await child.wait();
  assert.equal(exit.exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), { value: "ok", secret: null });
  assert.throws(
    () => adapter.spawn({ executable: process.execPath, args: ["-e", ""], environment: { CUNA_API_KEY: "must-not-pass" } }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "process_invalid",
  );
  assert.throws(
    () => adapter.spawn({ executable: "node", args: ["--version"] }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "process_invalid",
  );
});

test("runtime sync boundary acquires one durable journal writer and begins in reconciliation", async () => {
  const directory = await resources.createTempDirectory("cuna-runtime-sync-");
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
  }
});

test("runtime startup rejects unverified local endpoint evidence", () => {
  const system = new FakeTerminalSystem();
  const runtime = new CunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedCunaOrigins: [API_ORIGIN],
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
  const runtime = new CunaRuntimeBoundary({
    controlPlane: system.controlPlane,
    terminalConnector: system.connector,
    allowedCunaOrigins: [API_ORIGIN],
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

// ---------------------------------------------------------------------------
// The writer seat. One attachment types; every other one observes. The seat
// moves only on the server's own writer_epoch notice, never on a local guess.
// ---------------------------------------------------------------------------

function writerHeldRefusal() {
  const error = new Error("Terminal writer held");
  Object.assign(error, {
    code: "cuna.remote.conflict",
    details: { http_status: 409, reason: "terminal_writer_held" },
  });
  return error;
}

test("a held writer seat attaches as an observer, and an observer's keys never reach the wire", async () => {
  const system = new FakeTerminalSystem();
  const refused = [];
  const issue = system.controlPlane.createTerminalConnection;
  system.controlPlane.createTerminalConnection = async (input) => {
    if (input.accessMode !== "observer") {
      refused.push(input);
      throw writerHeldRefusal();
    }
    return issue(input);
  };
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 4 });
  const { runtime, states } = createRuntime(system);
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(attached.accessMode, "observer");
  assert.equal(attached.writerEpoch, 4);
  assert.equal(attached.writerClientInstanceId, null, "READY does not name the holder; the notice does");
  assert.equal(refused.length, 1, "the writer seat is asked for exactly once before observing");
  assert.equal(system.createCalls.at(-1).accessMode, "observer");
  assert.notEqual(
    system.createCalls.at(-1).idempotencyKey,
    refused[0].idempotencyKey,
    "the observer request is a new request, not a replay of the refused one",
  );
  assert.equal(system.createCalls.at(-1).expectedWriterEpoch, undefined, "an observer expects no epoch");

  const connection = system.connections.at(-1);
  const sentBefore = connection.sent.length;
  await assert.rejects(
    runtime.sendInput(new TextEncoder().encode("x"), "tab-a"),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_observer",
  );
  assert.equal(connection.sent.length, sentBefore, "a refused keystroke sends nothing");
  assert.equal(states.at(-1).state, "active", "refusing a keystroke does not disturb the attachment");
  await assert.rejects(
    runtime.resize(100, 40, "tab-a"),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_observer",
    "an observer does not resize the PTY",
  );
  await assert.rejects(
    runtime.signal("interrupt", "tab-a"),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_observer",
    "an observer does not signal the process",
  );
  assert.equal(connection.sent.length, sentBefore, "a refused resize or signal sends nothing either");

  connection.incoming.push(encodeTerminalControl("writer_epoch", 7n, {
    writerEpoch: 5,
    writerClientInstanceId: "client-1",
    accessMode: "writer",
  }));
  await waitUntil(
    () => states.at(-1)?.accessMode === "writer" && states.at(-1)?.writerEpoch === 5,
    "the server's notice seats the attachment as the writer",
  );
  await runtime.sendInput(new TextEncoder().encode("y"), "tab-a");
  assert.equal(decodeTerminalFrame(connection.sent.at(-1)).type, "input");
  await runtime.shutdown();
});

test("a writer demoted by a transfer keeps observing; taking the seat back is confirmed by the API and seated by the notice", async () => {
  const system = new FakeTerminalSystem();
  const transfers = [];
  system.controlPlane.transferTerminalWriter = async (input) => {
    transfers.push(input);
    return {
      agentSessionId: input.agentSessionId,
      processEpoch: `epoch-${input.agentSessionId}`,
      writerEpoch: input.expectedWriterEpoch + 1,
      writerClientInstanceId: input.clientInstanceId,
      transferPending: false,
      operationId: input.operationId, operationState: "committed",
    };
  };
  const { runtime, states } = createRuntime(system);
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(attached.accessMode, "writer");
  assert.equal(attached.writerClientInstanceId, "client-1");
  const connection = system.connections.at(-1);

  connection.incoming.push(encodeTerminalControl("writer_epoch", 3n, {
    writerEpoch: 2,
    writerClientInstanceId: "client-9",
    accessMode: "observer",
  }));
  await waitUntil(() => states.at(-1)?.accessMode === "observer", "the notice demotes the former writer");
  assert.equal(states.at(-1).reason, "writer_transferred");
  assert.equal(states.at(-1).writerClientInstanceId, "client-9");
  assert.equal(states.at(-1).state, "active", "a demoted writer stays attached");
  await assert.rejects(
    runtime.sendInput(new TextEncoder().encode("x"), "tab-a"),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_observer",
  );

  const asked = await runtime.takeWriter({ tabId: "tab-a" });
  assert.deepEqual(transfers.map(({ capabilityEvidence: _capabilityEvidence, ...request }) => request), [{ agentSessionId: "agent-a", clientInstanceId: "client-1", expectedWriterEpoch: 2, operationId: transfers[0].operationId }]);
  assert.equal(transfers[0].capabilityEvidence.capabilityId, "terminal_writers.transfer");
  assert.equal(transfers[0].capabilityEvidence.subjectId, "agent-a");
  assert.equal(asked.accessMode, "observer", "the API's confirmation does not seat the client; the server's notice does");
  assert.equal(asked.writerEpoch, 3);
  assert.equal(asked.writerClientInstanceId, "client-1");
  await assert.rejects(
    runtime.sendInput(new TextEncoder().encode("early"), "tab-a"),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_observer",
  );

  connection.incoming.push(encodeTerminalControl("writer_epoch", 4n, {
    writerEpoch: 3,
    writerClientInstanceId: "client-1",
    accessMode: "writer",
  }));
  await waitUntil(() => states.at(-1)?.accessMode === "writer", "the notice seats the new writer");
  assert.equal(states.at(-1).reason, undefined);
  await runtime.sendInput(new TextEncoder().encode("y"), "tab-a");
  assert.equal(decodeTerminalFrame(connection.sent.at(-1)).type, "input");

  const again = await runtime.takeWriter({ tabId: "tab-a" });
  assert.equal(transfers.length, 1, "a writer asking for its own seat sends nothing");
  assert.equal(again.accessMode, "writer");
  await runtime.shutdown();
});

test("a transfer answered for another terminal or client is refused as a scope mismatch", async () => {
  const system = new FakeTerminalSystem();
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  system.controlPlane.transferTerminalWriter = async (input) => ({
    agentSessionId: input.agentSessionId,
    processEpoch: `epoch-${input.agentSessionId}`,
    writerEpoch: 2,
    writerClientInstanceId: "somebody-else",
    transferPending: false,
  });
  const { runtime, states } = createRuntime(system);
  await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await assert.rejects(
    runtime.takeWriter({ tabId: "tab-a" }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "grant_scope_mismatch",
  );
  assert.equal(states.at(-1).accessMode, "observer");
  assert.equal(states.at(-1).writerEpoch, 1, "a mismatched answer moves nothing locally");
  await runtime.shutdown();
});

test("the writer seat is spelled on the wire exactly, or refused", () => {
  const ready = {
    protocol: TERMINAL_PROTOCOL,
    agentSessionId: "agent-a",
    processEpoch: "epoch-agent-a",
    fencingGeneration: 1,
    resizeCapability: "live",
  };
  // The encoder spells whatever it is given; the receiving side is the oracle.
  const received = (type, payload) => decodeTerminalControl(decodeTerminalFrame(encodeTerminalControl(type, 1n, payload)));
  const malformed = (error) => error instanceof TerminalProtocolError && error.code === "invalid_payload";
  assert.throws(() => received("ready", ready), malformed, "READY without a seat is not READY");
  assert.throws(() => received("ready", { ...ready, accessMode: "root", writerEpoch: 1 }), malformed);
  assert.throws(() => received("ready", { ...ready, accessMode: "writer", writerEpoch: 0 }), malformed);
  assert.equal(received("ready", { ...ready, accessMode: "observer", writerEpoch: 1 }).accessMode, "observer");
  assert.throws(
    () => received("writer_epoch", { writerEpoch: 1, accessMode: "writer" }),
    malformed,
    "the notice must name the holder, even as null",
  );
  assert.throws(
    () => received("writer_epoch", { writerEpoch: 1, writerClientInstanceId: null, accessMode: "root" }),
    malformed,
  );
  assert.throws(
    () => received("writer_epoch", { writerEpoch: 1, writerClientInstanceId: null, accessMode: "writer", extra: true }),
    malformed,
    "an unknown key is refused, not ignored",
  );
  const notice = received("writer_epoch", { writerEpoch: 2, writerClientInstanceId: null, accessMode: "observer" });
  assert.deepEqual(notice, { writerEpoch: 2, writerClientInstanceId: null, accessMode: "observer" });
});

function terminalResponseFor(attached, bytes) {
  return {
    tabId: attached.tabId,
    binding: {
      userId: attached.userId,
      machineId: attached.machineId,
      agentSessionId: attached.agentSessionId,
      processEpoch: attached.processEpoch,
      fencingGeneration: attached.fencingGeneration,
    },
    bytes: new TextEncoder().encode(bytes),
  };
}

function inputFrames(connection) {
  return connection.sent.map(decodeTerminalFrame).filter((frame) => frame?.type === "input");
}

test("an observer's terminal-generated responses are dropped silently; a writer's reach the wire once", async () => {
  const system = new FakeTerminalSystem();
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 4 });
  const { runtime, states } = createRuntime(system);
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(attached.accessMode, "observer");
  const connection = system.connections.at(-1);
  const sentBefore = connection.sent.length;

  await runtime.sendTerminalResponse(terminalResponseFor(attached, "[?1;2c"));
  assert.equal(connection.sent.length, sentBefore, "an observer's DA1 answer never reaches the PTY");
  assert.equal(inputFrames(connection).length, 0);
  assert.equal(states.at(-1).state, "active", "dropping the answer does not disturb the attachment");

  connection.incoming.push(encodeTerminalControl("writer_epoch", 7n, {
    writerEpoch: 5,
    writerClientInstanceId: "client-1",
    accessMode: "writer",
  }));
  await waitUntil(() => states.at(-1)?.accessMode === "writer", "the notice seats the attachment as the writer");
  await runtime.sendTerminalResponse(terminalResponseFor(attached, "[1;1R"));
  assert.equal(inputFrames(connection).length, 1, "a writer's answer reaches the PTY exactly once");
  await runtime.shutdown();
});

async function interrupt(system, runtime, tabId) {
  system.connections.at(-1).incoming.close();
  await waitUntil(
    () => runtime.listTerminals().find((terminal) => terminal.tabId === tabId)?.state === "interrupted",
    "terminal did not become interrupted",
  );
}

function handshake(connection) {
  return connection.sent.map(decodeTerminalFrame).map((frame) => frame?.type);
}

test("the initial RESIZE on reconnect follows the seat READY names, not the seat held before the interruption", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(attached.accessMode, "writer");
  await interrupt(system, runtime, "tab-a");
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 2 });
  const demoted = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(demoted.accessMode, "observer");
  assert.deepEqual(
    handshake(system.connections.at(-1)),
    ["resume"],
    "a reconnect that lands as an observer sends no RESIZE (the gateway closes an observer's attachment for one)",
  );
  await runtime.shutdown();

  const mirror = new FakeTerminalSystem();
  mirror.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  const second = createRuntime(mirror);
  const observed = await second.runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(observed.accessMode, "observer");
  assert.deepEqual(handshake(mirror.connections.at(-1)), ["resume"], "an observer attach sends no RESIZE");
  await interrupt(mirror, second.runtime, "tab-a");
  mirror.seatOnReady.set("agent-a", { accessMode: "writer", writerEpoch: 2 });
  const promoted = await second.runtime.reconnect({ tabId: "tab-a" });
  assert.equal(promoted.accessMode, "writer");
  assert.deepEqual(
    handshake(mirror.connections.at(-1)),
    ["resize", "resume"],
    "a reconnect that lands as the writer restores the PTY geometry before resuming",
  );
  assert.deepEqual(decodeTerminalControl(decodeTerminalFrame(mirror.connections.at(-1).sent[0])), { columns: 80, rows: 24 });
  await second.runtime.shutdown();
});

test("a seat held at any point is remembered across reconnects: landing as an observer afterwards is a transfer", async () => {
  // Arm 1: the seat was taken on a reconnect READY (never on attach), so the
  // memory can only come from the reconnect path.
  const system = new FakeTerminalSystem();
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  const { runtime, states } = createRuntime(system);
  const observed = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  assert.equal(observed.accessMode, "observer");
  await interrupt(system, runtime, "tab-a");
  system.seatOnReady.set("agent-a", { accessMode: "writer", writerEpoch: 2 });
  const seated = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(seated.accessMode, "writer");
  assert.equal(seated.writerEpoch, 2);
  await interrupt(system, runtime, "tab-a");
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 3 });
  const createCallsBefore = system.createCalls.length;
  const demoted = await runtime.reconnect({ tabId: "tab-a" });
  assert.equal(demoted.accessMode, "observer");
  const asked = system.createCalls[createCallsBefore];
  assert.equal(asked.accessMode, "writer", "a former writer reclaims its seat by name");
  assert.equal(asked.expectedWriterEpoch, 2, "at the epoch it last held");
  assert.equal(states.at(-1).accessMode, "observer");
  assert.equal(states.at(-1).reason, "writer_transferred", "landing as an observer after holding the seat is a transfer");
  await runtime.shutdown();

  // Arm 2: the seat was held from attach.
  const held = new FakeTerminalSystem();
  const second = createRuntime(held);
  await second.runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await interrupt(held, second.runtime, "tab-a");
  held.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 2 });
  await second.runtime.reconnect({ tabId: "tab-a" });
  assert.equal(held.createCalls[1].accessMode, "writer");
  assert.equal(held.createCalls[1].expectedWriterEpoch, 1);
  assert.equal(second.states.at(-1).reason, "writer_transferred");
  await second.runtime.shutdown();

  // Negative control: a seat never held is not "transferred" when a reconnect
  // observes, and no epoch is asked for.
  const never = new FakeTerminalSystem();
  never.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  const third = createRuntime(never);
  await third.runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
  await interrupt(never, third.runtime, "tab-a");
  const reconnected = await third.runtime.reconnect({ tabId: "tab-a" });
  assert.equal(reconnected.accessMode, "observer");
  assert.equal(never.createCalls[1].accessMode, "observer");
  assert.equal(never.createCalls[1].expectedWriterEpoch, undefined, "an observer that never held the seat expects no epoch");
  assert.equal(third.states.at(-1).reason, undefined, "an observer that never held the seat was not demoted");
  await third.runtime.shutdown();
});


test("writer transfer refuses unavailable exact-session capability before dispatch", async () => {
  for (const variant of ["missing", "legacy", "sibling", "expired"]) {
    const system = new FakeTerminalSystem();
    system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
    let calls = 0;
    system.controlPlane.transferTerminalWriter = async () => { calls++; throw new Error("unexpected transfer"); };
    const { runtime } = createRuntime(system);
    try {
      await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      system.controlPlane.discoverCapabilities = async () => {
        const value = capabilitySnapshot(variant === "sibling" ? "agent-b" : "agent-a");
        if (variant === "missing") value.capabilities.pop();
        if (variant === "legacy") value.capabilities[1] = { ...value.capabilities[1], availability: "unsupported", reasonCode: "supervisor_writer_operation_unavailable" };
        if (variant === "expired") value.expiresAt = new Date(NOW).toISOString();
        return value;
      };
      await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), error =>
        error instanceof RuntimeBoundaryError && error.code.startsWith("capability_") &&
        (variant !== "legacy" || error.safeDetails?.reason_code === "supervisor_writer_operation_unavailable"));
      assert.equal(calls, 0, variant);
      await assert.rejects(runtime.sendInput(new Uint8Array([65]), "tab-a"), error => error.code === "terminal_observer");
    } finally { await runtime.shutdown(); }
  }
});

test("expired writer snapshot refreshes exact-session evidence before transfer and waits for the seat notice", async () => {
  const system = new FakeTerminalSystem(); let now = NOW;
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  system.controlPlane.discoverCapabilities = async (_scope, id) => capabilitySnapshot(id, { expiresAt: new Date(NOW + 1_000).toISOString() });
  const { runtime, states } = createRuntime(system, { clock: () => now });
  const reads = [], transfers = [];
  try {
    const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    now += 1_001;
    assert.ok(attached.writerTransferCapability.expiresAt < now);
    system.controlPlane.discoverCapabilities = async (scope, id) => {
      reads.push({ scope, id });
      return capabilitySnapshot(id, { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 59_000).toISOString(), etag: "fresh-writer-evidence" });
    };
    system.controlPlane.transferTerminalWriter = async request => {
      transfers.push(request);
      return { agentSessionId: request.agentSessionId, processEpoch: "epoch-agent-a", writerEpoch: 2,
        writerClientInstanceId: request.clientInstanceId, transferPending: false,
        operationId: request.operationId, operationState: "committed" };
    };
    const requested = await runtime.takeWriter({ tabId: "tab-a" });
    assert.deepEqual(reads, [{ scope: "agent_session", id: "agent-a" }]);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].capabilityEvidence.snapshotEtag, "fresh-writer-evidence");
    assert.equal(transfers[0].capabilityEvidence.subjectId, "agent-a");
    assert.ok(transfers[0].capabilityEvidence.expiresAt > now);
    assert.equal(transfers[0].expectedWriterEpoch, 1);
    assert.equal(requested.accessMode, "observer");
    await assert.rejects(runtime.sendInput(Uint8Array.of(65), "tab-a"), error => error.code === "terminal_observer");
    system.connections[0].incoming.push(encodeTerminalControl("writer_epoch", 3n, {
      writerEpoch: 2, writerClientInstanceId: "client-1", accessMode: "writer",
    }));
    await waitUntil(() => states.at(-1)?.accessMode === "writer", "fresh transfer is seated by its server notice");
    await runtime.sendInput(Uint8Array.of(66), "tab-a");
    assert.equal(decodeTerminalFrame(system.connections[0].sent.at(-1)).type, "input");
  } finally { await runtime.shutdown(); }
});

test("expired writer snapshot cannot authorize transfer when refreshed evidence is refused", async () => {
  for (const variant of ["unknown", "unsupported", "expired", "sibling"]) {
    const system = new FakeTerminalSystem(); let now = NOW;
    system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
    system.controlPlane.discoverCapabilities = async (_scope, id) => capabilitySnapshot(id, { expiresAt: new Date(NOW + 1_000).toISOString() });
    const { runtime } = createRuntime(system, { clock: () => now });
    let transfers = 0; const reads = [];
    try {
      const attached = await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      now += 1_001;
      assert.ok(attached.writerTransferCapability.expiresAt < now);
      system.controlPlane.discoverCapabilities = async (scope, id) => {
        reads.push({ scope, id });
        const evidence = capabilitySnapshot(variant === "sibling" ? "agent-b" : id, {
          observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 59_000).toISOString(),
        });
        if (variant === "unknown" || variant === "unsupported") evidence.capabilities[1].availability = variant;
        if (variant === "expired") evidence.expiresAt = new Date(now).toISOString();
        return evidence;
      };
      system.controlPlane.transferTerminalWriter = async () => { transfers++; throw new Error("unexpected transfer"); };
      const expected = { unknown: "capability_unknown", unsupported: "capability_unsupported", expired: "capability_snapshot_expired", sibling: "capability_scope_mismatch" }[variant];
      await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), error => error.code === expected, variant);
      assert.deepEqual(reads, [{ scope: "agent_session", id: "agent-a" }]);
      assert.equal(transfers, 0, variant);
      await assert.rejects(runtime.sendInput(Uint8Array.of(65), "tab-a"), error => error.code === "terminal_observer");
    } finally { await runtime.shutdown(); }
  }
});

test("heartbeat renews exact writer capability and keeps unavailable leases disabled", async () => {
  const system = new FakeTerminalSystem(); let now = NOW; let reads = 0;
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  const { runtime, states } = createRuntime(system, { clock: () => now, heartbeatTimeoutMs: 120_000 });
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    system.controlPlane.discoverCapabilities = async (_scope, id) => {
      reads++;
      const value = capabilitySnapshot(id, { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 59_000).toISOString() });
      if (reads === 1) value.capabilities[1] = { ...value.capabilities[1], availability: "unsupported", reasonCode: "supervisor_writer_operation_unavailable" };
      return value;
    };
    now += 54_000;
    system.connections[0].incoming.push(encodeTerminalControl("heartbeat", 1n, {}));
    await waitUntil(() => states.at(-1)?.writerTransferCapability?.reasonCode === "supervisor_writer_operation_unavailable", "unsupported refreshed lease");
    assert.equal(reads, 1);
    now += 54_000;
    system.connections[0].incoming.push(encodeTerminalControl("heartbeat", 2n, {}));
    await waitUntil(() => states.at(-1)?.writerTransferCapability?.supported === true, "support renewed");
    assert.equal(reads, 2);
    assert.equal(states.at(-1).accessMode, "observer");
  } finally { await runtime.shutdown(); }
});

test("lost terminal issuance is cancelled with its original request despite failed capability discovery", async () => {
  const system = new FakeTerminalSystem();
  let issued; const cancellations = [];
  system.controlPlane.createTerminalConnection = async request => {
    issued = request;
    system.controlPlane.discoverCapabilities = async () => { throw new Error("discovery offline"); };
    throw new Error("issuance response lost");
  };
  system.controlPlane.cancelTerminalConnection = async request => { cancellations.push(request); return { cancelled: true }; };
  const { runtime } = createRuntime(system);
  try {
    await assert.rejects(runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 }), /issuance response lost/);
    assert.equal(cancellations.length, 1);
    const { signal: originalSignal, ...original } = issued;
    const { signal: recoverySignal, ...recovery } = cancellations[0];
    assert.deepEqual(recovery, original);
    assert.notEqual(recoverySignal, originalSignal);
    assert.equal(recoverySignal.aborted, false);
    assert.equal(system.connections.length, 0);
  } finally { await runtime.shutdown(); }
});

test("unconfirmed issuance cancellation retains the exact key for shutdown recovery", async () => {
  const system = new FakeTerminalSystem(); const cancellations = [];
  system.controlPlane.createTerminalConnection = async () => { throw new Error("issuance response lost"); };
  system.controlPlane.cancelTerminalConnection = async request => {
    cancellations.push(request);
    if (cancellations.length === 1) throw new Error("cancellation response lost");
    return { cancelled: true };
  };
  const { runtime } = createRuntime(system);
  await assert.rejects(runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 }), /cancellation is unconfirmed/);
  await runtime.shutdown();
  assert.equal(cancellations.length, 2);
  assert.equal(cancellations[0].idempotencyKey, cancellations[1].idempotencyKey);
  assert.equal(cancellations[0].agentSessionId, cancellations[1].agentSessionId);
});

test("a confirmed cancelled reconnect issuance never reuses its fenced key", async () => {
  const system = new FakeTerminalSystem(); const cancelled = []; const requests = [];
  const create = system.controlPlane.createTerminalConnection;
  const { runtime } = createRuntime(system);
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    await system.connections[0].close();
    await waitUntil(() => runtime.listTerminals()[0]?.state === "interrupted", "original connection interrupted");
    system.controlPlane.createTerminalConnection = async request => {
      requests.push(request);
      if (requests.length === 1) throw new Error("lost reconnect issuance");
      assert.equal(cancelled.some(item => item.idempotencyKey === request.idempotencyKey), false, "new issuance cannot reuse a cancellation tombstone");
      return create(request);
    };
    system.controlPlane.cancelTerminalConnection = async request => { cancelled.push(request); return { cancelled: true }; };
    await assert.rejects(runtime.reconnect({ tabId: "tab-a" }), /lost reconnect issuance/);
    assert.equal(cancelled[0].idempotencyKey, requests[0].idempotencyKey);
    await runtime.reconnect({ tabId: "tab-a" });
    assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  } finally { await runtime.shutdown(); }
});

test("writer operation retries preserve ID and original epoch until a writer notice", async () => {
  const system = new FakeTerminalSystem();
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  const calls = [];
  system.controlPlane.transferTerminalWriter = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw Object.assign(new Error("unknown"), { details: { reason: "terminal_writer_outcome_unknown" } });
    return { agentSessionId: input.agentSessionId, processEpoch: `epoch-${input.agentSessionId}`,
      writerEpoch: 2, writerClientInstanceId: input.clientInstanceId, transferPending: true,
      operationId: input.operationId, operationState: "committed" };
  };
  const { runtime, states } = createRuntime(system);
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), /unknown/);
    assert.match(calls[0].operationId, /^[0-9a-f-]{36}$/);
    const discover = system.controlPlane.discoverCapabilities;
    system.controlPlane.discoverCapabilities = async () => { throw new Error("capability offline"); };
    await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), /capability offline/);
    assert.equal(calls.length, 1);
    system.controlPlane.discoverCapabilities = discover;
    const pending = await runtime.takeWriter({ tabId: "tab-a" });
    assert.equal(pending.accessMode, "observer");
    await runtime.takeWriter({ tabId: "tab-a" });
    assert.deepEqual(calls.map(({ operationId, expectedWriterEpoch }) => ({ operationId, expectedWriterEpoch })),
      Array(3).fill({ operationId: calls[0].operationId, expectedWriterEpoch: 1 }));
    await assert.rejects(runtime.sendInput(new TextEncoder().encode("early"), "tab-a"), error => error.code === "terminal_observer");
    system.connections.at(-1).incoming.push(encodeTerminalControl("writer_epoch", 3n, { writerEpoch: 2, writerClientInstanceId: "client-1", accessMode: "writer" }));
    await waitUntil(() => states.at(-1)?.accessMode === "writer", "notice grants writer");
    await runtime.takeWriter({ tabId: "tab-a" });
    assert.equal(calls.length, 3);
  } finally { await runtime.shutdown(); }
});

test("writer operation concurrent attempts share one request and a later notice supersedes its reply", async () => {
  const system = new FakeTerminalSystem();
  system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  system.controlPlane.transferTerminalWriter = async input => {
    calls.push(input); await gate;
    return { agentSessionId: input.agentSessionId, processEpoch: `epoch-${input.agentSessionId}`, writerEpoch: 2,
      writerClientInstanceId: input.clientInstanceId, transferPending: false, operationId: input.operationId, operationState: "committed" };
  };
  const { runtime, states } = createRuntime(system);
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    const first = runtime.takeWriter({ tabId: "tab-a" }); const second = runtime.takeWriter({ tabId: "tab-a" });
    await waitUntil(() => calls.length > 0, "request dispatched");
    assert.equal(calls.length, 1);
    system.connections.at(-1).incoming.push(encodeTerminalControl("writer_epoch", 3n, { writerEpoch: 3, writerClientInstanceId: "client-9", accessMode: "observer" }));
    await waitUntil(() => states.at(-1)?.writerEpoch === 3, "newer notice received");
    release(); await Promise.all([first, second]);
    assert.equal(states.at(-1).writerEpoch, 3); assert.equal(states.at(-1).writerClientInstanceId, "client-9");
  } finally { release(); await runtime.shutdown(); }
});

test("writer operation rejects substituted operation and noncommitted result without seating", async () => {
  for (const substitute of [{ operationId: "00000000-0000-4000-8000-000000000099" }, { operationState: "cancelled" }]) {
    const system = new FakeTerminalSystem(); system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
    system.controlPlane.transferTerminalWriter = async input => ({ agentSessionId: input.agentSessionId, processEpoch: `epoch-${input.agentSessionId}`,
      writerEpoch: 2, writerClientInstanceId: input.clientInstanceId, transferPending: false, operationId: input.operationId, operationState: "committed", ...substitute });
    const { runtime, states } = createRuntime(system);
    try {
      await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), error => error.code === "grant_scope_mismatch");
      assert.equal(states.at(-1).accessMode, "observer"); assert.equal(states.at(-1).writerEpoch, 1);
    } finally { await runtime.shutdown(); }
  }
});

test("writer operation cancellation ends its ID while an in-progress refusal retains it", async () => {
  for (const reason of ["terminal_writer_cancelled", "terminal_writer_transfer_in_progress"]) {
    const system = new FakeTerminalSystem(); system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 }); const calls = [];
    system.controlPlane.transferTerminalWriter = async input => { calls.push(input); throw Object.assign(new Error(reason), { details: { reason } }); };
    const { runtime } = createRuntime(system);
    try {
      await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      await assert.rejects(runtime.takeWriter({ tabId: "tab-a" })); await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }));
      assert.match(calls[0].operationId, /^[0-9a-f-]{36}$/);
      assert.equal(calls[0].operationId === calls[1].operationId, reason === "terminal_writer_transfer_in_progress");
    } finally { await runtime.shutdown(); }
  }
});

test("held issuance cancellation reports cleanup timeout and retains original key", async () => {
  const system = new FakeTerminalSystem(); let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  system.controlPlane.createTerminalConnection = async () => { throw new Error("issuance lost"); };
  system.controlPlane.cancelTerminalConnection = async request => { calls.push(request); if (calls.length === 1) await gate; return { cancelled: true }; };
  const { runtime } = createRuntime(system, { readyTimeoutMs: 20 });
  try {
    await assert.rejects(runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 }), error =>
      error instanceof AggregateError && error.errors.some(nested => nested instanceof RuntimeBoundaryError && nested.code === "runtime_cleanup_timeout" && nested.retryable && /issuance cancellation/.test(nested.message)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
  } finally { release(); await runtime.shutdown(); }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test("writer notice during capability read prevents a superseded operation POST", async () => {
  for (const accessMode of ["writer", "observer"]) {
    const system = new FakeTerminalSystem(); system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
    let release; const gate = new Promise(resolve => { release = resolve; }); let reads = 0; let calls = 0;
    system.controlPlane.transferTerminalWriter = async () => { calls++; throw new Error("superseded POST"); };
    const { runtime, states } = createRuntime(system);
    try {
      await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      system.controlPlane.discoverCapabilities = async () => { reads++; await gate; return capabilitySnapshot("agent-a"); };
      const outcome = runtime.takeWriter({ tabId: "tab-a" }).then(value => ({ value }), error => ({ error }));
      await waitUntil(() => reads === 1, "capability read held");
      system.connections[0].incoming.push(encodeTerminalControl("writer_epoch", 3n, { writerEpoch: 2, writerClientInstanceId: accessMode === "writer" ? "client-1" : "other-client", accessMode }));
      await waitUntil(() => states.at(-1)?.writerEpoch === 2, "new authority received");
      release(); const result = await outcome;
      assert.equal(calls, 0);
      if (accessMode === "writer") assert.equal(result.value?.accessMode, "writer");
      else assert.equal(result.error?.code, "session_conflict");
    } finally { release(); await runtime.shutdown(); }
  }
});

test("older background capability response cannot overwrite newer transfer refusal", async () => {
  const system = new FakeTerminalSystem(); system.seatOnReady.set("agent-a", { accessMode: "observer", writerEpoch: 1 });
  let now = NOW; let release; const gate = new Promise(resolve => { release = resolve; }); let reads = 0;
  const { runtime, states } = createRuntime(system, { clock: () => now, heartbeatTimeoutMs: 120_000 });
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    system.controlPlane.discoverCapabilities = async () => {
      const read = ++reads;
      const evidence = capabilitySnapshot("agent-a", { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 59_000).toISOString() });
      if (read === 1) await gate;
      else evidence.capabilities[1] = { ...evidence.capabilities[1], availability: "unsupported", reasonCode: "supervisor_writer_operation_unavailable" };
      return evidence;
    };
    now += 54_000;
    system.connections[0].incoming.push(encodeTerminalControl("heartbeat", 1n, {}));
    await waitUntil(() => reads === 1, "background read held");
    await assert.rejects(runtime.takeWriter({ tabId: "tab-a" }), error => error.code === "capability_unsupported");
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(states.at(-1).writerTransferCapability.reasonCode, "supervisor_writer_operation_unavailable");
    assert.equal(states.at(-1).writerTransferCapability.supported, false);
  } finally { release(); await runtime.shutdown(); }
});

test('HTTP-ahead writer epoch tolerates older queued noncritical wire notices',async()=>{
 const system=new FakeTerminalSystem();system.seatOnReady.set('agent-a',{accessMode:'observer',writerEpoch:1});
 system.controlPlane.transferTerminalWriter=async input=>({agentSessionId:input.agentSessionId,processEpoch:'epoch-'+input.agentSessionId,
  writerEpoch:2,writerClientInstanceId:input.clientInstanceId,transferPending:true,operationId:input.operationId,operationState:'committed'});
 const {runtime}=createRuntime(system);
 try{
  await runtime.attach({tabId:'tab-a',agentSessionId:'agent-a',columns:60,rows:22});
  await runtime.takeWriter({tabId:'tab-a'});
  assert.equal(runtime.listTerminals()[0].writerEpoch,2);
  assert.equal(runtime.listTerminals()[0].accessMode,'observer','HTTP does not promote local input');
  assert.equal(runtime.listTerminals()[0].geometry,null,'HTTP epoch change leaves geometry unknown');
  await assert.rejects(runtime.sendInput(new TextEncoder().encode('forbidden'),'tab-a'),{code:'terminal_observer'});
  const wire=system.connections[0];
  const lowerSeat=encodeTerminalControl('writer_epoch',1n,{writerEpoch:1,writerClientInstanceId:'client-1',accessMode:'writer'});lowerSeat[5]=0;
  wire.incoming.push(lowerSeat);
  wire.incoming.push(geometryWire({columns:143,rows:51,writerEpoch:1}));
  wire.incoming.push(encodeTerminalControl('writer_epoch',1n,{writerEpoch:2,writerClientInstanceId:'client-1',accessMode:'writer'}));
  wire.incoming.push(geometryWire({columns:167,rows:59,writerEpoch:2}));
  await waitUntil(()=>runtime.listTerminals()[0].state==='failed'||runtime.listTerminals()[0].geometry?.columns===167,'wire settles');
  assert.equal(runtime.listTerminals()[0].state,'active');
  assert.equal(runtime.listTerminals()[0].geometry.columns,167);
  assert.equal(runtime.listTerminals()[0].accessMode,'writer','only current wire notice grants the seat');
  assert.equal(wire.closeCalls.length,0);
 }finally{await runtime.shutdown();}
});

for(const scenario of ['foreign-writer','contradiction','ready-contradiction']){
 test('writer notice truth: '+scenario,async()=>{
  const system=new FakeTerminalSystem();
  if(scenario!=='ready-contradiction')system.seatOnReady.set('agent-a',{accessMode:'observer',writerEpoch:1});
  const {runtime}=createRuntime(system);
  try{
   await runtime.attach({tabId:'tab-a',agentSessionId:'agent-a',columns:60,rows:22});
   const wire=system.connections[0];
   if(scenario==='contradiction'){
    wire.incoming.push(encodeTerminalControl('writer_epoch',1n,{writerEpoch:2,writerClientInstanceId:'client-1',accessMode:'writer'}));
    await waitUntil(()=>runtime.listTerminals()[0].writerEpoch===2,'first valid notice');
   }
   const notice=scenario==='foreign-writer'
    ?{writerEpoch:2,writerClientInstanceId:'foreign-client',accessMode:'writer'}
    :{writerEpoch:scenario==='ready-contradiction'?1:2,writerClientInstanceId:'other',accessMode:'observer'};
   wire.incoming.push(encodeTerminalControl('writer_epoch',2n,notice));
   await new Promise(resolve=>setTimeout(resolve,20));
   assert.equal(runtime.listTerminals()[0].state,'failed',scenario);
   assert.equal(wire.sent.map(decodeTerminalFrame).some(frame=>frame.type==='input'),false);
  }finally{await runtime.shutdown();}
 });
}

for (const scope of ["reconnect", "writer_epoch"]) {
  for (const previouslyAcknowledged of [false, true]) {
    test(`input acceptance scope ${scope} retains only actual historical uncertainty: ${previouslyAcknowledged}`, async () => {
      const system = new FakeTerminalSystem();
      const { runtime } = createRuntime(system);
      try {
        await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
        let wire = system.connections[0];
        await runtime.sendInput(new TextEncoder().encode("old"), "tab-a");
        const oldSequence = runtime.listTerminals()[0].inputSequence;
        const ack = sequence => encodeTerminalControl("acknowledgement", 1n, {
          clientSequence: sequence.toString(), meaning: "durably_accepted_not_executed",
        });
        if (previouslyAcknowledged) {
          wire.incoming.push(ack(oldSequence));
          await waitUntil(() => runtime.listTerminals()[0].inputContinuity === "complete", "old acceptance ACK");
        }
        if (scope === "reconnect") {
          wire.incoming.close();
          await waitUntil(() => runtime.listTerminals()[0].state === "interrupted", "old connection closed");
          assert.equal(runtime.listTerminals()[0].historicalInputUncertainty, !previouslyAcknowledged, "transport loss retires pending input before any reconnect");
          await runtime.reconnect({ tabId: "tab-a" });
          wire = system.connections[1];
          assert.equal(wire.sent.map(decodeTerminalFrame).some(frame => frame.type === "input"), false, "uncertain bytes are never replayed");
        } else {
          wire.incoming.push(encodeTerminalControl("writer_epoch", 1n, { writerEpoch: 2, writerClientInstanceId: "other", accessMode: "observer" }));
          await waitUntil(() => runtime.listTerminals()[0].writerEpoch === 2, "writer loss");
          wire.incoming.push(encodeTerminalControl("writer_epoch", 2n, { writerEpoch: 3, writerClientInstanceId: "client-1", accessMode: "writer" }));
          await waitUntil(() => runtime.listTerminals()[0].writerEpoch === 3, "writer reacquired on same attachment");
        }
        await runtime.sendInput(new TextEncoder().encode("new"), "tab-a");
        const freshSequence = runtime.listTerminals()[0].inputSequence;
        wire.incoming.push(ack(freshSequence));
        await waitUntil(() => runtime.listTerminals()[0].acknowledgedInputSequence === freshSequence, "fresh scope acceptance ACK");
        assert.equal(runtime.listTerminals()[0].inputContinuity, previouslyAcknowledged ? "complete" : "uncertain");
        if (!previouslyAcknowledged) {
          wire.incoming.push(ack(oldSequence));
          await new Promise(resolve => setTimeout(resolve, 15));
          assert.equal(runtime.listTerminals()[0].state, "active", "late retired ACK must not break the current attachment");
          assert.equal(runtime.listTerminals()[0].inputContinuity, "uncertain", "late receipt cannot erase retired uncertainty");
        }
      } finally { await runtime.shutdown(); }
    });
  }
}

test("input acceptance scope reconnect releases the bounded current window without forgetting history", async () => {
  const system = new FakeTerminalSystem();
  const { runtime } = createRuntime(system);
  try {
    await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
    for (let index = 0; index < 4096; index++) await runtime.sendInput(new Uint8Array([120]), "tab-a");
    system.connections[0].incoming.close();
    await waitUntil(() => runtime.listTerminals()[0].state === "interrupted", "full uncertain window disconnected");
    await runtime.reconnect({ tabId: "tab-a" });
    await runtime.sendInput(new Uint8Array([121]), "tab-a");
    const sequence = runtime.listTerminals()[0].inputSequence;
    system.connections[1].incoming.push(encodeTerminalControl("acknowledgement", 1n, { clientSequence: sequence.toString(), meaning: "durably_accepted_not_executed" }));
    await waitUntil(() => runtime.listTerminals()[0].acknowledgedInputSequence === sequence, "new window progresses");
    assert.equal(runtime.listTerminals()[0].inputContinuity, "uncertain");
    assert.equal(system.connections[1].sent.map(decodeTerminalFrame).filter(frame => frame.type === "input").length, 1);
  } finally { await runtime.shutdown(); }
});

for (const variant of ["gap", "unknown", "wrong-reason", "missing-reason"]) {
  const gap = variant === "gap";
  test(`real codec error projects retained history gap through foreground: ${variant}`, async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const { ForegroundTerminalCoordinator } = await import("../dist/terminal/foreground.js");
    const coordinator = new ForegroundTerminalCoordinator({ host: {
      dimensions: () => ({ columns: 80, rows: 24 }),
      async acquire() { return { async restore() {} }; },
      async write() {}, onInput() { return () => {}; }, onResize() { return () => {}; },
    } });
    const system = new FakeTerminalSystem();
    const { runtime } = createRuntime(system, coordinator.runtimeCallbacks());
    coordinator.bindRuntime(runtime);
    try {
      await coordinator.start([{ tabId: "tab-a", agentSessionId: sessionId, label: "synthetic", agent: "codex" }]);
      const payload = {
        code: variant === "unknown" ? "unknown_provider_failure" : "continuity_incomplete",
        retryable: false, ...(variant === "missing-reason" ? {} : { safeReason: gap ? "retained_output_gap" : "untrusted-message" }),
      };
      system.connections[0].incoming.push(variant === "missing-reason"
        ? encodeTerminalFrame({ type: "error", sequence: 1n, payload: new TextEncoder().encode(JSON.stringify(payload)) })
        : encodeTerminalControl("error", 1n, payload));
      await waitUntil(() => coordinator.failure !== undefined, "foreground receives typed runtime failure");
      assert.equal(coordinator.failure.code, gap ? "terminal_history_gap" : "terminal_protocol_error");
      assert.equal(coordinator.failure.retryable, false);
      if (gap) {
        assert.equal(coordinator.failure.safeDetails.process_state, "unknown");
        assert.equal(coordinator.failure.safeDetails.agent_session_id, sessionId);
        assert.match(coordinator.failure.message, /earlier output is no longer available.*agent's current state is unknown/u);
      }
      assert.equal(system.connections.length, 1, "no automatic replacement attachment");
    } finally { await coordinator.stop(); await runtime.shutdown(); }
  });
}

for (const code of ["opencode_server_exited", "unknown_provider_failure"]) {
  test(`terminal provider error uses only an exact known message: ${code}`, async () => {
    const system = new FakeTerminalSystem();
    const { runtime } = createRuntime(system);
    try {
      system.connectionsWithoutReady.add(1);
      const opening = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      const checked = assert.rejects(opening, error => {
        assert.equal(error.safeDetails?.reason, code);
        if (code === "opencode_server_exited") {
          assert.match(error.message, /OpenCode's server stopped.*Inspect this session/);
          assert.equal(error.retryable, false);
        } else {
          assert.equal(error.message, "The Cuna terminal gateway rejected the connection.");
          assert.equal(error.retryable, true);
        }
        return true;
      });
      await waitUntil(() => system.connections.length === 1, "initial provider connection");
      system.connections[0].incoming.push(encodeTerminalControl("error", 0n, { code, retryable: true, safeReason: "provider_unavailable" }));
      await checked;
      assert.equal(system.createCalls.length, 1, "no replacement or automatic retry");
    } finally { await runtime.shutdown(); }
  });
}

for (const phase of ["initial", "live", "reconnect"]) {
  test(`input recovery ERROR is permanent and preserves its specific reason: ${phase}`, async () => {
    const system = new FakeTerminalSystem();
    const { runtime } = createRuntime(system);
    const errorFrame = encodeTerminalControl("error", 0n, {
      code: "terminal_input_recovery_required", retryable: false, safeReason: "input_acceptance_unavailable",
    });
    try {
      if (phase === "initial") {
        system.connectionsWithoutReady.add(1);
        const opening = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
        const checked = assert.rejects(opening, error => error.retryable === false && error.safeDetails?.reason === "terminal_input_recovery_required");
        await waitUntil(() => system.connections.length === 1, "exact initial connection");
        system.connections[0].incoming.push(errorFrame); await checked;
        assert.equal(runtime.listTerminals().length, 0);
      } else {
        await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
        if (phase === "reconnect") {
          system.connections[0].incoming.close();
          await waitUntil(() => runtime.listTerminals()[0].state === "interrupted", "old transport ended");
          system.connectionsWithoutReady.add(2);
          const opening = runtime.reconnect({ tabId: "tab-a" });
          const checked = assert.rejects(opening, error => error.retryable === false && error.safeDetails?.reason === "terminal_input_recovery_required");
          await waitUntil(() => system.connections.length === 2, "exact recovery connection");
          system.connections[1].incoming.push(errorFrame); await checked;
        } else system.connections[0].incoming.push(errorFrame);
        await waitUntil(() => runtime.listTerminals()[0].state === "failed", "permanent input recovery refusal");
        assert.equal(runtime.listTerminals()[0].reason, "terminal_input_recovery_required");
        await assert.rejects(runtime.reconnect({ tabId: "tab-a" }), error => error.code === "session_conflict");
      }
      assert.equal(system.createCalls.length, phase === "reconnect" ? 2 : 1, "no automatic replacement or retry");
    } finally { await runtime.shutdown(); }
  });
}

test("a remote ERROR frame's bounded code is kept beside the protocol failure; unbounded text is not", async () => {
  // Production 2026-09-06 (AgentSession 4ce7fd8d): the supervisor failed every
  // attached view with `view.lease_expired`, and the CLI could only say
  // `terminal_protocol_error`. The remote code is a rendering aid, never the
  // failure classification, and only an identifier-shaped code survives.
  for (const [code, expected] of [["view.lease_expired", "view.lease_expired"], ["Not An Identifier; secret=x", undefined]]) {
    const system = new FakeTerminalSystem();
    const { runtime } = createRuntime(system);
    try {
      await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
      system.connections[0].incoming.push(encodeTerminalControl("error", 0n, { code, retryable: false, safeReason: code }));
      await waitUntil(() => runtime.listTerminals()[0].state === "failed", "remote error fails the attachment");
      const terminal = runtime.listTerminals()[0];
      assert.equal(terminal.reason, "terminal_protocol_error");
      assert.equal(terminal.remoteReason, expected);
      assert.equal(system.createCalls.length, 1, "no automatic replacement or retry");
    } finally { await runtime.shutdown(); }
  }
});

for (const phase of ["initial", "live", "reconnect"]) {
  test(`history gap ERROR is permanent and preserves its specific reason: ${phase}`, async () => {
    const system = new FakeTerminalSystem();
    const { runtime } = createRuntime(system);
    const errorFrame = encodeTerminalControl("error", 0n, {
      code: "continuity_incomplete", retryable: false, safeReason: "retained_output_gap",
    });
    try {
      if (phase === "initial") {
        system.connectionsWithoutReady.add(1);
        const opening = runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
        const checked = assert.rejects(opening, error => error.retryable === false && error.safeDetails?.reason === "retained_output_gap");
        await waitUntil(() => system.connections.length === 1, "exact initial connection");
        system.connections[0].incoming.push(errorFrame); await checked;
        assert.equal(runtime.listTerminals().length, 0);
      } else {
        await runtime.attach({ tabId: "tab-a", agentSessionId: "agent-a", columns: 80, rows: 24 });
        if (phase === "reconnect") {
          system.connections[0].incoming.close();
          await waitUntil(() => runtime.listTerminals()[0].state === "interrupted", "old transport ended");
          system.connectionsWithoutReady.add(2);
          const opening = runtime.reconnect({ tabId: "tab-a" });
          const checked = assert.rejects(opening, error => error.retryable === false && error.safeDetails?.reason === "retained_output_gap");
          await waitUntil(() => system.connections.length === 2, "exact recovery connection");
          system.connections[1].incoming.push(errorFrame); await checked;
        } else system.connections[0].incoming.push(errorFrame);
        await waitUntil(() => runtime.listTerminals()[0].state === "failed", "permanent input recovery refusal");
        assert.equal(runtime.listTerminals()[0].reason, "terminal_history_gap");
        await assert.rejects(runtime.reconnect({ tabId: "tab-a" }), error => error.code === "session_conflict");
      }
      assert.equal(system.createCalls.length, phase === "reconnect" ? 2 : 1, "no automatic replacement or retry");
    } finally { await runtime.shutdown(); }
  });
}
