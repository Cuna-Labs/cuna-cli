import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { digestLocalActionArguments, ForegroundTerminalCoordinator, MAX_FOREGROUND_PENDING_INPUT_BYTES } from "../dist/index.js";
import { createNodeForegroundTerminalHost } from "../dist/pty/node-host-terminal.js";
import { runtimeFailure } from "../dist/runtime/errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

async function waitForGateOrAbort(gate, signal) {
  if (gate === undefined) return;
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
  columns = 80;
  rows = 24;
  input;
  resize;
  writes = [];
  acquired = 0;
  restored = 0;
  writesAtRestore;
  removedInput = 0;
  removedResize = 0;
  failWrite = false;
  failWriteAt;
  writeAttempts = 0;
  failRestore = false;
  writeGate;
  acquireGate;
  onAcquire;

  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() {
    this.acquired += 1;
    if (this.acquireGate !== undefined) await this.acquireGate;
    this.onAcquire?.();
    return { restore: async () => {
      this.writesAtRestore = this.writes.length;
      this.restored += 1;
      if (this.failRestore) throw new Error("host restore failed");
    } };
  }
  async write(bytes) {
    this.writeAttempts += 1;
    if (this.failWrite || this.writeAttempts === this.failWriteAt) throw new Error("host output failed");
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
    workspaceBindingId: null,
    workspaceBindingGeneration: null,
    agentSessionId: intent.agentSessionId,
    processEpoch: `epoch-${intent.agentSessionId}`,
    state: "active",
    fencingGeneration: generation,
    inputSequence: 0n,
    outputSequence: 0n,
    outputContinuity: "complete",
    resizeCapability: "live",
    accessMode: "writer",
    writerEpoch: 1,
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
  const calls = { attach: [], detach: [], reconnect: [], takeWriter: [], input: [], inputAuthorities: [], repaint: [], resize: [], switch: [], responses: [], localActionControls: [] };
  const intents = [
    { tabId: "tab-a", agentSessionId: SESSION_A, label: "primary", agent: "claude-code" },
    { tabId: "tab-b", agentSessionId: SESSION_B, label: "review", agent: "codex" },
  ];
  const runtime = {
    activeTabId: undefined,
    async attach(input) {
      calls.attach.push(input);
      await waitForGateOrAbort(options.attachGate, input.signal);
      const intent = intents.find((item) => item.tabId === input.tabId);
      const ready = snapshot(intent);
      await callbacks.onTerminalReady(ready);
      runtime.activeTabId ??= input.tabId;
      return ready;
    },
    async detach(tabId) {
      calls.detach.push(tabId);
      if (options.detachGate !== undefined) await options.detachGate;
      if (options.detachError !== undefined) throw options.detachError;
      const intent = intents.find((item) => item.tabId === tabId);
      for (const state of options.detachStateSequence ?? []) {
        callbacks.onTerminalState({ ...snapshot(intent), state });
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async takeWriter(input) {
      calls.takeWriter.push(input.tabId);
      if (options.takeWriterError !== undefined) throw options.takeWriterError;
      return snapshot(intents.find((item) => item.tabId === input.tabId));
    },
    async reconnect(input) {
      calls.reconnect.push(input.tabId);
      const intent = intents.find((item) => item.tabId === input.tabId);
      const ready = snapshot(intent, 2);
      await callbacks.onTerminalReady(ready);
      callbacks.onTerminalState(ready);
      return ready;
    },
    async sendInput(bytes, tabId, authority) {
      if (bytes.length === 1 && bytes[0] === 0x0c) {
        calls.repaint.push({ tabId, authority });
        return;
      }
      calls.inputAuthorities.push(authority);
      calls.input.push({ tabId, text: decoder.decode(bytes) });
      if (options.inputGate !== undefined) await options.inputGate;
    },
    async resize(columns, rows, tabId) { calls.resize.push({ columns, rows, tabId }); },
    switchActive(tabId) { runtime.activeTabId = tabId; calls.switch.push(tabId); return snapshot(intents.find((item) => item.tabId === tabId)); },
    async sendTerminalResponse(response) { calls.responses.push(response); },
    async sendLocalActionControl(type, payload, tabId) { calls.localActionControls.push({ type, payload, tabId }); },
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

test("foreground coordinator owns host restoration and renders isolated cloud tabs under the Cuna appbar", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents);
  assert.equal(coordinator.state, "active");
  assert.equal(host.acquired, 1);
  assert.equal(calls.attach.length, 2);
  assert.equal(calls.attach[0].rows, 22);
  const attachingFrame = decoder.decode(host.writes[0]);
  assert.match(attachingFrame, /CUNA  ATTACHING 2 EXACT AGENTSESSIONS/u);
  assert.doesNotMatch(attachingFrame, /\bRUNA\b/u);
  assert.match(decoder.decode(host.writes.at(-1)), /48;2;235;86;37m/);

  await callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("cloud output")));
  assert.match(decoder.decode(host.writes.at(-1)), /cloud output/);
  await callbacks.onTerminalOutput(outputEvent(intents[0], 2n, encoder.encode("\r\n\u001b[38;5;208;1mstyled cloud\u001b[0m")));
  const styledFrame = decoder.decode(host.writes.at(-1));
  assert.equal(
    styledFrame.includes("\u001b[0;1;38;5;208mstyled cloud"),
    true,
    "VTE-parsed remote styling should survive rich composition",
  );

  await coordinator.stop();
  assert.equal(coordinator.state, "stopped");
  assert.deepEqual(calls.detach, ["tab-a", "tab-b"]);
  assert.equal(host.restored, 1);
  assert.equal(host.removedInput, 1);
  assert.equal(host.removedResize, 1);
});

test("rich attach forces one bounded provider repaint after replay", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  assert.deepEqual(calls.resize, [
    { columns: 80, rows: 21, tabId: "tab-a" },
    { columns: 80, rows: 22, tabId: "tab-a" },
  ]);
  assert.equal(calls.repaint.length, 1);
  assert.equal(calls.repaint[0].tabId, "tab-a");
  assert.deepEqual(calls.repaint[0].authority, {
    userId: "user-1",
    machineId: "machine-1",
    agentSessionId: SESSION_A,
    processEpoch: `epoch-${SESSION_A}`,
    fencingGeneration: 1,
  });
  await coordinator.stop();
  assert.equal(host.restored, 1);
});

test("rich Ctrl+C cancels a pending initial attach and restores immediately", async () => {
  let releaseAttach;
  const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
  const { coordinator, calls, host, intents } = harness({ attachGate });
  const starting = coordinator.start(intents.slice(0, 1));
  await waitUntil(() => calls.attach.length === 1 && host.input !== undefined, "rich terminal should own input while attach is pending");
  const baselineWrites = host.writes.length;
  host.emitInput(Uint8Array.of(0x03));
  await waitUntil(
    () => host.writes.slice(baselineWrites).some((bytes) => decoder.decode(bytes).includes("✦ Closing Cuna...")),
    "a startup interrupt should visibly acknowledge closing before restoration",
  );
  assert.equal(host.restored, 0);
  assert.deepEqual(calls.input, [], "startup Ctrl-C must remain local and never reach the remote PTY");
  await starting;
  await coordinator.waitForStop();
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 1);
  assert.deepEqual(calls.detach, []);
  assert.deepEqual(calls.input, []);
  const closing = host.writes.slice(baselineWrites).map((bytes) => decoder.decode(bytes));
  assert.equal(closing.some((frame) => frame.includes("CUNA  CLOSING")), true);
  assert.equal(closing.some((frame) => frame.includes("✦ Closing Cuna...")), true);
  assert.equal(closing.some((frame) => frame.includes("✓ Closed.")), true);
  assert.equal(host.writesAtRestore, host.writes.length, "startup close feedback must finish before prompt restoration");
  releaseAttach();
});

test("rich attach keeps a visible animated authority check until the remote terminal is ready", async () => {
  let releaseAttach;
  const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
  const { coordinator, calls, host, intents } = harness({ attachGate });
  const starting = coordinator.start(intents.slice(0, 1));
  await waitUntil(
    () => calls.attach.length === 1 && host.writes.length >= 2,
    "a pending cloud attach should repaint its loader rather than look frozen",
  );
  const frames = host.writes.map((bytes) => decoder.decode(bytes));
  assert.ok(frames.some((frame) => frame.includes("Checking terminal authority")));
  assert.ok(frames.some((frame) => frame.includes("Ctrl-C cancels")));
  assert.notEqual(frames[0], frames.at(-1), "the loading frame should visibly advance while authority is checked");

  host.emitInput(Uint8Array.of(0x03));
  await starting;
  await coordinator.waitForStop();
  releaseAttach();
});

test("disconnect feedback cadence is bounded to one second total", () => {
  const host = new FakeHost();
  assert.throws(
    () => new ForegroundTerminalCoordinator({ host, disconnectFrameMs: 251 }),
    /disconnect frame duration must be between 1 and 250 milliseconds/u,
  );
});

test("Claude OAuth opens once on the local machine only after explicit Cuna approval", async () => {
  const opened = [];
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: {
      browser: { async open(url) { opened.push(url); } },
      clock: () => 1_000,
    },
  });
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  const url = "https://platform.claude.com/oauth/authorize?code=true&state=opaque";
  await callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode(`${url}\r\n`)));
  assert.match(decoder.decode(host.writes.at(-1)), /Claude Code requests browser authentication/u);
  assert.deepEqual(opened, [], "remote output alone must never execute a local action");

  host.emitInput(Uint8Array.of(0x0d));
  await waitUntil(() => opened.length === 1, "local browser approval should settle");
  assert.deepEqual(opened, [url]);
  assert.deepEqual(calls.input, [], "approval input must not enter the remote PTY");
  assert.match(decoder.decode(host.writes.at(-1)), /Browser opened locally/u);

  host.emitInput(encoder.encode("\u001b[200~opaque-code\r\n\u001b[201~"));
  await waitUntil(() => calls.input.length === 1, "approved code paste should commit to the provider");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: "opaque-code\r" });

  await callbacks.onTerminalOutput(outputEvent(intents[0], 2n, encoder.encode(`${url}\r\n`)));
  host.emitInput(Uint8Array.of(0x0d));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 1, "replayed provider output must not reopen the browser");
  await coordinator.stop();
});

test("negotiated remote browser request stays awaiting until provider observation or cancellation", async () => {
  const opened = [];
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: {
      browser: { async open(url) { opened.push(url); } },
      deviceId: "device-1",
      clock: () => 1_000,
    },
  });
  await coordinator.start(intents.slice(0, 1));
  assert.deepEqual(callbacks.localActionKinds(SESSION_A), ["browser.open"]);
  const url = "https://platform.claude.com/oauth/authorize?code=true&state=remote";
  const args = Object.freeze({ url });
  const request = Object.freeze({
    version: 1,
    id: "remote-browser-1",
    identity: Object.freeze({
      userId: "user-1",
      deviceId: "device-1",
      machineId: "machine-1",
      workspaceBindingId: null,
      workspaceBindingGeneration: null,
      agentSessionId: SESSION_A,
      processEpoch: `epoch-${SESSION_A}`,
      fencingGeneration: 1,
    }),
    provider: "claude-code",
    kind: "browser.open",
    arguments: args,
    argumentsDigest: digestLocalActionArguments(args),
    requestedScope: "mcp:browser.open",
    createdAt: 1_000,
    expiresAt: 61_000,
    nonce: "remote-nonce-1",
  });
  await callbacks.onLocalActionFrame({
    tabId: "tab-a",
    frame: { type: "local_action_request" },
    payload: { request },
  });
  assert.match(decoder.decode(host.writes.at(-1)), /Claude Code requests browser authentication/u);
  assert.deepEqual(opened, []);

  host.emitInput(Uint8Array.of(0x0d));
  await waitUntil(() => opened.length === 1, "local browser should open after approval");
  assert.deepEqual(opened, [url]);
  assert.equal(calls.localActionControls.length, 0, "opening a browser must not claim provider completion");
  await coordinator.stop();
  assert.equal(calls.localActionControls.length, 1, "foreground stop returns one fenced cancellation");
  assert.equal(calls.localActionControls[0].type, "local_action_result");
  assert.equal(calls.localActionControls[0].tabId, "tab-a");
  assert.equal(calls.localActionControls[0].payload.result.status, "cancelled");
});

test("OpenCode remote TUI output is relayed and never opens a local browser", async () => {
  const opened = [];
  const { coordinator, callbacks, host, intents } = harness({
    coordinatorOptions: {
      browser: { async open(url) { opened.push(url); } },
      clock: () => 1_000,
    },
  });
  intents[0].agent = "opencode";
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  assert.deepEqual(callbacks.localActionKinds(SESSION_A), []);
  await callbacks.onTerminalOutput(outputEvent(
    intents[0], 1n, encoder.encode("OpenCode: use /connect to choose a provider, then /models.\r\n"),
  ));
  assert.match(decoder.decode(host.writes.at(-1)), /\/connect/u);
  assert.doesNotMatch(decoder.decode(host.writes.at(-1)), /requests browser authentication/u);
  assert.deepEqual(opened, []);
  await coordinator.stop();
});

test("RTP local-action negotiation is scoped to the attached provider", async () => {
  const { coordinator, callbacks, intents } = harness();
  intents[0].agent = "opencode";
  await coordinator.start(intents);
  assert.deepEqual(callbacks.localActionKinds(SESSION_A), []);
  assert.deepEqual(callbacks.localActionKinds(SESSION_B), ["browser.open", "auth.device.present"]);
  await coordinator.stop();
});

test("OpenCode remote local-action frames are rejected before the broker", async () => {
  const opened = [];
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: {
      browser: { async open(url) { opened.push(url); } },
      deviceId: "device-1",
      clock: () => 1_000,
    },
  });
  intents[0].agent = "opencode";
  await coordinator.start(intents.slice(0, 1));
  const args = Object.freeze({ url: "https://example.test/local-action" });
  const request = Object.freeze({
    version: 1,
    id: "remote-opencode-local-action-1",
    identity: Object.freeze({
      userId: "user-1",
      deviceId: "device-1",
      machineId: "machine-1",
      workspaceBindingId: null,
      workspaceBindingGeneration: null,
      agentSessionId: SESSION_A,
      processEpoch: `epoch-${SESSION_A}`,
      fencingGeneration: 1,
    }),
    provider: "opencode",
    kind: "browser.open",
    arguments: args,
    argumentsDigest: digestLocalActionArguments(args),
    requestedScope: "mcp:browser.open",
    createdAt: 1_000,
    expiresAt: 61_000,
    nonce: "remote-opencode-local-action-nonce-1",
  });
  await assert.rejects(
    callbacks.onLocalActionFrame({
      tabId: "tab-a",
      frame: { type: "local_action_request" },
      payload: { request },
    }),
    /not negotiated by the foreground/u,
  );
  assert.deepEqual(opened, []);
  assert.equal(calls.localActionControls.length, 0);
  assert.doesNotMatch(decoder.decode(host.writes.at(-1)), /requests browser authentication/u);
  await coordinator.stop();
});

test("denied and cross-provider browser URLs never execute locally", async () => {
  const opened = [];
  const { coordinator, callbacks, host, intents } = harness({
    coordinatorOptions: { browser: { async open(url) { opened.push(url); } } },
  });
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  await callbacks.onTerminalOutput(outputEvent(
    intents[0], 1n, encoder.encode("https://auth.openai.com/codex/device\r\n"),
  ));
  assert.doesNotMatch(decoder.decode(host.writes.at(-1)), /requests browser authentication/u);
  await callbacks.onTerminalOutput(outputEvent(
    intents[0], 2n, encoder.encode("https://platform.claude.com/oauth/authorize?state=deny\r\n"),
  ));
  host.emitInput(Uint8Array.of(0x64));
  await waitUntil(() => /authentication denied/u.test(decoder.decode(host.writes.at(-1))), "deny should render");
  assert.deepEqual(opened, []);
  await coordinator.stop();
});

test("provider code beginning with d remains byte-exact PTY data instead of a deny decision", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  await callbacks.onTerminalOutput(outputEvent(
    intents[0], 1n,
    encoder.encode("https://platform.claude.com/oauth/authorize?code=true&state=opaque\r\n"),
  ));
  const codePaste = encoder.encode("\u001b[200~d-code-is-opaque\u001b[201~");
  host.emitInput(codePaste);
  await waitUntil(() => calls.input.length === 1, "opaque provider code should reach the PTY");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: decoder.decode(codePaste) });
  assert.doesNotMatch(decoder.decode(host.writes.at(-1)), /authentication denied/u);
  await coordinator.stop();
});

test("single-byte provider code input is PTY data while a browser action is pending", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: { browser: { open: async () => undefined } },
  });
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  await callbacks.onTerminalOutput(outputEvent(
    intents[0],
    1n,
    encoder.encode("https://platform.claude.com/oauth/authorize?code=true&state=opaque\r\n"),
  ));

  host.emitInput(encoder.encode("x"));
  await waitUntil(() => calls.input.length === 1, "a typed provider-code character should reach the PTY");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: "x" });
  await coordinator.stop();
});

test("pasting the Claude sign-in URL is blocked with a corrective prompt while the actual code passes", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  const url = "https://platform.claude.com/oauth/authorize?code=true&state=opaque";
  await callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode(`${url}\r\n`)));

  const urlPaste = encoder.encode(`\u001b[200~${url}\u001b[201~`);
  host.emitInput(urlPaste.subarray(0, 11));
  host.emitInput(urlPaste.subarray(11));
  await waitUntil(
    () => /sign-in link, not the code/u.test(decoder.decode(host.writes.at(-1))),
    "the URL paste should produce local corrective feedback",
  );
  assert.deepEqual(calls.input, [], "the OAuth URL must not enter the hidden provider-code prompt");

  const codePaste = encoder.encode("\u001b[200~valid-code-123\u001b[201~");
  host.emitInput(codePaste);
  await waitUntil(() => calls.input.length === 1, "the actual provider code should reach the PTY");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: decoder.decode(codePaste) });
  await coordinator.stop();
});

test("one Ctrl-C detaches even when a bracketed paste never receives its end marker", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  host.emitInput(encoder.encode("\u001b[200~partial"));
  await waitUntil(() => calls.input.length === 1, "partial paste should enter the bounded terminal path");
  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["tab-a"]);
});

test("a hanging browser opener never blocks one-Ctrl-C detach", async () => {
  let releaseBrowser;
  let browserStarted = false;
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: {
      browser: { open: async () => {
        browserStarted = true;
        await new Promise((resolve) => { releaseBrowser = resolve; });
      } },
    },
  });
  intents[0].localBrowserActions = true;
  await coordinator.start(intents.slice(0, 1));
  await callbacks.onTerminalOutput(outputEvent(
    intents[0], 1n, encoder.encode("https://platform.claude.com/oauth/authorize?code=true&state=hanging\r\n"),
  ));
  host.emitInput(Uint8Array.of(0x0d));
  await waitUntil(() => browserStarted, "browser action should start");
  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["tab-a"]);
  releaseBrowser?.();
});

test("TC-055-02 invalid dimensions cause zero host acquisition", async () => {
  const host = new FakeHost();
  host.columns = 10;
  const { coordinator, intents } = harness({ host });
  await assert.rejects(coordinator.start(intents.slice(0, 1)), /dimensions/u);
  assert.equal(host.acquired, 0);
  assert.equal(host.restored, 0);
});

test("TC-055-02 a legitimate resize during ownership acquisition uses the newest admitted dimensions", async () => {
  const host = new FakeHost();
  host.onAcquire = () => { host.columns = 100; host.rows = 30; };
  const { coordinator, calls, intents } = harness({ host });
  await coordinator.start(intents.slice(0, 1));
  assert.equal(calls.attach[0].columns, 100);
  assert.equal(calls.attach[0].rows, 28);
  await coordinator.stop();
});

test("a resize while initial attach is pending reconciles the fenced VTE and remote geometry", async () => {
  const host = new FakeHost();
  host.columns = 120;
  host.rows = 30;
  const { coordinator, callbacks, calls, intents, runtime } = harness({ host });
  runtime.attach = async (input) => {
    calls.attach.push(input);
    host.columns = 74;
    host.rows = 20;
    host.emitResize();
    const ready = snapshot(intents[0]);
    await callbacks.onTerminalReady(ready);
    runtime.activeTabId = input.tabId;
    return ready;
  };

  await coordinator.start(intents.slice(0, 1));

  assert.equal(calls.attach[0].columns, 120);
  assert.equal(calls.attach[0].rows, 28);
  assert.deepEqual(calls.resize, [
    { columns: 74, rows: 17, tabId: "tab-a" },
    { columns: 74, rows: 18, tabId: "tab-a" },
  ]);
  assert.equal(calls.repaint.length, 1, "initial replay should still request exactly one provider redraw");
  assert.equal(coordinator.state, "active");
  await coordinator.stop();
});

test("TC-055-13 waitForStop observes completed cleanup without polling", async () => {
  const { coordinator, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  const stopped = coordinator.waitForStop();
  await coordinator.stop();
  await stopped;
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 1);
});

test("TC-055-18 failed host restoration retains authority for an explicit cleanup retry", async () => {
  const host = new FakeHost();
  const { coordinator, intents } = harness({ host });
  await coordinator.start(intents.slice(0, 1));
  host.failRestore = true;
  const firstWaiter = assert.rejects(coordinator.waitForStop(), /cleanup was incomplete/u);
  await assert.rejects(coordinator.stop(), /cleanup was incomplete/u);
  await firstWaiter;
  assert.equal(coordinator.state, "failed");
  assert.equal(host.restored, 1);
  host.failRestore = false;
  await coordinator.stop();
  await coordinator.waitForStop();
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 2);
});

test("foreground appbar shows live attachment truth without unresolved lifecycle noise", async () => {
  const { coordinator, host, intents } = harness({ coordinatorOptions: { clock: () => 150 } });
  await coordinator.start(intents.slice(0, 1));
  const frame = decoder.decode(host.writes.at(-1));
  assert.doesNotMatch(frame, /machine unknown|session unknown|sync unknown/u);
  assert.match(frame, /terminal attached/u);
  await coordinator.stop();
});

test("expired auxiliary observations never replace live foreground attachment truth", async () => {
  let now = 150;
  const host = new FakeHost();
  host.columns = 120;
  const { coordinator, callbacks, intents } = harness({ host, coordinatorOptions: { clock: () => now } });
  const authoritativeIntent = {
    ...intents[0],
    agentSessionLifecycle: {
      value: "running",
      source: "cuna_agent_session_supervisor",
      observedAt: 100,
      expiresAt: 175,
      correlationId: "revision-1",
    },
    providerAuthentication: {
      value: "authenticated",
      source: "cuna_agent_auth:runa.agent-auth.v1:provider_cli_login_status",
      observedAt: 100,
      expiresAt: 175,
      correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  };
  await coordinator.start([authoritativeIntent]);
  let frame = decoder.decode(host.writes.at(-1));
  assert.doesNotMatch(frame, /machine |session |sync /u);
  assert.match(frame, /terminal attached/u);
  assert.match(frame, /Claude auth authenticated/u);

  now = 180;
  callbacks.onTerminalState(snapshot(authoritativeIntent));
  await waitUntil(() => decoder.decode(host.writes.at(-1)).includes("Claude auth stale"), "expired provider evidence should render stale");
  frame = decoder.decode(host.writes.at(-1));
  assert.doesNotMatch(frame, /machine |session |sync /u);
  assert.match(frame, /terminal attached/u);
  assert.match(frame, /Claude auth stale/u);
  await coordinator.stop();
});

test("local detach removes only the active tab and preserves foreground ownership for siblings", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await waitUntil(() => calls.detach.length === 1, "the active tab should detach");
  await waitUntil(() => calls.switch.includes("tab-b"), "a sibling should become active");
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(coordinator.state, "active");
  assert.equal(host.restored, 0);

  host.emitInput(encoder.encode("B"));
  await waitUntil(() => calls.input.length === 1, "input should continue through the remaining tab");
  assert.deepEqual(calls.input[0], { tabId: "tab-b", text: "B" });
  await coordinator.stop();
  assert.deepEqual(calls.detach, ["tab-a", "tab-b"]);
  assert.equal(host.restored, 1);
});

test("queued input retains its receipt-time tab and generation across asynchronous active-tab failure", async () => {
  const { coordinator, callbacks, calls, host, intents, runtime } = harness();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered = false;
  runtime.sendInput = async (bytes, tabId, authority) => {
    if (bytes.length === 1 && bytes[0] === 0x0c) return;
    calls.inputAuthorities.push(authority);
    calls.input.push({ tabId, text: decoder.decode(bytes) });
    if (!firstEntered) {
      firstEntered = true;
      await firstBlocked;
    }
  };
  await coordinator.start(intents);

  host.emitInput(encoder.encode("first"));
  await waitUntil(() => firstEntered, "the first receipt should occupy the serialized send boundary");
  host.emitInput(encoder.encode("secret-for-a"));
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "failed" });
  await waitUntil(() => calls.switch.includes("tab-b"), "the asynchronous failure should select the sibling tab");
  releaseFirst();
  await waitUntil(() => calls.input.length === 2, "the queued receipt should be adjudicated after the failure");

  assert.deepEqual(calls.input.map(({ tabId }) => tabId), ["tab-a", "tab-a"]);
  assert.equal(calls.inputAuthorities.every((authority) => authority?.agentSessionId === SESSION_A), true);
  assert.equal(calls.inputAuthorities.every((authority) => authority?.fencingGeneration === 1), true);
  await coordinator.stop();
});

test("queued input never inherits a replacement generation that became ready after receipt", async () => {
  const { coordinator, callbacks, calls, host, intents, runtime } = harness();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered = false;
  runtime.sendInput = async (bytes, tabId, authority) => {
    if (bytes.length === 1 && bytes[0] === 0x0c) return;
    calls.inputAuthorities.push(authority);
    calls.input.push({ tabId, text: decoder.decode(bytes) });
    if (!firstEntered) {
      firstEntered = true;
      await firstBlocked;
    }
  };
  await coordinator.start(intents.slice(0, 1));

  host.emitInput(encoder.encode("first"));
  await waitUntil(() => firstEntered, "the first generation should occupy the send boundary");
  host.emitInput(encoder.encode("generation-one-only"));
  await callbacks.onTerminalReady(snapshot(intents[0], 2));
  releaseFirst();
  await waitUntil(() => calls.input.length === 2, "the queued receipt should drain after replacement readiness");

  assert.equal(calls.inputAuthorities[1]?.fencingGeneration, 1);
  assert.equal(calls.inputAuthorities[1]?.processEpoch, `epoch-${SESSION_A}`);
  await coordinator.stop();
});

test("a split local prefix remains bound to its original tab across asynchronous failure", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents);
  host.emitInput(Uint8Array.of(0x1d));
  await new Promise((resolve) => setImmediate(resolve));
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "failed" });
  await waitUntil(() => calls.switch.includes("tab-b"), "the sibling should become active after failure");
  host.emitInput(Uint8Array.of(0x64));
  await waitUntil(() => calls.detach.length === 1, "the split chord should be adjudicated against its receipt tab");
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(coordinator.state, "active");
  await coordinator.stop();
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

test("TC-055-07/08 escape help and tab chords stay local while Ctrl+] c sends a remote interrupt", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents);
  host.emitInput(Uint8Array.of(0x1a, 0x41));
  await waitUntil(() => calls.input.length === 1, "ordinary raw input should reach the initial tab");
  assert.deepEqual(calls.input[0], { tabId: "tab-a", text: "\u001aA" });

  host.emitInput(Uint8Array.of(0x1d, 0x63));
  await waitUntil(() => calls.input.length === 2, "the explicit remote interrupt chord should reach the active tab");
  assert.deepEqual(calls.input[1], { tabId: "tab-a", text: "\u0003" });

  host.emitInput(Uint8Array.of(0x1d, 0x3f));
  await waitUntil(() => decoder.decode(host.writes.at(-1)).includes("Keys: Ctrl+C detach"), "trusted appbar should show local escape help");

  host.emitInput(Uint8Array.of(0x1d));
  host.emitInput(Uint8Array.of(0x32, 0x42));
  await waitUntil(() => calls.input.length === 3, "payload after a tab chord should reach the selected tab");
  assert.deepEqual(calls.switch, ["tab-b"]);
  assert.deepEqual(calls.input[2], { tabId: "tab-b", text: "B" });

  host.emitInput(Uint8Array.of(0x1d, 0x1d));
  await waitUntil(() => calls.input.length === 4, "double prefix should send one literal prefix");
  assert.equal(calls.input[3].tabId, "tab-b");
  assert.equal(calls.input[3].text.charCodeAt(0), 0x1d);
  await coordinator.stop();
});

test("Ctrl+S cannot silently XOFF the remote PTY and explicit escape chords preserve raw flow control", async () => {
  const { coordinator, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));

  host.emitInput(Uint8Array.of(0x13));
  await waitUntil(() => calls.input.length === 1, "local Ctrl+S should proactively send XON");
  assert.equal(calls.input[0].text, "\u0011");
  assert.match(decoder.decode(host.writes.at(-1)), /Terminal output kept active/u);

  host.emitInput(Uint8Array.of(0x1d, 0x73, 0x1d, 0x71));
  await waitUntil(() => calls.input.length >= 3, "explicit flow-control chords should reach the PTY");
  assert.equal(calls.input.slice(1).map((item) => item.text).join(""), "\u0013\u0011");
  await coordinator.stop();
});

test("Ctrl+C keeps the Cuna frame visible through deterministic disconnect feedback before restore", async () => {
  let releaseDetach;
  const detachGate = new Promise((resolve) => { releaseDetach = resolve; });
  const { coordinator, calls, host, intents } = harness({
    detachGate,
    detachStateSequence: ["interrupted", "detached"],
    coordinatorOptions: { disconnectFrameMs: 1 },
  });
  await coordinator.start(intents.slice(0, 1));
  const baselineWrites = host.writes.length;
  host.emitInput(Uint8Array.of(0x03));
  await waitUntil(
    () => host.writes.slice(baselineWrites).some((bytes) => decoder.decode(bytes).includes("Disconnecting...")),
    "Ctrl-C should acknowledge closing before a blocked detach resolves",
  );
  const pendingFrames = host.writes.slice(baselineWrites).map((bytes) => decoder.decode(bytes));
  assert.equal(pendingFrames.every((frame) => frame.includes("CUNA")), true);
  assert.equal(pendingFrames.some((frame) => frame.includes("Disconnected.")), false);
  assert.equal(host.restored, 0);
  releaseDetach();
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.deepEqual(calls.input, []);
  const closingFrames = host.writes.slice(baselineWrites).map((bytes) => decoder.decode(bytes));
  assert.equal(closingFrames.some((frame) => frame.includes("✦ Disconnecting...")), true);
  assert.equal(closingFrames.some((frame) => frame.includes("✧ Disconnecting...")), true);
  assert.equal(closingFrames.some((frame) => frame.includes("✓ Disconnected.")), true);
  assert.equal(host.restored, 1);
  assert.equal(host.writesAtRestore, host.writes.length, "restore must follow the final closing frame");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.writes.length, host.writesAtRestore, "no closing frame may write after restore");
  assert.equal(coordinator.failure, undefined);
});

test("rich no-color keeps disconnect feedback while emitting no color SGR", async () => {
  const { coordinator, host, intents } = harness({
    coordinatorOptions: { color: false, disconnectFrameMs: 1 },
  });
  await coordinator.start(intents.slice(0, 1));
  const baselineWrites = host.writes.length;
  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  const closing = Buffer.concat(host.writes.slice(baselineWrites).map((bytes) => Buffer.from(bytes))).toString();
  assert.match(closing, /Disconnecting\.\.\./u);
  assert.match(closing, /Disconnected\./u);
  const colorSgr = new RegExp(`${String.fromCharCode(27)}\\[(?:3[0-9]|4[0-9]|9[0-7]|38|48)(?:;|m)`, "u");
  assert.equal(colorSgr.test(closing), false);
});

test("a detach failure never paints Disconnected or becomes a successful rich close", async () => {
  const detachError = new Error("remote detach rejected");
  const { coordinator, host, intents } = harness({
    detachError,
    coordinatorOptions: { disconnectFrameMs: 1 },
  });
  await coordinator.start(intents.slice(0, 1));
  const baselineWrites = host.writes.length;
  host.emitInput(Uint8Array.of(0x03));
  await assert.rejects(coordinator.waitForStop(), /cleanup was incomplete/u);
  const closing = Buffer.concat(host.writes.slice(baselineWrites).map((bytes) => Buffer.from(bytes))).toString();
  assert.match(closing, /Disconnecting\.\.\./u);
  assert.doesNotMatch(closing, /Disconnected\./u);
  assert.equal(coordinator.failure, detachError);
  assert.equal(host.restored, 1);
});

test("closing animation is best-effort when one decorative host frame fails", async () => {
  const { coordinator, host, intents } = harness({ coordinatorOptions: { disconnectFrameMs: 1 } });
  await coordinator.start(intents.slice(0, 1));
  host.failWriteAt = host.writeAttempts + 1;
  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.equal(coordinator.failure, undefined);
  assert.equal(host.restored, 1);
  assert.equal(host.writes.some((bytes) => decoder.decode(bytes).includes("Disconnected.")), true);
});

test("rich Ctrl+C intent wins a transport close before its queued detach executes", async () => {
  let releaseInput;
  const inputGate = new Promise((resolve) => { releaseInput = resolve; });
  const { coordinator, callbacks, calls, host, intents } = harness({
    inputGate,
    coordinatorOptions: { disconnectFrameMs: 1 },
  });
  await coordinator.start(intents.slice(0, 1));
  host.emitInput(Uint8Array.of(0x41));
  await waitUntil(() => calls.input.length === 1, "the earlier rich input should hold the serialized tail");

  host.emitInput(Uint8Array.of(0x03));
  await waitUntil(
    () => host.writes.some((bytes) => decoder.decode(bytes).includes("Disconnecting...")),
    "receipt-time close feedback should not wait behind prior remote input",
  );
  assert.deepEqual(calls.detach, [], "the serialized detach should still wait behind admitted input");
  callbacks.onTerminalState({
    ...snapshot(intents[0]),
    state: "interrupted",
    reason: "transport_closed_without_terminal_exit",
  });
  releaseInput();

  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(coordinator.failure, undefined);
  assert.equal(coordinator.state, "stopped");
  assert.equal(host.restored, 1);
});

test("Ctrl+C on one rich tab returns to its sibling without restoring the workbench", async () => {
  const { coordinator, calls, host, intents } = harness({ coordinatorOptions: { disconnectFrameMs: 1 } });
  await coordinator.start(intents);
  const baselineWrites = host.writes.length;
  host.emitInput(Uint8Array.of(0x03));
  await waitUntil(() => calls.switch.includes("tab-b"), "the sibling should become active after local close");
  assert.deepEqual(calls.detach, ["tab-a"]);
  assert.equal(host.restored, 0);
  assert.equal(coordinator.state, "active");
  assert.equal(host.writes.slice(baselineWrites).some((bytes) => decoder.decode(bytes).includes("Disconnecting...")), true);
  assert.equal(decoder.decode(host.writes.at(-1)).includes("Disconnecting..."), false);
  assert.match(decoder.decode(host.writes.at(-1)), /Codex review/u);
  host.emitInput(encoder.encode("B"));
  await waitUntil(() => calls.input.some((item) => item.tabId === "tab-b" && item.text === "B"), "the sibling should remain operable");
  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.deepEqual(calls.detach, ["tab-a", "tab-b"]);
  assert.equal(host.restored, 1);
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
  const baseline = calls.resize.length;
  for (let index = 0; index < 100; index += 1) {
    host.columns = 90 + index;
    host.rows = 30 + index;
    host.emitResize();
  }
  await waitUntil(() => calls.resize.length === baseline + 1, "resize storm should coalesce to one remote mutation");
  assert.deepEqual(calls.resize.at(-1), { columns: 189, rows: 127, tabId: "tab-a" });
  await coordinator.stop();
});

test("remote fullscreen output waits for VTE resize before composing a narrower host frame", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness({
    coordinatorOptions: { resizeCoalesceMs: 50 },
  });
  await coordinator.start(intents.slice(0, 1));
  const baselineResizes = calls.resize.length;
  const baselineWrites = host.writes.length;

  host.columns = 40;
  host.rows = 12;
  host.emitResize();
  await callbacks.onTerminalOutput(outputEvent(
    intents[0],
    1n,
    encoder.encode(`\u001b[?1049h\u001b[H\u001b[38;5;208m${"provider-frame-".repeat(6)}\u001b[0m`),
  ));

  assert.equal(
    host.writes.length,
    baselineWrites,
    "the stale 80-column VTE must not be composed into the observed 40-column host",
  );
  await waitUntil(
    () => calls.resize.length === baselineResizes + 1 && host.writes.length > baselineWrites,
    "the coalesced resize should publish one complete replacement frame",
  );
  const frame = decoder.decode(host.writes.at(-1));
  assert.match(frame, /CUNA/u);
  assert.match(frame, /provider-frame/u);
  assert.equal(coordinator.state, "active");

  host.emitInput(Uint8Array.of(0x03));
  await coordinator.waitForStop();
  assert.equal(host.restored, 1);
  assert.equal(coordinator.failure, undefined);
});

test("terminal state storms coalesce to bounded latest-state rendering", async () => {
  const { coordinator, callbacks, host, intents } = harness({ coordinatorOptions: { clock: () => 150 } });
  await coordinator.start(intents.slice(0, 1));
  const baseline = host.writeAttempts;
  let releaseWrite;
  host.writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  callbacks.onTerminalState(snapshot(intents[0]));
  await waitUntil(() => host.writeAttempts === baseline + 1, "the single state renderer should reach host backpressure");
  for (let index = 0; index < 1_000; index += 1) {
    callbacks.onTerminalState({ ...snapshot(intents[0]), inputSequence: BigInt(index + 1) });
  }
  assert.equal(host.writeAttempts, baseline + 1, "a blocked host must not accumulate one render per state event");
  releaseWrite();
  await waitUntil(() => host.writeAttempts === baseline + 2, "one coalesced render should publish the latest state");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.writeAttempts, baseline + 2);
  await coordinator.stop();
});

test("startup render failure detaches partial tabs and restores the host lease", async () => {
  const host = new FakeHost();
  host.failWriteAt = 2;
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
  assert.match(coordinator.failure?.message ?? "", /cancelled/u);
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

test("input during interrupted recovery is explicitly withheld instead of silently discarded", async () => {
  let releaseReconnect;
  const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
  const { coordinator, callbacks, calls, host, intents, runtime } = harness();
  runtime.reconnect = async (input) => {
    calls.reconnect.push(input.tabId);
    await reconnectGate;
    const ready = snapshot(intents[0], 2);
    await callbacks.onTerminalReady(ready);
    callbacks.onTerminalState(ready);
    return ready;
  };
  await coordinator.start(intents.slice(0, 1));
  const baselineResizes = calls.resize.length;
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "interrupted", reason: "transport_closed" });
  await waitUntil(() => calls.reconnect.length === 1, "recovery should own the interrupted tab");

  host.emitInput(encoder.encode("must-not-drop"));
  await waitUntil(
    () => decoder.decode(host.writes.at(-1)).includes("input was not sent"),
    "the user should receive explicit delivery status",
  );
  assert.deepEqual(calls.input, []);

  releaseReconnect();
  await waitUntil(() => calls.resize.length > baselineResizes, "the replacement should restore input authority");
  host.emitInput(encoder.encode("after-reconnect"));
  await waitUntil(() => calls.input.length === 1, "post-reconnect input should use the new fence");
  assert.equal(calls.input[0].text, "after-reconnect");
  await coordinator.stop();
});

test("input fenced after active receipt is reported as unsent and never retried", async () => {
  let releaseReconnect;
  const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
  const { coordinator, callbacks, calls, host, intents, runtime } = harness();
  runtime.reconnect = async (input) => {
    calls.reconnect.push(input.tabId);
    await reconnectGate;
    const ready = snapshot(intents[0], 2);
    await callbacks.onTerminalReady(ready);
    callbacks.onTerminalState(ready);
    return ready;
  };
  await coordinator.start(intents.slice(0, 1));
  const healthySendInput = runtime.sendInput;
  runtime.sendInput = async () => {
    throw runtimeFailure("terminal_disconnected", "The old terminal fence is closed.", { retryable: true });
  };

  host.emitInput(encoder.encode("race-window"));
  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "interrupted", reason: "transport_closed" });
  await waitUntil(
    () => decoder.decode(host.writes.at(-1)).includes("input was not sent"),
    "a pre-wire fencing race should receive explicit delivery feedback",
  );
  assert.deepEqual(calls.input, [], "the rejected bytes must never be retried or reported as delivered");

  runtime.sendInput = healthySendInput;
  releaseReconnect();
  await coordinator.stop();
});

test("a resize whose debounce expires during reconnect is reconciled after the new fence becomes active", async () => {
  const { coordinator, callbacks, calls, host, intents, runtime } = harness({
    coordinatorOptions: { reconnectAttempts: 1, reconnectBaseDelayMs: 1, resizeCoalesceMs: 5 },
  });
  await coordinator.start(intents.slice(0, 1));
  const baselineResizes = calls.resize.length;
  const baselineRepaints = calls.repaint.length;
  runtime.reconnect = async (input) => {
    calls.reconnect.push(input.tabId);
    const beforeReconnectingRender = host.writes.length;
    callbacks.onTerminalState({ ...snapshot(intents[0]), state: "reconnecting" });
    await waitUntil(
      () => host.writes.length > beforeReconnectingRender,
      "the reconnecting state should settle before the resize",
    );
    const beforeResizeRender = host.writes.length;
    host.columns = 74;
    host.rows = 20;
    host.emitResize();
    await waitUntil(
      () => host.writes.length > beforeResizeRender,
      "the coalesced local resize should finish while the remote fence is reconnecting",
    );
    const ready = snapshot(intents[0], 2);
    await callbacks.onTerminalReady(ready);
    callbacks.onTerminalState(ready);
    return ready;
  };

  callbacks.onTerminalState({ ...snapshot(intents[0]), state: "interrupted", reason: "transport_closed" });
  await waitUntil(() => calls.resize.length === baselineResizes + 1, "reconnect should publish the final current geometry");

  assert.deepEqual(calls.resize.slice(baselineResizes), [
    { columns: 74, rows: 18, tabId: "tab-a" },
  ]);
  assert.equal(calls.repaint.length, baselineRepaints, "reconnect geometry must not add another Ctrl+L redraw");
  assert.deepEqual(calls.reconnect, ["tab-a"]);
  assert.equal(coordinator.state, "active");
  await coordinator.stop();
});

test("reconnect exhaustion isolates the failed tab without tearing down healthy foreground ownership", async () => {
  const { coordinator, callbacks, calls, host, intents, runtime } = harness({
    coordinatorOptions: { reconnectAttempts: 2, reconnectBaseDelayMs: 1 },
  });
  await coordinator.start(intents);
  const healthyReconnect = runtime.reconnect.bind(runtime);
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
  assert.match(coordinator.failure?.message ?? "", /replacement unavailable/u);
  assert.match(decoder.decode(host.writes.at(-1)), /Reconnect failed/u);
  runtime.reconnect = healthyReconnect;
  host.emitInput(Uint8Array.of(0x1d, 0x72));
  await waitUntil(() => calls.reconnect.length === 3, "manual retry should reattach the interrupted active tab");
  await waitUntil(() => coordinator.failure === undefined, "successful manual retry should clear only the recoverable reconnect failure");
  assert.equal(coordinator.state, "active");
  await coordinator.stop();
});

test("a replacement ready callback cannot resurrect a viewport after stop", async () => {
  const { coordinator, callbacks, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  let releaseWrite;
  host.writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const oldOutput = callbacks.onTerminalOutput(outputEvent(intents[0], 1n, encoder.encode("old")));
  await waitUntil(() => host.writes.length >= 2, "old output should hold the render tail");
  const replacement = assert.rejects(
    callbacks.onTerminalReady(snapshot(intents[0], 2)),
    /ownership ended/u,
  );
  const stopping = coordinator.stop();
  releaseWrite();
  await oldOutput;
  await replacement;
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
  const baseline = calls.resize.length;
  await callbacks.onTerminalOutput(outputEvent(intents[1], 1n, encoder.encode("x".repeat(70))));
  host.columns = 40;
  host.rows = 12;
  host.emitResize();
  await waitUntil(() => calls.resize.length === baseline + 2, "both cloud PTYs should receive the resized dimensions");
  host.emitInput(Uint8Array.of(0x1d, 0x32));
  await waitUntil(() => calls.switch.length === 1, "inactive tab should become selected");
  assert.equal(coordinator.state, "active");
  assert.deepEqual(calls.resize.slice(baseline), [
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

test("plain Node host restoration neutralizes hostile alternate-screen, focus, cursor, and keypad modes", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    readableFlowing = null;
    raw = false;
    setRawMode(value) { this.raw = value; }
    resume() { this.readableFlowing = true; return this; }
    pause() { this.readableFlowing = false; return this; }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    columns = 80;
    rows = 24;
    writes = [];
    write(value, callback) {
      this.writes.push(Buffer.from(value));
      callback?.(null);
      return true;
    }
  }
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const host = createNodeForegroundTerminalHost({ stdin, stdout, writeTimeoutMs: 100 });
  const lease = await host.acquire("plain");
  const acquired = Buffer.concat(stdout.writes).toString();
  assert.equal(acquired.includes("\u001b[?2004h"), true, "plain input is framed before a local detach chord can be trusted");

  await host.write(encoder.encode("\u001b[?1049h\u001b[?1004h\u001b[?1h\u001b="));
  await lease.restore();
  const restored = Buffer.concat(stdout.writes).toString();
  assert.equal(restored.includes("\u001b[?1049l"), true);
  assert.equal(restored.includes("\u001b[?1004l"), true);
  assert.equal(restored.includes("\u001b[?1l"), true);
  assert.equal(restored.includes("\u001b>"), true);
  assert.equal(stdin.raw, false);
  assert.equal(stdin.readableFlowing, false);
});

test("an observed tab says so on the notice line, and Ctrl+] w asks the runtime for the writer seat", async () => {
  const { coordinator, callbacks, calls, host, intents } = harness();
  await coordinator.start(intents.slice(0, 1));
  assert.equal(decoder.decode(host.writes.at(-1)).includes("Observing"), false, "a writer is not told it is observing");

  callbacks.onTerminalState({ ...snapshot(intents[0]), accessMode: "observer", writerEpoch: 2, writerClientInstanceId: "other-client" });
  await waitUntil(
    () => decoder.decode(host.writes.at(-1)).includes("Observing (read-only)"),
    "an observed tab renders its seat on the notice line",
  );

  host.emitInput(Uint8Array.of(0x1d, 0x77));
  await waitUntil(() => calls.takeWriter.length === 1, "the chord asks for the seat");
  assert.deepEqual(calls.takeWriter, ["tab-a"]);

  callbacks.onTerminalState({ ...snapshot(intents[0]), accessMode: "observer", writerEpoch: 2, reason: "writer_transferred" });
  await waitUntil(
    () => decoder.decode(host.writes.at(-1)).includes("Control moved to another client"),
    "a demoted writer is told the seat moved",
  );
  await coordinator.stop();
});

test("a refused seat request is reported on the notice line and does not stop the foreground", async () => {
  const failure = new Error("Terminal writer changed");
  const { coordinator, callbacks, calls, host, intents } = harness({ takeWriterError: failure });
  await coordinator.start(intents.slice(0, 1));
  callbacks.onTerminalState({ ...snapshot(intents[0]), accessMode: "observer", writerEpoch: 2 });
  host.emitInput(Uint8Array.of(0x1d, 0x77));
  await waitUntil(() => calls.takeWriter.length === 1, "the chord asks for the seat");
  await waitUntil(
    () => decoder.decode(host.writes.at(-1)).includes("Could not take control: Terminal writer changed"),
    "the refusal is shown with the server's own words",
  );
  assert.equal(coordinator.state, "active");
  await coordinator.stop();
});
