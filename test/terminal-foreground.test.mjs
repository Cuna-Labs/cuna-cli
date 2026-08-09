import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createNodeForegroundTerminalHost, ForegroundTerminalCoordinator, MAX_FOREGROUND_PENDING_INPUT_BYTES } from "../dist/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeHost {
  columns = 80;
  rows = 24;
  input;
  resize;
  writes = [];
  acquired = 0;
  restored = 0;
  removedInput = 0;
  removedResize = 0;
  failWrite = false;
  failRestore = false;
  writeGate;
  acquireGate;

  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() {
    this.acquired += 1;
    if (this.acquireGate !== undefined) await this.acquireGate;
    return { restore: async () => { this.restored += 1; if (this.failRestore) throw new Error("host restore failed"); } };
  }
  async write(bytes) {
    if (this.failWrite) throw new Error("host output failed");
    this.writes.push(bytes.slice());
    if (this.writeGate !== undefined) await this.writeGate;
  }
  onInput(listener) {
    this.input = listener;
    return () => { this.removedInput += 1; this.input = undefined; };
  }
  onResize(listener) {
    this.resize = listener;
    return () => { this.removedResize += 1; this.resize = undefined; };
  }
  emitInput(bytes) { this.input?.(bytes); }
  emitResize() { this.resize?.(); }
}

function snapshot(intent, generation = 1) {
  return {
    tabId: intent.tabId,
    viewId: `${intent.tabId}:attachment:${generation}`,
    userId: "user-1",
    machineId: "machine-1",
    agentSessionId: intent.agentSessionId,
    processEpoch: `epoch-${intent.agentSessionId}`,
    state: "active",
    fencingGeneration: generation,
    inputSequence: 0n,
    outputSequence: 0n,
    outputContinuity: "complete",
    resizeCapability: "live",
    heartbeatObservedAt: 100,
    heartbeatExpiresAt: 200,
  };
}

function outputEvent(intent, sequence, bytes, generation = 1, signal = new AbortController().signal) {
  const state = snapshot(intent, generation);
  return {
    tabId: intent.tabId,
    agentSessionId: intent.agentSessionId,
    binding: {
      userId: state.userId,
      machineId: state.machineId,
      agentSessionId: state.agentSessionId,
      processEpoch: state.processEpoch,
      fencingGeneration: state.fencingGeneration,
    },
    sequence,
    bytes,
    signal,
  };
}

function harness(options = {}) {
  const host = options.host ?? new FakeHost();
  const coordinator = new ForegroundTerminalCoordinator({
    host,
    resizeCoalesceMs: 5,
    ...options.coordinatorOptions,
  });
  const callbacks = coordinator.runtimeCallbacks();
  const calls = { attach: [], detach: [], reconnect: [], input: [], resize: [], switch: [], responses: [] };
  const intents = [
    { tabId: "tab-a", agentSessionId: "agent-a", label: "primary", agent: "claude-code" },
    { tabId: "tab-b", agentSessionId: "agent-b", label: "review", agent: "codex" },
  ];
  const runtime = {
    activeTabId: undefined,
    async attach(input) {
      calls.attach.push(input);
      const intent = intents.find((item) => item.tabId === input.tabId);
      const ready = snapshot(intent);
      await callbacks.onTerminalReady(ready);
      runtime.activeTabId ??= input.tabId;
      return ready;
    },
    async detach(tabId) { calls.detach.push(tabId); },
    async reconnect(input) {
      calls.reconnect.push(input.tabId);
      const intent = intents.find((item) => item.tabId === input.tabId);
      const ready = snapshot(intent, 2);
      await callbacks.onTerminalReady(ready);
      callbacks.onTerminalState(ready);
      return ready;
    },
    async sendInput(bytes, tabId) { calls.input.push({ tabId, text: decoder.decode(bytes) }); },
    async resize(columns, rows, tabId) { calls.resize.push({ columns, rows, tabId }); },
    switchActive(tabId) { runtime.activeTabId = tabId; calls.switch.push(tabId); return snapshot(intents.find((item) => item.tabId === tabId)); },
    async sendTerminalResponse(response) { calls.responses.push(response); },
  };
  coordinator.bindRuntime(runtime);
  return { coordinator, callbacks, calls, host, intents, runtime };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

test("foreground coordinator owns host restoration and renders isolated cloud tabs under the Runa appbar", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents);
  assert.equal(coordinator.state, "active");
  assert.equal(host.acquired, 1);
  assert.equal(calls.attach.length, 2);
  assert.equal(calls.attach[0].rows, 22);
  assert.match(decoder.decode(host.writes.at(-1)), /48;2;235;86;37m/);

  await callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("cloud output")));
  assert.match(decoder.decode(host.writes.at(-1)), /cloud output/);

  await coordinator.stop();
  assert.equal(coordinator.state, "stopped");
  assert.deepEqual(calls.detach, ["tab-a", "tab-b"]);
  assert.equal(host.restored, 1);
  assert.equal(host.removedInput, 1);
  assert.equal(host.removedResize, 1);
});

test("host output backpressure is awaited before terminal output is acknowledged", async () => {
  const { coordinator, callbacks, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  let release;
  host.writeGate = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const output = callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("slow frame")))
    .then(() => { settled = true; });
  await waitUntil(() => host.writes.length >= 2, "render should reach the host sink");
  assert.equal(settled, false);
  release();
  await output;
  assert.equal(settled, true);
  await coordinator.stop();
});

test("replacement readiness waits for prior-generation host rendering and fences stale output", async () => {
  const { coordinator, callbacks, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  let release;
  host.writeGate = new Promise((resolve) => { release = resolve; });
  const oldOutput = callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("old generation")));
  await waitUntil(() => host.writes.length >= 2, "old generation should reach host backpressure");
  let readySettled = false;
  const replacement = callbacks.onTerminalReady(snapshot(intents[0], 2)).then(() => { readySettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readySettled, false, "new readiness cannot overtake an older host render");
  release();
  await oldOutput;
  await replacement;
  await assert.rejects(
    callbacks.onTerminalOutput(outputEvent(intents[0], 2n, encoder.encode("stale"), 1)),
    /unbound foreground viewport/u,
  );
  await coordinator.stop();
});

test("TC-055-07/08 escape help and tab chords stay local while Ctrl-C/Z and payload remain remote input", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents);
  host.emitInput(Uint8Array.of(0x03, 0x1a, 0x41));
  await waitUntil(() => calls.input.length === 1, "ordinary raw input should reach the initial tab");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: "\u0003\u001aA" });

  host.emitInput(Uint8Array.of(0x1d, 0x3f));
  await waitUntil(() => decoder.decode(host.writes.at(-1)).includes("Keys: Ctrl+] ? help"), "trusted appbar should show local escape help");

  host.emitInput(Uint8Array.of(0x1d));
  host.emitInput(Uint8Array.of(0x32, 0x42));
  await waitUntil(() => calls.input.length === 2, "payload after a tab chord should reach the selected tab");
  assert.deepEqual(calls.switch, ["tab-b"]);
  assert.deepEqual(calls.input[1], { tabId: "tab-b", text: "B" });

  host.emitInput(Uint8Array.of(0x1d, 0x1d));
  await waitUntil(() => calls.input.length === 3, "double prefix should send one literal prefix");
  assert.equal(calls.input[2].tabId, "tab-b");
  assert.equal(calls.input[2].text.charCodeAt(0), 0x1d);
  await coordinator.stop();
});

test("escape-chord bytes inside split bracketed paste remain literal remote content", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents);
  host.emitInput(Uint8Array.of(0x1b, 0x5b, 0x32));
  host.emitInput(Uint8Array.of(0x30, 0x30, 0x7e, 0x1d, 0x32, 0x41));
  host.emitInput(Uint8Array.of(0x1b, 0x5b, 0x32, 0x30));
  host.emitInput(Uint8Array.of(0x31, 0x7e));
  await waitUntil(() => calls.input.reduce((total, item) => total + item.text.length, 0) >= 15, "paste bytes should reach the remote tab");
  assert.deepEqual(calls.switch, []);
  assert.equal(calls.input.every((item) => item.tabId === "tab-a"), true);
  const raw = calls.input.map((item) => item.text).join("");
  assert.equal(raw.includes("\u001d2A"), true);
  await coordinator.stop();
});

test("resize storms coalesce to the latest active-tab dimensions without inventing output", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  for (let index = 0; index < 100; index += 1) {
    host.columns = 90 + index;
    host.rows = 30 + index;
    host.emitResize();
  }
  await waitUntil(() => calls.resize.length === 1, "resize storm should coalesce to one remote mutation");
  assert.deepEqual(calls.resize[0], { columns: 189, rows: 127, tabId: "tab-a" });
  await coordinator.stop();
});

test("startup render failure detaches partial tabs and restores the host lease", async () => {
  const host = new FakeHost();
  host.failWrite = true;
  const { coordinator, calls, intents } = harness({ host });
  await assert.rejects(coordinator.start(intents.slice(0, 1)), /host output failed/u);
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(host.restored, 1);
  assert.equal(host.input, undefined);
  assert.equal(host.resize, undefined);
});

test("active cancellation detaches tabs and restores the host terminal lease", async () => {
  const controller = new AbortController();
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1), controller.signal);
  controller.abort();
  await waitUntil(() => coordinator.state === "stopped", "abort should stop foreground ownership");
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(host.restored, 1);
  assert.equal(host.input, undefined);
  assert.equal(host.resize, undefined);
});

test("cancellation while host acquisition is pending restores the late lease and installs no listeners", async () => {
  const host = new FakeHost();
  let releaseAcquire;
  host.acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
  const controller = new AbortController();
  const { coordinator, intents } = harness({ host });
  const starting = coordinator.start(intents.slice(0, 1), controller.signal);
  await waitUntil(() => host.acquired === 1, "host acquisition should be pending");
  controller.abort();
  await waitUntil(() => coordinator.state === "stopped", "abort should revoke ownership while acquire is pending");
  releaseAcquire();
  await assert.rejects(starting, /cancelled/u);
  assert.equal(host.restored, 1);
  assert.equal(host.input, undefined);
  assert.equal(host.resize, undefined);
});

test("an interrupted foreground tab reconnects with a bounded composed retry", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "interrupted", reason: "heartbeat_expired" });
  await waitUntil(() => calls.reconnect.length === 1, "foreground recovery should invoke runtime reconnect");
  assert.equal(coordinator.state, "active");
  assert.equal(host.restored, 0);
  assert.deepEqual(calls.reconnect, ["tab-a"]);
  await coordinator.stop();
});

test("reconnect exhaustion isolates the failed tab without tearing down healthy foreground ownership", async () => {
  const { coordinator, callbacks, calls, host, intents, runtime } = harness({
    coordinatorOptions: { reconnectAttempts: 2, reconnectBaseDelayMs: 1 },
  });
  await coordinator.start(intents);
  runtime.reconnect = async (input) => {
    calls.reconnect.push(input.tabId);
    throw new Error("replacement unavailable");
  };
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "interrupted", reason: "transport_closed" });
  await waitUntil(() => calls.reconnect.length === 2, "recovery should exhaust its bounded attempts");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coordinator.state, "active");
  assert.equal(host.restored, 0);
  assert.deepEqual(calls.detach, []);
  await coordinator.stop();
});

test("a replacement ready callback cannot resurrect a viewport after stop", async () => {
  const { coordinator, callbacks, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  let releaseWrite;
  host.writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const oldOutput = callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("old")));
  await waitUntil(() => host.writes.length >= 2, "old output should hold the render tail");
  const replacement = callbacks.onTerminalReady(snapshot(intents[0], 2));
  const stopping = coordinator.stop();
  releaseWrite();
  await oldOutput;
  await assert.rejects(replacement, /ownership ended/u);
  await stopping;
  assert.equal(coordinator.state, "stopped");
  await assert.rejects(
    callbacks.onTerminalOutput(outputEvent(intents[0], 2n, encoder.encode("late"), 2)),
    /unbound foreground viewport/u,
  );
});

test("resize reflows every tab before switching to an inactive viewport", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents);
  await callbacks.onTerminalOutput(outputEvent(intents[1], 1n, encoder.encode("x".repeat(70))));
  host.columns = 40;
  host.rows = 12;
  host.emitResize();
  await waitUntil(() => calls.resize.length === 2, "both cloud PTYs should receive the resized dimensions");
  host.emitInput(Uint8Array.of(0x1d, 0x32));
  await waitUntil(() => calls.switch.length === 1, "inactive tab should become selected");
  assert.equal(coordinator.state, "active");
  assert.deepEqual(calls.resize, [
    { columns: 40, rows: 10, tabId: "tab-a" },
    { columns: 40, rows: 10, tabId: "tab-b" },
  ]);
  await coordinator.stop();
});

test("input backlog is bounded and restoration waits for admitted input to settle", async () => {
  const { coordinator, host, intents, runtime } = harness();
  await coordinator.start(intents.slice(0, 1));
  let release;
  let entered = false;
  runtime.sendInput = async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
  };
  host.emitInput(Uint8Array.of(0x41));
  await waitUntil(() => entered, "first input should enter the cloud send boundary");
  host.emitInput(new Uint8Array(MAX_FOREGROUND_PENDING_INPUT_BYTES));
  await waitUntil(() => coordinator.state === "stopping", "overflow should deterministically stop the foreground lease");
  assert.equal(host.restored, 0, "host restoration must not outrun admitted input cleanup");
  release();
  await waitUntil(() => coordinator.state === "stopped", "cleanup should finish after the admitted input settles");
  assert.equal(host.restored, 1);
});

test("startup preserves both the render failure and host restoration failure", async () => {
  const host = new FakeHost();
  host.failWrite = true;
  host.failRestore = true;
  const { coordinator, intents } = harness({ host });
  await assert.rejects(
    coordinator.start(intents.slice(0, 1)),
    (error) => error instanceof AggregateError &&
      error.errors.some((item) => item?.message === "host output failed") &&
      error.errors.some((item) => item instanceof AggregateError && item.errors.some((nested) => nested?.message === "host restore failed")),
  );
  assert.equal(coordinator.state, "failed");
});

test("Node foreground host waits for both write completion and drain before releasing backpressure", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    readableFlowing = false;
    raw = false;
    setRawMode(value) { this.raw = value; }
    resume() { this.readableFlowing = true; return this; }
    pause() { this.readableFlowing = false; return this; }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    columns = 80;
    rows = 24;
    pendingCallback;
    blockNext = false;
    throwNext = false;
    writes = [];
    write(value, callback) {
      if (this.throwNext) {
        this.throwNext = false;
        throw new Error("synchronous stdout failure");
      }
      this.writes.push(Buffer.from(value));
      if (!this.blockNext) {
        callback?.(null);
        return true;
      }
      this.blockNext = false;
      this.pendingCallback = callback;
      return false;
    }
  }
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const host = createNodeForegroundTerminalHost({ stdin, stdout, writeTimeoutMs: 100 });
  const lease = await host.acquire();
  assert.equal(Buffer.concat(stdout.writes).toString().includes("\u001b[?2004h"), true, "foreground acquisition enables local bracketed paste");
  stdout.blockNext = true;
  let settled = false;
  const writing = host.write(encoder.encode("frame")).then(() => { settled = true; });
  stdout.pendingCallback(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "write callback alone does not prove that backpressure drained");
  stdout.emit("drain");
  await writing;
  assert.equal(settled, true);
  stdout.throwNext = true;
  await assert.rejects(host.write(encoder.encode("broken")), /synchronous stdout failure/u);
  await lease.restore();
  assert.equal(Buffer.concat(stdout.writes).toString().includes("\u001b[?2004l"), true, "foreground restoration disables local bracketed paste");
  assert.equal(stdin.raw, false);
});
