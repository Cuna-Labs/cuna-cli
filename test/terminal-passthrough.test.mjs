import assert from "node:assert/strict";
import test from "node:test";

import { PassthroughTerminalCoordinator } from "../dist/index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();

async function waitForGateOrAbort(gate, signal) {
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

class FakeHost {
  columns = 32;
  rows = 8;
  input;
  resize;
  writes = [];
  modes = [];
  restored = 0;
  failRestore = false;
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire(mode) {
    this.modes.push(mode);
    return { restore: async () => { this.restored += 1; if (this.failRestore) throw new Error("host restore failed"); } };
  }
  async write(bytes) { this.writes.push(bytes.slice()); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize(listener) { this.resize = listener; return () => { this.resize = undefined; }; }
  emitInput(bytes) { this.input?.(bytes); }
  emitResize() { this.resize?.(); }
}

function snapshot(state = "active", overrides = {}) {
  return {
    tabId: "plain:1",
    viewId: "plain:1:attachment:1",
    userId: "user-1",
    machineId: "machine-1",
    agentSessionId: SESSION,
    processEpoch: "epoch-1",
    state,
    fencingGeneration: 1,
    inputSequence: 0n,
    outputSequence: 0n,
    outputContinuity: "complete",
    resizeCapability: "live",
    heartbeatObservedAt: 100,
    heartbeatExpiresAt: 200,
    ...overrides,
  };
}

function event(bytes, overrides = {}) {
  const current = snapshot();
  return {
    tabId: current.tabId,
    agentSessionId: current.agentSessionId,
    binding: {
      userId: current.userId,
      machineId: current.machineId,
      agentSessionId: current.agentSessionId,
      processEpoch: current.processEpoch,
      fencingGeneration: current.fencingGeneration,
    },
    sequence: 1n,
    bytes,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function harness({ deferredAttach = false, deferredInput = false, resizeCapability = "live", detachStateSequence = ["detached"] } = {}) {
  const host = new FakeHost();
  const coordinator = new PassthroughTerminalCoordinator({ host, resizeCoalesceMs: 1 });
  const callbacks = coordinator.runtimeCallbacks();
  const calls = { attach: [], detach: [], input: [], inputAuthorities: [], resize: [] };
  let releaseAttach;
  const attachGate = deferredAttach
    ? new Promise((resolve) => { releaseAttach = resolve; })
    : Promise.resolve();
  let releaseInput;
  const inputGate = deferredInput
    ? new Promise((resolve) => { releaseInput = resolve; })
    : Promise.resolve();
  const runtime = {
    activeTabId: "plain:1",
    async attach(input) {
      calls.attach.push(input);
      await waitForGateOrAbort(attachGate, input.signal);
      const ready = snapshot("active", { resizeCapability });
      await callbacks.onTerminalReady(ready);
      return ready;
    },
    async detach(tabId) {
      calls.detach.push(tabId);
      for (const state of detachStateSequence) {
        callbacks.onTerminalState(snapshot(state));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async reconnect() { throw new Error("passthrough does not claim reconnect"); },
    async sendInput(bytes, tabId, authority) {
      calls.inputAuthorities.push(authority);
      calls.input.push({ tabId, bytes: bytes.slice() });
      await inputGate;
    },
    async resize(columns, rows, tabId) { calls.resize.push({ columns, rows, tabId }); },
    switchActive() { return snapshot(); },
    async sendTerminalResponse() {},
  };
  coordinator.bindRuntime(runtime);
  return {
    coordinator,
    callbacks,
    calls,
    host,
    releaseAttach: () => releaseAttach?.(),
    releaseInput: () => releaseInput?.(),
    intent: { tabId: "plain:1", agentSessionId: SESSION, label: "plain", agent: "claude-code" },
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

test("passthrough emits no appbar or progress and preserves remote output bytes exactly", async () => {
  const { coordinator, callbacks, host, intent } = harness();
  await coordinator.start([intent]);
  assert.deepEqual(host.modes, ["plain"]);
  assert.deepEqual(host.writes, []);

  const bytes = Uint8Array.of(0x00, 0x1b, 0x5b, 0x32, 0x4a, 0xff, 0x0a);
  await callbacks.onTerminalOutput(event(bytes));
  assert.deepEqual([...host.writes[0]], [...bytes]);
  assert.equal(new TextDecoder().decode(host.writes[0]).includes("RUNA"), false);
  await coordinator.stop();
  assert.equal(host.restored, 1);
});

test("passthrough holds input typed during initial attach for the first exact fenced binding", async () => {
  const { coordinator, calls, host, intent, releaseAttach } = harness({ deferredAttach: true });
  const starting = coordinator.start([intent]);
  await waitUntil(() => calls.attach.length === 1 && host.input !== undefined, "passthrough should own input while terminal attach is pending");

  host.emitInput(Uint8Array.of(0x0d));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.input, []);
  assert.equal(host.restored, 0);

  releaseAttach();
  await starting;
  await waitUntil(() => calls.input.length === 1, "early input should drain after exact readiness");
  assert.deepEqual([...calls.input[0].bytes], [0x0d]);
  assert.equal(calls.inputAuthorities[0]?.agentSessionId, SESSION);
  assert.equal(calls.inputAuthorities[0]?.fencingGeneration, 1);
  await coordinator.stop();
});

test("passthrough Ctrl+C cancels a pending initial attach and restores immediately", async () => {
  const { coordinator, calls, host, intent } = harness({ deferredAttach: true });
  const starting = coordinator.start([intent]);
  await waitUntil(() => calls.attach.length === 1 && host.input !== undefined, "passthrough should own input while attach is pending");
  host.emitInput(Uint8Array.of(0x03));
  await starting;
  await coordinator.waitForStop();
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 1);
  assert.equal(host.input, undefined);
  assert.deepEqual(calls.detach, []);
  assert.deepEqual(calls.input, []);
});

test("passthrough detaches on Ctrl+C and reserves Ctrl+] c for a remote interrupt", async () => {
  const { coordinator, calls, host, intent } = harness({ detachStateSequence: ["interrupted", "detached"] });
  await coordinator.start([intent]);
  host.emitInput(Uint8Array.of(0x1d, 0x63, 0x16, 0x41));
  const pasted = Uint8Array.of(
    0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e,
    0x1d, 0x64, 0x42,
    0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e,
  );
  host.emitInput(pasted.slice(0, 4));
  host.emitInput(pasted.slice(4));
  await waitUntil(() => calls.input.reduce((total, item) => total + item.bytes.byteLength, 0) === 18, "all signal and paste bytes should reach the remote PTY");
  const forwarded = Uint8Array.from(calls.input.flatMap((item) => [...item.bytes]));
  assert.deepEqual([...forwarded], [0x03, 0x16, 0x41, ...pasted]);
  assert.deepEqual(calls.detach, []);

  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["plain:1"]);
  assert.equal(host.restored, 1);
  assert.equal(coordinator.failure, undefined);
});

test("passthrough maps accidental Ctrl+S to XON while explicit chords preserve Ctrl+S and Ctrl+Q", async () => {
  const { coordinator, calls, host, intent } = harness();
  await coordinator.start([intent]);
  host.emitInput(Uint8Array.of(0x13, 0x1d, 0x73, 0x1d, 0x71));
  await waitUntil(() => calls.input.length >= 3, "flow-control input should reach the remote PTY");
  const forwarded = Uint8Array.from(calls.input.flatMap((item) => [...item.bytes]));
  assert.deepEqual([...forwarded], [0x11, 0x13, 0x11]);
  await coordinator.stop();
});

test("a received Ctrl+C wins a concurrent remote close while queued input drains", async () => {
  const { coordinator, callbacks, calls, host, intent, releaseInput } = harness({ deferredInput: true });
  await coordinator.start([intent]);
  host.emitInput(Uint8Array.of(0x41));
  await waitUntil(() => calls.input.length === 1, "the earlier input should hold the serialized input tail");

  host.emitInput(Uint8Array.of(0x03));
  callbacks.onTerminalState(snapshot("interrupted", { reason: "transport_closed_without_terminal_exit" }));
  releaseInput();

  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["plain:1"]);
  assert.equal(coordinator.failure, undefined);
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 1);
});

test("a spontaneous passthrough remote close without local detach remains an error", async () => {
  const { coordinator, callbacks, host, intent } = harness();
  await coordinator.start([intent]);
  callbacks.onTerminalState(snapshot("interrupted", { reason: "transport_closed_without_terminal_exit" }));
  await coordinator.waitForStop();
  assert.match(coordinator.failure?.message ?? "", /connection ended/u);
  assert.equal(host.restored, 1);
});

test("passthrough stops interpreting Ctrl+] d after remote output invalidates local bracketed-paste trust", async () => {
  const { coordinator, callbacks, calls, host, intent } = harness();
  await coordinator.start([intent]);
  await callbacks.onTerminalOutput(event(encoder.encode("\u001b[?20")));
  await callbacks.onTerminalOutput(event(encoder.encode("04lremote app disabled framing")));
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await waitUntil(() => calls.input.length === 1, "an untrusted chord must remain remote PTY input");
  assert.deepEqual(calls.detach, []);
  assert.deepEqual([...calls.input[0].bytes], [0x1d, 0x64]);
  assert.equal(calls.inputAuthorities[0]?.fencingGeneration, 1);
  await coordinator.stop();
});

test("passthrough forces one live repaint after replay, coalesces later resize, and never invents initial-only support", async () => {
  const { coordinator, calls, host, intent } = harness();
  await coordinator.start([intent]);
  assert.deepEqual(calls.resize, [
    { columns: 31, rows: 8, tabId: "plain:1" },
    { columns: 32, rows: 8, tabId: "plain:1" },
  ]);
  host.columns = 50;
  host.rows = 12;
  host.emitResize();
  host.columns = 60;
  host.rows = 14;
  host.emitResize();
  await waitUntil(() => calls.resize.length === 3, "resize should coalesce");
  assert.deepEqual(calls.resize.at(-1), { columns: 60, rows: 14, tabId: "plain:1" });
  await coordinator.stop();

  const initialOnly = harness({ resizeCapability: "initial_resize_only" });
  await initialOnly.coordinator.start([initialOnly.intent]);
  initialOnly.host.columns = 70;
  initialOnly.host.rows = 20;
  initialOnly.host.emitResize();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(initialOnly.calls.resize, []);
  await initialOnly.coordinator.stop();
});

test("passthrough rejects multiplexing and wrong-generation output before effects", async () => {
  const { coordinator, host, intent, calls } = harness();
  await assert.rejects(coordinator.start([intent, { ...intent, tabId: "plain:2" }]), /exactly one/u);
  assert.deepEqual(host.modes, []);
  assert.deepEqual(calls.attach, []);

  const second = harness();
  await second.coordinator.start([second.intent]);
  await assert.rejects(
    second.callbacks.onTerminalOutput(event(encoder.encode("spoof"), {
      binding: { ...event(new Uint8Array()).binding, processEpoch: "wrong-epoch" },
    })),
    /unbound terminal generation/u,
  );
  assert.deepEqual(second.host.writes, []);
  await second.coordinator.stop();
});

test("passthrough cancellation restores the host and produces no decorative output", async () => {
  const controller = new AbortController();
  const { coordinator, host, intent } = harness();
  await coordinator.start([intent], controller.signal);
  controller.abort();
  await coordinator.waitForStop();
  assert.equal(host.restored, 1);
  assert.deepEqual(host.writes, []);
  assert.match(coordinator.failure?.message ?? "", /cancelled/u);
});

test("passthrough retains a failed host lease for explicit restoration retry", async () => {
  const { coordinator, host, intent } = harness();
  await coordinator.start([intent]);
  host.failRestore = true;
  const waiter = assert.rejects(coordinator.waitForStop(), /cleanup was incomplete/u);
  await assert.rejects(coordinator.stop(), /cleanup was incomplete/u);
  await waiter;
  assert.equal(coordinator.state, "failed");
  assert.equal(host.restored, 1);

  host.failRestore = false;
  await coordinator.stop();
  await coordinator.waitForStop();
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 2);
});
