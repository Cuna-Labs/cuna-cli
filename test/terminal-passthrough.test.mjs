import assert from "node:assert/strict";
import test from "node:test";

import { PassthroughTerminalCoordinator } from "../dist/index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();

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

function snapshot(state = "active") {
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

function harness() {
  const host = new FakeHost();
  const coordinator = new PassthroughTerminalCoordinator({ host, resizeCoalesceMs: 1 });
  const callbacks = coordinator.runtimeCallbacks();
  const calls = { attach: [], detach: [], input: [], inputAuthorities: [], resize: [] };
  const runtime = {
    activeTabId: "plain:1",
    async attach(input) {
      calls.attach.push(input);
      const ready = snapshot();
      await callbacks.onTerminalReady(ready);
      return ready;
    },
    async detach(tabId) {
      calls.detach.push(tabId);
      callbacks.onTerminalState(snapshot("detached"));
    },
    async reconnect() { throw new Error("passthrough does not claim reconnect"); },
    async sendInput(bytes, tabId, authority) {
      calls.inputAuthorities.push(authority);
      calls.input.push({ tabId, bytes: bytes.slice() });
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

test("passthrough forwards Ctrl+C, Ctrl+V and bracketed paste while reserving only the documented detach chord", async () => {
  const { coordinator, calls, host, intent } = harness();
  await coordinator.start([intent]);
  host.emitInput(Uint8Array.of(0x03, 0x16, 0x41));
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

  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["plain:1"]);
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

test("passthrough coalesces live resize and never invents support for initial-only terminals", async () => {
  const { coordinator, calls, host, intent } = harness();
  await coordinator.start([intent]);
  host.columns = 50;
  host.rows = 12;
  host.emitResize();
  host.columns = 60;
  host.rows = 14;
  host.emitResize();
  await waitUntil(() => calls.resize.length === 1, "resize should coalesce");
  assert.deepEqual(calls.resize, [{ columns: 60, rows: 14, tabId: "plain:1" }]);
  await coordinator.stop();
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
