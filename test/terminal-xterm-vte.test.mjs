import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_XTERM_PENDING_WRITE_BYTES,
  ViewportRegistry,
  XtermViewportAdapter,
} from "../dist/index.js";

const encoder = new TextEncoder();
const binding = {
  userId: "user-1",
  machineId: "machine-1",
  agentSessionId: "agent-session-1",
  processEpoch: "process-epoch-1",
  fencingGeneration: 1,
};

function adapter(overrides = {}) {
  const registry = new ViewportRegistry();
  return {
    registry,
    viewport: new XtermViewportAdapter({
      tabId: "tab-1",
      binding,
      columns: 40,
      rows: 6,
      registry,
      ...overrides,
    }),
  };
}

test("headless VTE preserves split UTF-8 and resolves remote control sequences into safe cells", async () => {
  const { viewport } = adapter();
  const payload = encoder.encode("hello \u{1F30E}\r\nsecond");
  await viewport.write(payload.slice(0, 8), 1n, 1n);
  const snapshot = await viewport.write(payload.slice(8), 2n, 2n);
  assert.equal(snapshot.cells[0], "hello \u{1F30E}");
  assert.equal(snapshot.cells[1], "second");
  assert.equal(snapshot.cells.some((line) => line.includes("\u001b")), false);
  viewport.dispose();
});

test("VTE reports Unicode display-cell width and the remote cursor state", async () => {
  const { viewport } = adapter();
  const snapshot = await viewport.write(
    encoder.encode("\u4e2de\u0301\u{1F642}\u001b[?25l"),
    1n,
    1n,
  );
  assert.equal(snapshot.cells[0], "\u4e2de\u0301\u{1F642}");
  assert.equal(snapshot.displayWidths[0], 4);
  assert.equal(snapshot.cursorX, 4);
  assert.equal(snapshot.cursorY, 0);
  assert.equal(snapshot.modes.cursorVisible, false);
  const visible = await viewport.write(encoder.encode("\u001b[?25h"), 2n, 2n);
  assert.equal(visible.modes.cursorVisible, true);
  viewport.dispose();
});

test("remote OSC title, hyperlink, and clipboard controls stay outside trusted host cells", async () => {
  const responses = [];
  const { viewport } = adapter({ onTerminalResponse: (bytes) => responses.push(bytes) });
  const payload = [
    "\u001b]0;forged-runa-title\u0007",
    "\u001b]8;;https://attacker.invalid\u0007visible\u001b]8;;\u0007",
    "\u001b]52;c;Zm9yZ2VkLWNsaXBib2FyZA==\u0007",
    "\u001b]52;c;?\u001b\\",
  ].join("");
  const snapshot = await viewport.write(encoder.encode(payload), 1n, 1n);
  assert.equal(snapshot.cells[0], "visible");
  assert.equal(snapshot.cells.some((line) => /forged-runa-title|attacker\.invalid|forged-clipboard/u.test(line)), false);
  assert.equal(responses.length, 0);
  viewport.dispose();
});

test("high-cardinality OSC hyperlinks are consumed instead of becoming retained viewport metadata", async () => {
  const { viewport } = adapter({ scrollback: 10_000 });
  const links = Array.from({ length: 1_000 }, (_, index) => (
    `\u001b]8;;https://attacker.invalid/${index}/${"x".repeat(256)}\u0007x\u001b]8;;\u0007`
  )).join("");
  const snapshot = await viewport.write(encoder.encode(links), 1n, 1n);
  assert.equal(snapshot.cells.some((line) => line.includes("attacker.invalid")), false);
  assert.equal(snapshot.cells.join("").replaceAll(" ", "").length <= 240, true);
  viewport.dispose();
});

test("split ST-terminated OSC controls remain contained across output frames", async () => {
  const responses = [];
  const { viewport } = adapter({ onTerminalResponse: (event) => responses.push(event) });
  await viewport.write(encoder.encode("\u001b]0;forged"), 1n, 1n);
  const snapshot = await viewport.write(encoder.encode("-title\u001b\\safe"), 2n, 2n);
  assert.equal(snapshot.cells[0], "safe");
  assert.equal(snapshot.cells.some((line) => line.includes("forged-title")), false);
  assert.equal(responses.length, 0);
  viewport.dispose();
});

test("alternate screen and bracketed paste remain tab-local VTE modes", async () => {
  const { viewport } = adapter();
  let snapshot = await viewport.write(encoder.encode("normal"), 1n, 1n);
  assert.equal(snapshot.modes.alternateScreen, false);
  snapshot = await viewport.write(encoder.encode("\u001b[?1049h\u001b[H\u001b[?2004halt"), 2n, 2n);
  assert.equal(snapshot.modes.alternateScreen, true);
  assert.equal(snapshot.modes.bracketedPaste, true);
  assert.equal(snapshot.cells[0], "alt");
  snapshot = await viewport.write(encoder.encode("\u001b[?2004l\u001b[?1049l"), 3n, 3n);
  assert.equal(snapshot.modes.alternateScreen, false);
  assert.equal(snapshot.modes.bracketedPaste, false);
  assert.equal(snapshot.cells[0], "normal");
  viewport.dispose();
});

test("VTE resize updates the isolated viewport and rejects use after disposal", async () => {
  const { viewport, registry } = adapter();
  await viewport.write(encoder.encode("a line wider than twelve"), 1n, 1n);
  const resized = viewport.resize(12, 4);
  assert.equal(resized.columns, 12);
  assert.equal(resized.rows, 4);
  assert.equal(resized.cells.every((line) => [...line].length <= 12), true);
  viewport.dispose();
  assert.equal(registry.list().length, 0);
  await assert.rejects(viewport.write(encoder.encode("late"), 3n, 2n));
});

test("VTE rejects unbounded scrollback before allocating a viewport", () => {
  const registry = new ViewportRegistry();
  assert.throws(() => new XtermViewportAdapter({
    tabId: "tab-1",
    binding,
    columns: 40,
    rows: 6,
    registry,
    scrollback: 10_001,
  }), RangeError);
  assert.equal(registry.list().length, 0);
});

test("VTE enforces one combined viewport and scrollback cell budget", () => {
  const registry = new ViewportRegistry();
  assert.throws(() => new XtermViewportAdapter({
    tabId: "tab-1",
    binding,
    columns: 100,
    rows: 1,
    registry,
    scrollback: 10_000,
  }), /memory budget/u);
  assert.equal(registry.list().length, 0);
});

test("shared workbench budget caps aggregate rich terminal allocation", () => {
  const registry = new ViewportRegistry();
  const make = (tabId, scrollback) => new XtermViewportAdapter({
    tabId,
    binding: { ...binding, agentSessionId: `session-${tabId}` },
    columns: 1_000,
    rows: 1,
    registry,
    scrollback,
  });
  const first = make("tab-1", 899);
  const second = make("tab-2", 899);
  assert.throws(() => make("tab-3", 299), /global budget/u);
  assert.equal(registry.list().length, 2);
  first.dispose();
  const third = make("tab-3", 299);
  second.dispose();
  third.dispose();
});

test("shared workbench budget limits the number of active rich viewports", () => {
  const registry = new ViewportRegistry();
  const viewports = Array.from({ length: 4 }, (_, index) => new XtermViewportAdapter({
    tabId: `tab-${index}`,
    binding: { ...binding, agentSessionId: `session-${index}` },
    columns: 20,
    rows: 2,
    registry,
    scrollback: 0,
  }));
  assert.throws(() => new XtermViewportAdapter({
    tabId: "tab-overflow",
    binding: { ...binding, agentSessionId: "session-overflow" },
    columns: 20,
    rows: 2,
    registry,
    scrollback: 0,
  }), /At most 4/u);
  for (const viewport of viewports) viewport.dispose();
});

test("concurrent writes cannot queue beyond the bounded terminal frame window", async () => {
  const { viewport } = adapter();
  const frame = new Uint8Array(MAX_XTERM_PENDING_WRITE_BYTES / 2);
  const first = viewport.write(frame, 1n, 1n);
  const second = viewport.write(frame, 2n, 2n);
  await assert.rejects(viewport.write(Uint8Array.of(1), 3n, 3n), /Pending terminal output/u);
  await first;
  await second;
  viewport.dispose();
});

test("terminal response floods fault the isolated viewport before forwarding bytes", async () => {
  const responses = [];
  const { viewport, registry } = adapter({ onTerminalResponse: (event) => responses.push(event) });
  await assert.rejects(
    viewport.write(encoder.encode("\u001b[6n".repeat(65)), 1n, 1n),
    /protocol-response budget/u,
  );
  assert.equal(responses.length, 0);
  assert.equal(registry.list().length, 0);
});

test("a stalled terminal response transport is timed out and cancelled", async () => {
  let response;
  const { viewport, registry } = adapter({
    responseDeliveryTimeoutMs: 5,
    onTerminalResponse: (event) => {
      response = event;
      return new Promise(() => undefined);
    },
  });
  await assert.rejects(viewport.write(encoder.encode("\u001b[6n"), 1n, 1n), /delivery timed out/u);
  assert.equal(response.signal.aborted, true);
  assert.equal(registry.list().length, 0);
});

test("terminal query responses are returned to the owning remote session only", async () => {
  const responses = [];
  const { viewport } = adapter({ onTerminalResponse: (event) => responses.push(event) });
  await viewport.write(encoder.encode("\u001b[6n"), 1n, 1n);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].tabId, "tab-1");
  assert.deepEqual(responses[0].binding, binding);
  assert.equal(Object.isFrozen(responses[0]), true);
  assert.equal(Object.isFrozen(responses[0].binding), true);
  const response = new TextDecoder().decode(responses[0].bytes);
  assert.equal(response.charCodeAt(0), 0x1b);
  assert.match(response.slice(1), /^\[\d+;\d+R$/u);
  viewport.dispose();
});
