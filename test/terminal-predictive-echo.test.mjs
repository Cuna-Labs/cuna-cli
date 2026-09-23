import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";

import { ForegroundTerminalCoordinator, ViewportRegistry, XtermViewportAdapter } from "../dist/index.js";
import {
  PREDICTION_CONFIRM_TIMEOUT_MS,
  PredictiveEcho,
  insertionPoint,
  predictiveEchoModeFromEnvironment,
} from "../dist/terminal/predictive-echo.js";
import { renderWorkbenchFrame, withPredictionOverlay, workbenchUpdate } from "../dist/terminal/workbench.js";
import { runtimeFailure } from "../dist/runtime/errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ESC = "\u001b";
const KEY = "tab-1:1:1:40x6";
const binding = { userId: "user-1", machineId: "machine-1", agentSessionId: "agent-session-1", processEpoch: "process-epoch-1", fencingGeneration: 1 };

function screen() {
  const viewport = new XtermViewportAdapter({ tabId: "tab-1", binding, columns: 40, rows: 6, registry: new ViewportRegistry(), scrollback: 0 });
  let sequence = 0n;
  return {
    viewport,
    async write(text) { sequence += 1n; return await viewport.write(encoder.encode(text), sequence, sequence); },
    view() { return viewport.snapshot(); },
  };
}

function engine(mode = "on", onExpire = () => undefined) {
  let now = 1_000;
  const echo = new PredictiveEcho({ mode, clock: () => now, onExpire });
  return { echo, advance(ms) { now += ms; }, get now() { return now; } };
}

/** Three keys typed and echoed after `latencyMs`: the remote earns trust and an RTT estimate. */
async function train(term, clock, latencyMs = 100, keys = "abc") {
  for (const key of keys) {
    clock.echo.predict(encoder.encode(key), term.view(), KEY);
    clock.advance(latencyMs);
    await term.write(key);
    clock.echo.reconcile(term.view(), KEY);
  }
}

test("a trusted remote gets the typed glyph painted at once, dim and underlined, before any echo", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    assert.equal(clock.echo.statistics.confirmed, 3);
    assert.equal(clock.echo.predict(encoder.encode("d"), term.view(), KEY), true);
    const overlay = clock.echo.overlay(term.view(), KEY);
    assert.deepEqual({ ...overlay }, { row: 0, column: 5, text: "d", cursorColumn: 6, cursor: "cursor" });
    const frame = renderWorkbenchFrame({
      columns: 40, rows: 8, activeTabId: "tab-1",
      tabs: [{ id: "tab-1", label: "t", agent: "claude-code", viewport: term.view() }],
      appbar: { attachment: { status: "unknown" }, providerAuthentication: { status: "unknown" } },
    });
    const painted = withPredictionOverlay(frame, overlay);
    assert.ok(painted.text.includes(`${ESC}[3;6H${ESC}[0;2;4md${ESC}[0m`), "glyph drawn at the input point, dim and underlined");
    assert.ok(painted.cursorCommand.includes(`${ESC}[3;7H`), "cursor moves past the guess");
    assert.equal(term.view().cells[0], "> abc", "the mirrored remote screen never contains a guess");
    // Rolling back is an ordinary repaint of the true row.
    const rollback = decoder.decode(workbenchUpdate(painted, frame));
    assert.ok(rollback.includes(`${ESC}[3;1H${ESC}[0m${ESC}[2K`) && rollback.includes("> abc"), "the true row is repainted");
    assert.doesNotMatch(rollback, /2;4m/u);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("the real echo confirms a guess and it stops being painted", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    clock.echo.predict(encoder.encode("de"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "de");
    clock.advance(120);
    await term.write("d");
    clock.echo.reconcile(term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "e", "only the unconfirmed guess remains");
    await term.write("e");
    clock.echo.reconcile(term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    assert.equal(clock.echo.statistics.confirmed, 5);
    assert.equal(clock.echo.statistics.mispredicted, 0);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("a different echo rolls every guess back and withdraws trust until three fresh confirmations", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    clock.echo.predict(encoder.encode("xy"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "xy");
    await term.write("Q");
    assert.equal(clock.echo.reconcile(term.view(), KEY), true);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    assert.equal(clock.echo.statistics.mispredicted, 1);
    clock.echo.predict(encoder.encode("z"), term.view(), KEY);
    assert.equal(clock.echo.showing, false, "a remote that just echoed wrongly is not trusted");
    await term.write("z"); clock.echo.reconcile(term.view(), KEY);
    await train(term, clock, 100, "123");
    clock.echo.predict(encoder.encode("w"), term.view(), KEY);
    assert.equal(clock.echo.showing, true);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("an unconfirmed guess is withdrawn after the timeout and the host is asked to repaint", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = screen(); let expired = 0; const clock = engine("on", () => { expired += 1; });
  try {
    await term.write("> ");
    await train(term, clock);
    clock.echo.predict(encoder.encode("k"), term.view(), KEY);
    assert.equal(clock.echo.showing, true);
    clock.advance(PREDICTION_CONFIRM_TIMEOUT_MS - 1);
    t.mock.timers.tick(PREDICTION_CONFIRM_TIMEOUT_MS - 1);
    assert.equal(expired, 0);
    clock.advance(1);
    t.mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    assert.equal(clock.echo.statistics.expired, 1);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("auto mode paints nothing while the echo is faster than 60 ms; on ignores only that threshold", async () => {
  for (const [mode, shown] of [["auto", false], ["on", true]]) {
    const term = screen(); const clock = engine(mode);
    try {
      await term.write("> ");
      await train(term, clock, 10);
      assert.ok(clock.echo.statistics.srttMs < 60);
      clock.echo.predict(encoder.encode("d"), term.view(), KEY);
      assert.equal(clock.echo.overlay(term.view(), KEY) !== undefined, shown, mode);
    } finally { clock.echo.dispose(); term.viewport.dispose(); }
  }
  const term = screen(); const clock = engine("auto");
  try {
    await term.write("> ");
    await train(term, clock, 150);
    clock.echo.predict(encoder.encode("d"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "d", "slow echo in auto mode is predicted");
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("off mode never records or paints a guess", async () => {
  const term = screen(); const clock = engine("off");
  try {
    await term.write("> ");
    await train(term, clock);
    assert.equal(clock.echo.predict(encoder.encode("d"), term.view(), KEY), false);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    assert.equal(clock.echo.statistics.predicted, 0);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("a password prompt is never predicted, and an echo-off prompt loses trust", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    await term.write("\r\nPassword: ");
    clock.echo.predict(encoder.encode("s"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    assert.equal(clock.echo.statistics.predicted, 3, "no guess is even recorded on a secret line");
    await term.write("\r\nEnter value: ");
    clock.echo.predict(encoder.encode("s"), term.view(), KEY);
    assert.equal(clock.echo.showing, true);
    // The remote does not echo (stty -echo): the guess expires and trust is gone.
    clock.advance(PREDICTION_CONFIRM_TIMEOUT_MS); t.mock.timers.tick(PREDICTION_CONFIRM_TIMEOUT_MS);
    clock.echo.predict(encoder.encode("t"), term.view(), KEY);
    assert.equal(clock.echo.showing, false);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("Enter, Backspace and escape sequences withdraw guesses and pause predicting until the remote answers", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    clock.echo.predict(encoder.encode("d"), term.view(), KEY);
    assert.equal(clock.echo.predict(Uint8Array.of(0x7f), term.view(), KEY), true, "backspace withdraws the painted guess");
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
    clock.echo.predict(encoder.encode("e"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined, "no guess right after a barrier");
    assert.equal(clock.echo.statistics.mispredicted, 0, "a withdrawn guess does not count against the remote");
    clock.advance(300);
    await term.write("\b \b"); clock.echo.reconcile(term.view(), KEY);
    clock.echo.predict(encoder.encode("f"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "f");
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("a barrier lapses with time even when the remote answered before it ended", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    clock.echo.predict(Uint8Array.of(0x0d), term.view(), KEY);
    clock.advance(100);
    await term.write("\r\n> ");
    clock.echo.reconcile(term.view(), KEY);
    // No further output arrives; the next key comes after the barrier ended.
    clock.advance(300);
    clock.echo.predict(encoder.encode("n"), term.view(), KEY);
    assert.deepEqual({ ...clock.echo.overlay(term.view(), KEY) }, { row: 1, column: 2, text: "n", cursorColumn: 3, cursor: "cursor" });
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("local witness: the real coordinator paints guesses at once; off paints only the real echo", async () => {
  const { runScenario } = await import("../scripts/witness-predictive-echo.mjs");
  const shape = { delay: 200, isolatedKeys: 4, bursts: 1, burstSize: 5 };
  for (const renderer of ["shell", "ink"]) {
    const on = await runScenario({ renderer, mode: "on", ...shape });
    assert.equal(on.isolated.perceived.missing + on.burst.perceived.missing, 0, renderer);
    assert.ok(on.isolated.perceived.p95 < 50, `${renderer} isolated perceived p95 ${on.isolated.perceived.p95}`);
    assert.ok(on.burst.perceived.p95 < 50, `${renderer} burst perceived p95 ${on.burst.perceived.p95}`);
    assert.ok(on.isolated.real.p50 >= 200, "the real echo still takes the remote delay");
    assert.equal(on.staleDimUnderlinedCellsOneSecondAfterLastKey, 0);
  }
  const off = await runScenario({ renderer: "shell", mode: "off", ...shape });
  assert.ok(off.isolated.perceived.p50 >= 200, "without prediction the first glyph is the real echo");
  assert.equal(off.isolated.perceived.p50, off.isolated.real.p50);
  assert.equal(off.staleDimUnderlinedCellsOneSecondAfterLastKey, 0);
});

test("an application-drawn inverse cursor is an insertion point; a guess moves the block", async () => {
  const term = screen(); const clock = engine("on");
  try {
    const paint = async (text) => { await term.write(`\u001b[?25l\u001b[H\u001b[2K> ${text}\u001b[7m \u001b[27m`); };
    await paint("");
    assert.deepEqual({ ...insertionPoint(term.view()) }, { row: 0, column: 2, kind: "inverse" });
    let typed = "";
    for (const key of "abc") {
      clock.echo.predict(encoder.encode(key), term.view(), KEY);
      clock.advance(100); typed += key; await paint(typed);
      clock.echo.reconcile(term.view(), KEY);
    }
    assert.equal(clock.echo.statistics.confirmed, 3);
    clock.echo.predict(encoder.encode("d"), term.view(), KEY);
    assert.deepEqual({ ...clock.echo.overlay(term.view(), KEY) }, { row: 0, column: 5, text: "d", cursorColumn: 6, cursor: "inverse" });
    await term.write("\u001b[1;20H\u001b[7mX\u001b[27m");
    assert.equal(insertionPoint(term.view()), undefined, "two inverse cells are not a cursor");
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("a guess never covers remote content or crosses a changed attachment", async () => {
  const term = screen(); const clock = engine("on");
  try {
    await term.write("> ");
    await train(term, clock);
    await term.write("  border|\u001b[1;6H");
    clock.echo.predict(encoder.encode("abcd"), term.view(), KEY);
    assert.equal(clock.echo.overlay(term.view(), KEY)?.text, "ab", "stops before the first non-blank cell");
    assert.equal(clock.echo.overlay(term.view(), "tab-1:2:1:40x6"), undefined, "another fence sees nothing");
    assert.equal(clock.echo.reconcile(term.view(), "tab-1:2:1:40x6"), true, "and discards the old guesses");
    assert.equal(clock.echo.overlay(term.view(), KEY), undefined);
  } finally { clock.echo.dispose(); term.viewport.dispose(); }
});

test("CUNA_PREDICTIVE_ECHO accepts auto, on and off only", () => {
  assert.equal(predictiveEchoModeFromEnvironment({}), "auto");
  assert.equal(predictiveEchoModeFromEnvironment({ CUNA_PREDICTIVE_ECHO: " ON " }), "on");
  assert.equal(predictiveEchoModeFromEnvironment({ CUNA_PREDICTIVE_ECHO: "off" }), "off");
  assert.throws(() => predictiveEchoModeFromEnvironment({ CUNA_PREDICTIVE_ECHO: "yes" }), /auto, on, or off/u);
});

// ---- Coordinator: what the person's terminal actually shows ----------------

class FakeHost {
  columns = 60; rows = 10; writes = []; input;
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() { return { restore: async () => undefined }; }
  async write(bytes) { this.writes.push(bytes.slice()); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize() { return () => undefined; }
  emitInput(text) { this.input?.(encoder.encode(text)); }
}

async function visibleHostText(host) {
  const terminal = new xterm.Terminal({ cols: host.columns, rows: host.rows, allowProposedApi: true });
  try {
    for (const bytes of host.writes) await new Promise(resolve => terminal.write(bytes, resolve));
    return Array.from({ length: host.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
  } finally { terminal.dispose(); }
}

function coordinatorHarness(accessMode = "writer") {
  const host = new FakeHost();
  let now = 10_000;
  const coordinator = new ForegroundTerminalCoordinator({ host, resizeCoalesceMs: 5, predictiveEcho: "on", clock: () => now });
  const callbacks = coordinator.runtimeCallbacks();
  const intent = { tabId: "tab-a", agentSessionId: "11111111-1111-4111-8111-111111111111", label: "primary", agent: "claude-code" };
  const snapshot = {
    tabId: intent.tabId, viewId: "tab-a:attachment:1", userId: "user-1", machineId: "machine-1",
    workspaceBindingId: null, workspaceBindingGeneration: null, agentSessionId: intent.agentSessionId,
    processEpoch: `epoch-${intent.agentSessionId}`, state: "active", fencingGeneration: 1, inputSequence: 0n,
    outputSequence: 0n, outputContinuity: "complete", resizeCapability: "live", accessMode, writerEpoch: 1,
    writerTransferCapability: { supported: true, reasonCode: null, expiresAt: Date.now() + 60_000 },
    heartbeatObservedAt: 100, heartbeatExpiresAt: 200,
  };
  const sent = [];
  let sequence = 0n;
  coordinator.bindRuntime({
    async attach() { await callbacks.onTerminalReady(snapshot); return snapshot; },
    async detach() {}, async takeWriter() { return snapshot; }, async reconnect() { return snapshot; },
    async sendInput(bytes) {
      // The real boundary refuses an observer's input by name; so does this one.
      if (accessMode !== "writer") throw runtimeFailure("terminal_observer", "This attachment observes the terminal; input is disabled.");
      if (!(bytes.length === 1 && bytes[0] === 0x0c)) sent.push(decoder.decode(bytes));
    },
    async resize() {}, switchActive() { return snapshot; }, async sendTerminalResponse() {}, async sendLocalActionControl() {},
  });
  return {
    coordinator, host, sent, intent,
    advance(ms) { now += ms; },
    async output(text) {
      sequence += 1n;
      await callbacks.onTerminalOutput({
        provenance: "live", tabId: intent.tabId, agentSessionId: intent.agentSessionId,
        binding: { userId: "user-1", machineId: "machine-1", agentSessionId: intent.agentSessionId, processEpoch: snapshot.processEpoch, fencingGeneration: 1 },
        sequence, bytes: encoder.encode(text), signal: new AbortController().signal,
      });
    },
  };
}

async function settle(ms = 20) { await new Promise(resolve => setTimeout(resolve, ms)); }

async function trainCoordinator(h) {
  await h.output("\u001b[H> ");
  for (const key of "abc") {
    h.host.emitInput(key);
    await settle(5);
    h.advance(100);
    await h.output(key);
  }
  await settle();
}

test("rich writer: the guess reaches the host before the network echo, and the key is still sent once", async () => {
  const h = coordinatorHarness();
  try {
    await h.coordinator.start([h.intent]);
    await trainCoordinator(h);
    const before = h.host.writes.length;
    h.host.emitInput("d");
    await settle();
    const painted = h.host.writes.slice(before).map((bytes) => decoder.decode(bytes)).join("");
    assert.ok(painted.includes(`${ESC}[0;2;4md${ESC}[0m`), "predicted glyph painted without any remote output");
    assert.deepEqual(h.sent, ["a", "b", "c", "d"]);
    h.advance(100);
    await h.output("d");
    await settle();
    assert.doesNotMatch(decoder.decode(h.host.writes.at(-1)), /2;4m/u, "confirmed glyph is painted as the remote drew it");
    assert.match(await visibleHostText(h.host), /> abcd/u);
  } finally { await h.coordinator.stop(); }
});

test("rich writer: no guess stays on screen 1 s after a key the remote never echoed", async () => {
  const h = coordinatorHarness();
  try {
    await h.coordinator.start([h.intent]);
    await trainCoordinator(h);
    h.host.emitInput("q");
    await settle();
    assert.match(await visibleHostText(h.host), /> abcq/u, "guess is visible while unconfirmed");
    h.advance(PREDICTION_CONFIRM_TIMEOUT_MS);
    await settle(PREDICTION_CONFIRM_TIMEOUT_MS + 100);
    const visible = await visibleHostText(h.host);
    assert.match(visible, /> abc/u);
    assert.doesNotMatch(visible, /> abcq/u, "the stale guess was repainted away");
  } finally { await h.coordinator.stop(); }
});

test("rich writer: a mismatched echo repaints the true cell", async () => {
  const h = coordinatorHarness();
  try {
    await h.coordinator.start([h.intent]);
    await trainCoordinator(h);
    h.host.emitInput("x");
    await settle();
    await h.output("Y");
    await settle();
    const visible = await visibleHostText(h.host);
    assert.match(visible, /> abcY/u);
    assert.doesNotMatch(decoder.decode(h.host.writes.at(-1)), /2;4m/u);
  } finally { await h.coordinator.stop(); }
});

test("an observer never predicts and never sends", async () => {
  const h = coordinatorHarness("observer");
  try {
    await h.coordinator.start([h.intent]);
    await h.output("\u001b[H> ");
    for (const key of "abcdef") { h.host.emitInput(key); await settle(5); h.advance(100); }
    await settle();
    assert.deepEqual(h.sent, []);
    assert.equal(h.host.writes.some((bytes) => decoder.decode(bytes).includes("2;4m")), false);
  } finally { await h.coordinator.stop(); }
});
