import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEMON_PROTOCOL_VERSION,
  IpcFrameDecoder,
  IpcProtocolError,
  MAX_IPC_FRAME_BYTES,
  decodeIpcFrame,
  decodeIpcMessage,
  encodeIpcFrame,
  encodeIpcMessage,
  negotiateDaemonProtocol,
} from "../dist/daemon/protocol.js";
import { EndpointSecurityError, assertSameUserPeer, deriveDaemonEndpoint } from "../dist/daemon/endpoint.js";
import { FencedLeaseStore, LeaseError } from "../dist/daemon/lease.js";
import {
  DurableIntentJournal,
  JournalError,
  MemoryJournalStorage,
} from "../dist/daemon/journal.js";
import { ProcessSupervisorModel, SupervisorError } from "../dist/daemon/supervisor.js";
import { LocalClientViewRegistry, ViewIsolationError } from "../dist/daemon/views.js";
import { DaemonLifecycle } from "../dist/daemon/lifecycle.js";
import {
  MAX_TERMINAL_FRAME_BYTES,
  TerminalFrameDecoder,
  TerminalProtocolError,
  assertTerminalFrameLegal,
  decodeTerminalControl,
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
} from "../dist/terminal/codec.js";
import { AttachmentError, ExclusiveAttachmentSession } from "../dist/terminal/resume.js";
import { ViewportIsolationError, ViewportRegistry } from "../dist/terminal/viewport.js";
import { buildAppbarModel, projectTruth } from "../dist/terminal/appbar.js";
import { HostTerminalLease, selectTerminalMode } from "../dist/terminal/mode.js";

const text = new TextEncoder();
const digestA = `sha256:${"a".repeat(64)}`;

test("daemon IPC negotiates one version and preserves fragmented binary frames", () => {
  assert.equal(negotiateDaemonProtocol(1, 2), DAEMON_PROTOCOL_VERSION);
  assert.throws(() => negotiateDaemonProtocol(2, 3), (error) => error instanceof IpcProtocolError && error.code === "unsupported_version");

  const wire = encodeIpcMessage({
    kind: "hello",
    minimumVersion: 1,
    maximumVersion: 1,
    clientInstanceId: "client-1",
  });
  const decoder = new IpcFrameDecoder();
  const cuts = [wire.slice(0, 3), wire.slice(3, 11), wire.slice(11)];
  assert.deepEqual(decoder.push(cuts[0]), []);
  assert.deepEqual(decoder.push(cuts[1]), []);
  const frames = decoder.push(cuts[2]);
  assert.equal(frames.length, 1);
  assert.deepEqual(decodeIpcMessage(frames[0]), {
    kind: "hello",
    minimumVersion: 1,
    maximumVersion: 1,
    clientInstanceId: "client-1",
  });
});

test("IPC unknown-critical, optional-extension, and oversize controls fail as specified", () => {
  const known = encodeIpcFrame({ type: "heartbeat", critical: true, payload: new Uint8Array() });
  const critical = known.slice();
  new DataView(critical.buffer).setUint16(6, 999, false);
  assert.throws(() => decodeIpcFrame(critical), (error) => error instanceof IpcProtocolError && error.code === "unknown_critical_frame");

  const optional = critical.slice();
  optional[5] = 0;
  assert.equal(decodeIpcFrame(optional), undefined);
  assert.throws(
    () => encodeIpcFrame({ type: "event", critical: true, payload: new Uint8Array(MAX_IPC_FRAME_BYTES + 1) }),
    (error) => error instanceof IpcProtocolError && error.code === "oversize_frame",
  );
});

test("platform endpoints are per-user and cross-user peers are rejected before protocol use", () => {
  const windowsA = deriveDaemonEndpoint({ platform: "win32", ownerIdentity: "S-1-5-21-A" });
  const windowsB = deriveDaemonEndpoint({ platform: "win32", ownerIdentity: "S-1-5-21-B" });
  assert.equal(windowsA.transport, "windows_named_pipe");
  assert.notEqual(windowsA.address, windowsB.address);

  const unix = deriveDaemonEndpoint({ platform: "linux", ownerIdentity: "1000", runtimeDirectory: "/run/user/1000" });
  assert.equal(unix.transport, "unix_socket");
  assert.equal(unix.requiredSocketMode, 0o600);
  assert.doesNotThrow(() => assertSameUserPeer("1000", { verified: true, ownerIdentity: "1000", mechanism: "test_fixture" }));
  assert.throws(
    () => assertSameUserPeer("1000", { verified: true, ownerIdentity: "1001", mechanism: "test_fixture" }),
    (error) => error instanceof EndpointSecurityError && error.code === "cross_user_peer",
  );
  assert.throws(
    () => assertSameUserPeer("1000", { verified: false, mechanism: "unix_peer_credentials" }),
    (error) => error instanceof EndpointSecurityError && error.code === "unverified_peer",
  );
});

test("lease races always admit one writer and every replaced generation is fenced", () => {
  for (let seed = 0; seed < 100; seed += 1) {
    let now = seed * 1_000;
    const store = new FencedLeaseStore(() => now);
    const owners = seed % 2 === 0 ? ["writer-a", "writer-b"] : ["writer-b", "writer-a"];
    const winner = store.acquire("binding-1", owners[0], 100);
    assert.throws(() => store.acquire("binding-1", owners[1], 100), (error) => error instanceof LeaseError && error.code === "lease_conflict");
    now += 101;
    const successor = store.acquire("binding-1", owners[1], 100);
    assert.equal(successor.generation, winner.generation + 1);
    assert.throws(() => store.assertWriter(winner), (error) => error instanceof LeaseError && error.code === "stale_fence");
    assert.doesNotThrow(() => store.assertWriter(successor));
  }
});

test("durable intent admission is atomic and post-durability crashes recover for reconciliation", async () => {
  class FaultStorage extends MemoryJournalStorage {
    phase = "none";
    async save(document) {
      if (this.phase === "before") throw new Error("disk-full");
      await super.save(document);
      if (this.phase === "after") throw new Error("crash-after-rename");
    }
  }
  const storage = new FaultStorage();
  const journal = await DurableIntentJournal.open(storage, "journal-1");
  const fence = { resourceId: "binding-1", ownerId: "writer", generation: 1 };

  storage.phase = "before";
  await assert.rejects(journal.recordIntent({ intentId: "intent-1", operation: "sync", payloadDigest: digestA, fence, now: 1 }));
  assert.equal(journal.snapshot().entries.length, 0);

  storage.phase = "after";
  await assert.rejects(journal.recordIntent({ intentId: "intent-1", operation: "sync", payloadDigest: digestA, fence, now: 2 }));
  assert.equal(journal.snapshot().entries.length, 0, "the live instance did not acknowledge a failed durability boundary");

  storage.phase = "none";
  const recovered = await DurableIntentJournal.open(storage);
  assert.equal(recovered.recoveryQueue().length, 1);
  assert.equal(recovered.recoveryQueue()[0].intentId, "intent-1");
  await recovered.markDispatched("intent-1", 3);
  await recovered.markUncertain("intent-1", 4);
  await recovered.recordDisposition("intent-1", "committed", "receipt-1", 5);
  assert.equal(recovered.recoveryQueue().length, 0);
});

test("journal rejects idempotency rebinding and corrupt recovery evidence", async () => {
  const storage = new MemoryJournalStorage();
  const fence = { resourceId: "binding", ownerId: "writer", generation: 4 };
  const journal = await DurableIntentJournal.open(storage, "journal-2");
  await journal.recordIntent({ intentId: "same", operation: "create", payloadDigest: digestA, fence, now: 1 });
  await assert.rejects(
    journal.recordIntent({ intentId: "same", operation: "delete", payloadDigest: digestA, fence, now: 2 }),
    (error) => error instanceof JournalError && error.code === "intent_conflict",
  );
  storage.document = { ...storage.document, checksum: "sha256:bad" };
  await assert.rejects(DurableIntentJournal.open(storage), (error) => error instanceof JournalError && error.code === "journal_corrupt");
});

test("process supervision proves continuity by AgentSession epoch, never by reused PID", () => {
  const supervisor = new ProcessSupervisorModel();
  const first = { agentSessionId: "agent-a", processEpoch: "epoch-1" };
  supervisor.register(first, 1, 42);
  supervisor.transition(first, "ready", 2);
  supervisor.transition(first, "running", 3);
  supervisor.transition(first, "exited", 4, { exitCode: 0 });
  const second = { agentSessionId: "agent-a", processEpoch: "epoch-2" };
  supervisor.register(second, 5, 42);
  assert.throws(() => supervisor.require(first), (error) => error instanceof SupervisorError && error.code === "identity_mismatch");
});

test("randomized local views never route by machine ID or across sibling AgentSessions", () => {
  const registry = new LocalClientViewRegistry();
  for (let index = 0; index < 3; index += 1) {
    registry.open({
      viewId: `view-${index}`,
      binding: {
        userId: "user",
        machineId: "machine-shared",
        agentSessionId: `agent-${index}`,
        processEpoch: `epoch-${index}`,
        fencingGeneration: index + 1,
      },
      state: "active",
      columns: 80,
      rows: 24,
    });
  }
  let state = 0x12345678;
  for (let trial = 0; trial < 300; trial += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const index = state % 3;
    const target = registry.routeInput(`view-${index}`, index + 1);
    assert.equal(target.agentSessionId, `agent-${index}`);
    assert.equal(target.processEpoch, `epoch-${index}`);
  }
  registry.enterNavigation("view-1");
  assert.throws(() => registry.routeInput("view-1", 2), (error) => error instanceof ViewIsolationError && error.code === "navigation_active");
  assert.equal(registry.routeInput("view-0", 1).agentSessionId, "agent-0");
});

test("terminal codec preserves binary bytes and rejects unknown, oversize, and illegal-state frames", () => {
  const payload = Uint8Array.of(0, 0xff, 0xc3, 0x28, 0x1b, 0x5b, 0x32, 0x4a);
  const wire = encodeTerminalFrame({ type: "output", critical: true, sequence: 9n, payload });
  const decoder = new TerminalFrameDecoder();
  assert.deepEqual(decoder.push(wire.slice(0, 7)), []);
  const decoded = decoder.push(wire.slice(7))[0];
  assert.deepEqual(decoded.payload, payload);

  const unknown = wire.slice();
  new DataView(unknown.buffer).setUint16(6, 65000, false);
  assert.throws(() => decodeTerminalFrame(unknown), (error) => error instanceof TerminalProtocolError && error.code === "unknown_critical_frame");
  assert.throws(
    () => encodeTerminalFrame({ type: "output", critical: true, sequence: 1n, payload: new Uint8Array(MAX_TERMINAL_FRAME_BYTES + 1) }),
    (error) => error instanceof TerminalProtocolError && error.code === "oversize_frame",
  );
  assert.throws(
    () => assertTerminalFrameLegal("negotiating", "server_to_client", "output"),
    (error) => error instanceof TerminalProtocolError && error.code === "illegal_state",
  );
});

test("ready and acknowledgement control frames preserve PTY truth and non-execution semantics", () => {
  const readyWire = encodeTerminalControl("ready", 0n, {
    protocol: "runa.terminal.v1",
    agentSessionId: "agent-1",
    processEpoch: "epoch-1",
    fencingGeneration: 3,
    resizeCapability: "initial_resize_only",
  });
  const ready = decodeTerminalFrame(readyWire);
  assert.equal(decodeTerminalControl(ready).processEpoch, "epoch-1");
  const ackWire = encodeTerminalControl("acknowledgement", 4n, {
    clientSequence: "4",
    meaning: "durably_accepted_not_executed",
  });
  const ack = decodeTerminalControl(decodeTerminalFrame(ackWire));
  assert.equal(ack.meaning, "durably_accepted_not_executed");
});

test("takeover fences delayed input, deduplicates replay, and never claims execution", () => {
  let now = 0;
  const session = new ExclusiveAttachmentSession(
    { userId: "user", machineId: "machine", agentSessionId: "agent", processEpoch: "epoch" },
    () => now,
  );
  const oldGrant = session.attach("client-old");
  const first = session.acceptInput(oldGrant, 1n, text.encode("echo a"));
  assert.equal(first.execution, "unknown");
  assert.equal(session.acceptInput(oldGrant, 1n, text.encode("echo a")).duplicate, true);
  assert.throws(() => session.acceptInput(oldGrant, 1n, text.encode("echo b")), (error) => error instanceof AttachmentError && error.code === "sequence_conflict");

  const newGrant = session.takeover("client-new", true);
  assert.equal(newGrant.fencingGeneration, oldGrant.fencingGeneration + 1);
  assert.throws(() => session.acceptInput(oldGrant, 2n, text.encode("late")), (error) => error instanceof AttachmentError && error.code === "stale_fence");
  assert.equal(session.acceptInput(newGrant, 2n, text.encode("safe")).duplicate, false);

  session.appendOutput(new Uint8Array(600_000).fill(1), now);
  session.appendOutput(new Uint8Array(600_000).fill(2), now);
  session.detach(newGrant);
  now += 1;
  const resumed = session.resume({ ownerClientId: "client-resume", processEpoch: "epoch", processAlive: true, afterOutputSequence: 0n });
  assert.equal(resumed.classification, "resumed");
  assert.equal(resumed.outputContinuous, false);
  assert.equal(resumed.earliestSequence, 2n);
  assert.equal(resumed.frames.length, 1);
});

test("resume rejects silent takeover and classifies process replacement as discontinuous", () => {
  const session = new ExclusiveAttachmentSession({ userId: "u", machineId: "m", agentSessionId: "a", processEpoch: "epoch-1" });
  session.attach("owner-a");
  assert.throws(
    () => session.resume({ ownerClientId: "owner-b", processEpoch: "epoch-1", processAlive: true, afterOutputSequence: 0n }),
    (error) => error instanceof AttachmentError && error.code === "attachment_conflict",
  );
  const discontinuous = session.resume({
    ownerClientId: "owner-b",
    processEpoch: "epoch-2",
    processAlive: true,
    afterOutputSequence: 0n,
    ownerAuthorizedTakeover: true,
  });
  assert.equal(discontinuous.classification, "discontinuous");
  assert.equal(discontinuous.attachmentRestored, false);
});

test("viewport state remains tab-scoped and host control bytes cannot enter rendered cells", () => {
  const registry = new ViewportRegistry();
  const a = { userId: "u", machineId: "m", agentSessionId: "a", processEpoch: "ea", fencingGeneration: 1 };
  const b = { userId: "u", machineId: "m", agentSessionId: "b", processEpoch: "eb", fencingGeneration: 1 };
  registry.open("tab-a", a, 80, 24);
  registry.open("tab-b", b, 80, 24);
  registry.applyRenderedFrame({
    tabId: "tab-a",
    binding: a,
    outputSequence: 1n,
    replayCursor: 1n,
    cells: ["agent A"],
    modes: { bracketedPaste: true, mouse: false, alternateScreen: true, cursorVisible: true },
  });
  assert.equal(registry.require("tab-b").cells[0], "");
  assert.throws(
    () => registry.applyRenderedFrame({
      tabId: "tab-a",
      binding: b,
      outputSequence: 2n,
      replayCursor: 2n,
      cells: ["leak"],
      modes: { bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true },
    }),
    (error) => error instanceof ViewportIsolationError && error.code === "binding_mismatch",
  );
  assert.throws(
    () => registry.applyRenderedFrame({
      tabId: "tab-a",
      binding: a,
      outputSequence: 2n,
      replayCursor: 2n,
      cells: ["\u001b[2Jhost escape"],
      modes: { bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true },
    }),
    (error) => error instanceof ViewportIsolationError && error.code === "viewport_limit",
  );
});

test("appbar projections expire and contradict instead of fabricating zero or success", () => {
  const stale = projectTruth([{ value: "running", source: "server", observedAt: 0, expiresAt: 10, correlationId: "c1" }], 11);
  assert.deepEqual(stale, { status: "stale", reason: "evidence_expired" });
  const contradictory = projectTruth([
    { value: "ready", source: "a", observedAt: 10, expiresAt: 20, correlationId: "a" },
    { value: "failed", source: "b", observedAt: 10, expiresAt: 20, correlationId: "b" },
  ], 11);
  assert.equal(contradictory.status, "contradictory");
  const model = buildAppbarModel({
    now: 100,
    machineLifecycle: [],
    agentSessionLifecycle: [],
    attachment: [],
    providerAuthentication: [],
    workspaceSync: [],
  });
  assert.equal(model.machineLifecycle.status, "unknown");
  assert.equal("cost" in model, false);
  assert.equal("tokensSaved" in model, false);
});

test("rich mode is evidence-gated and host acquisition restores partial state on faults", async () => {
  const rich = selectTerminalMode({
    interactive: true,
    jsonRequested: false,
    columns: 80,
    rows: 24,
    color: true,
    reducedMotion: false,
    rawMode: true,
    alternateScreen: true,
    vteConformance: "verified",
  });
  assert.equal(rich.mode, "rich");
  const plain = selectTerminalMode({
    interactive: true,
    jsonRequested: false,
    columns: 39,
    rows: 24,
    color: false,
    reducedMotion: true,
    rawMode: true,
    alternateScreen: true,
    vteConformance: "unavailable",
  });
  assert.equal(plain.mode, "plain");
  assert.equal(plain.appbar, false);

  const calls = [];
  const adapter = {
    enterRawMode() { calls.push("raw-on"); },
    enterAlternateScreen() { calls.push("alt-on"); throw new Error("fault"); },
    disableRemoteModes() { calls.push("modes-off"); },
    leaveAlternateScreen() { calls.push("alt-off"); },
    leaveRawMode() { calls.push("raw-off"); },
  };
  await assert.rejects(HostTerminalLease.acquire(adapter));
  assert.deepEqual(calls, ["raw-on", "alt-on", "modes-off", "raw-off"]);
});

test("daemon lifecycle rejects impossible shortcuts to readiness", () => {
  const lifecycle = new DaemonLifecycle(0);
  assert.throws(() => lifecycle.transition("ready", "endpoint_open", 1));
  lifecycle.transition("starting", "client_requested", 1);
  lifecycle.transition("ready", "endpoint_and_state_verified", 2);
  lifecycle.transition("degraded", "authority_unavailable", 3);
  lifecycle.transition("reconciling", "authority_restored", 4);
  assert.equal(lifecycle.transition("ready", "leases_reconciled", 5).state, "ready");
});
