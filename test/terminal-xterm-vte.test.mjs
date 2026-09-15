import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_XTERM_CELL_EXTENDERS,
  MAX_XTERM_PENDING_WRITE_BYTES,
  ViewportRegistry,
  XtermViewportAdapter,
} from "../dist/index.js";

const encoder = new TextEncoder();

for (const [name, prefix] of [
  ["UTF8", Uint8Array.of(0xe4, 0xb8)],
  ["CSI", encoder.encode("\x1b[31;")],
  ["OSC", encoder.encode("\x1b]52;c;unfinished")],
]) test(`fresh current view discards pending ${name} parser state and sequence`, async () => {
  const { viewport, registry } = adapter();
  try {
    await viewport.write(encoder.encode("old\r\nscroll\x1b[?1049h\x1b[?2004h\x1b[?25l"), 90n, 90n);
    await viewport.write(prefix, 91n, 91n);
    registry.open("other", binding, 20, 3); registry.select("other");
    const reset = await viewport.resetForCurrentView({ ...binding, fencingGeneration: 2 }, 30, 4);
    assert.equal(registry.active().tabId, "other");
    assert.equal(reset.outputSequence, 0n); assert.equal(reset.replayCursor, 0n);
    assert.deepEqual(reset.cells, ["", "", "", ""]);
    assert.equal(reset.modes.bracketedPaste, false); assert.equal(reset.modes.cursorVisible, true);
    assert.equal(reset.modes.alternateScreen, false);
    const current = await viewport.write(encoder.encode("NEW"), 1n, 1n);
    assert.equal(current.cells[0], "NEW"); assert.equal(current.outputSequence, 1n);
    assert.equal(current.renderRows[0][0].style.foreground, null);
  } finally { viewport.dispose(); }
});

test("fresh view aborts old response authority immediately and drains queued writes", async () => {
  let release; let entered = false; const replies = [];
  const gate = new Promise(resolve => { release = resolve; });
  const { viewport } = adapter({ onTerminalResponse: async response => {
    replies.push(response); entered = true; await gate;
    if (response.signal.aborted) throw response.signal.reason;
  } });
  try {
    const old = viewport.write(encoder.encode("OLD\x1b[6n"), 20n, 20n);
    const deadline = Date.now() + 1_000;
    while (!entered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(entered, true, "old query callback must start within one second");
    const queued = viewport.write(encoder.encode("QUEUED\x1b[6n"), 21n, 21n);
    const fresh = viewport.resetForCurrentView({ ...binding, fencingGeneration: 2 }, 40, 6);
    assert.equal(replies[0].signal.aborted, true);
    release(); await old; await queued; await fresh;
    assert.equal(viewport.snapshot().cells[0], "");
    await viewport.write(encoder.encode("NEW\x1b[6n"), 1n, 1n);
    assert.equal(replies.at(-1).binding.fencingGeneration, 2);
    assert.equal(replies.at(-1).signal.aborted, false);
  } finally { release(); viewport.dispose(); }
});

test("invalid fresh-view binding or geometry preserves current state", async () => {
  const { viewport } = adapter();
  try {
    await viewport.write(encoder.encode("KEEP"), 8n, 8n);
    const before = viewport.snapshot();
    for (const next of [binding, { ...binding, fencingGeneration: 2, processEpoch: "other" }]) {
      await assert.rejects(viewport.resetForCurrentView(next, 40, 6));
      assert.deepEqual(viewport.snapshot(), before);
    }
    await assert.rejects(viewport.resetForCurrentView({ ...binding, fencingGeneration: 2 }, 0, 6));
    assert.deepEqual(viewport.snapshot(), before);
  } finally { viewport.dispose(); }
});
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

test("observer host projection clips complete styled cells without reflowing the remote VTE", async () => {
  const { viewport } = adapter({ columns: 143, rows: 51 });
  try {
    await viewport.write(encoder.encode("\u001b[31m" + "x".repeat(59) + "中" + "z".repeat(80) + "\r\nsecond"), 1n, 1n);
    const before = viewport.snapshot();
    const projected = viewport.snapshotForHost(60, 22);
    assert.equal(projected.cells[0], "x".repeat(59), "a wide cell straddling the edge is excluded whole");
    assert.equal(projected.displayWidths[0], 59);
    assert.equal(projected.renderRows[0].reduce((n,run)=>n+run.width,0), 59);
    assert.equal(projected.renderRows[0][0].style.foreground.value, 1);
    assert.equal(projected.cells[1], "second");
    assert.equal(projected.columns, 60);
    assert.deepEqual(viewport.snapshot(), before, "projection never changes geometry, cursor, cells or output position");
    assert.equal(viewport.snapshotForHost(144, 52).cells[0], before.cells[0]);
    assert.throws(()=>viewport.snapshotForHost(4097,1));
  } finally { viewport.dispose(); }
});

test("observer host projection keeps the writer's live region visible when the host frame is shorter", async () => {
  const { viewport } = adapter({ columns: 40, rows: 30 });
  const paint = (cursorRow) => {
    let bytes = "";
    for (let row = 1; row <= 30; row += 1) {
      bytes += `\u001b[${row};1H${row === 30 ? "PROMPT" : `ROW-${String(row).padStart(2, "0")}`}`;
    }
    return encoder.encode(`${bytes}\u001b[${cursorRow};7H`);
  };
  try {
    await viewport.write(paint(30), 1n, 1n);
    const clipped = viewport.snapshotForHost(40, 12);
    assert.equal(clipped.cells.length, 12);
    assert.equal(clipped.cells.at(-1), "PROMPT", "the writer's live bottom row stays visible");
    assert.equal(clipped.cells[0], "ROW-19", "the window is anchored on the cursor, not on the first row");
    assert.equal(clipped.cursorY, 11, "the cursor row is mapped through the window offset");
    assert.equal(clipped.cursorX, 6);
    assert.equal(clipped.modes.cursorVisible, true, "a cursor inside the window is never hidden");

    const fitting = viewport.snapshotForHost(40, 30);
    assert.equal(fitting.cells[0], "ROW-01", "a host frame that fits keeps the top of the writer's screen");
    assert.equal(fitting.cursorY, 29);

    const taller = viewport.snapshotForHost(40, 48);
    assert.equal(taller.cells.length, 30, "a taller host frame never invents rows the writer does not own");
    assert.equal(taller.cells[0], "ROW-01");
    assert.equal(taller.cursorY, 29, "the cursor keeps the writer's row inside a taller host frame");

    await viewport.write(paint(20), 2n, 2n);
    const middle = viewport.snapshotForHost(40, 12);
    assert.equal(middle.cells[0], "ROW-09", "the window follows the cursor rather than the screen bottom");
    assert.equal(middle.cells.at(-1), "ROW-20");
    assert.equal(middle.cursorY, 11);
  } finally { viewport.dispose(); }
});

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

test("VTE preserves trusted cell styling without retaining remote ANSI bytes", async () => {
  const { viewport } = adapter();
  const snapshot = await viewport.write(encoder.encode([
    "\u001b[38;5;208morange ",
    "\u001b[1;38;2;10;20;30mbold-rgb",
    "\u001b[0m plain",
  ].join("")), 1n, 1n);

  assert.equal(snapshot.cells[0], "orange bold-rgb plain");
  assert.equal(snapshot.cells[0].includes("\u001b"), false);
  assert.deepEqual(snapshot.renderRows?.map((row) => row.map((run) => ({
    text: run.text,
    width: run.width,
    bold: run.style.bold,
    foreground: run.style.foreground,
  })))[0], [
    { text: "orange ", width: 7, bold: false, foreground: { mode: "palette", value: 208 } },
    { text: "bold-rgb", width: 8, bold: true, foreground: { mode: "rgb", value: 0x0a141e } },
    { text: " plain", width: 6, bold: false, foreground: null },
  ]);
  viewport.dispose();
});

test("TC-055-16 VTE rejects pathological cell extenders across split output frames", async () => {
  const { viewport, registry } = adapter();
  await viewport.write(encoder.encode(`a${"\u0301".repeat(MAX_XTERM_CELL_EXTENDERS - 1)}`), 1n, 1n);
  await assert.rejects(
    viewport.write(encoder.encode("\u0301\u0301"), 2n, 2n),
    /cell complexity limit/u,
  );
  assert.equal(registry.list().length, 0, "a pathological cluster quarantines the viewport");
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
  const resized = await viewport.resize(12, 4);
  assert.equal(resized.columns, 12);
  assert.equal(resized.rows, 4);
  assert.equal(resized.cells.every((line) => [...line].length <= 12), true);
  viewport.dispose();
  assert.equal(registry.list().length, 0);
  await assert.rejects(viewport.write(encoder.encode("late"), 3n, 2n));
});

test("local VTE resize serializes behind output and preserves remote sequence truth", async () => {
  const { viewport } = adapter();
  const written = await viewport.write(encoder.encode("before resize"), 1n, 1n);
  const resized = await viewport.resize(20, 4);
  assert.equal(resized.outputSequence, written.outputSequence);
  assert.equal(resized.replayCursor, written.replayCursor);
  const after = await viewport.write(encoder.encode(" after"), 2n, 2n);
  assert.equal(after.outputSequence, 2n);
  viewport.dispose();
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

test("VTE resize rejects host viewport overflow before mutating dimensions or sequence", async () => {
  const { viewport } = adapter();
  const before = viewport.snapshot();
  await assert.rejects(viewport.resize(1_000, 251), /memory budget/u);
  const after = viewport.snapshot();
  assert.equal(after.columns, before.columns);
  assert.equal(after.rows, before.rows);
  assert.equal(after.outputSequence, before.outputSequence);
  viewport.dispose();
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

test("same-process viewport rebind retains cells and sequence while retiring old query authority", async () => {
  let entered=false; let release; const gate=new Promise(resolve=>{release=resolve});const replies=[];
  const {viewport}=adapter({onTerminalResponse:async response=>{replies.push(response);entered=true;await gate;if(response.signal.aborted)throw response.signal.reason;}});
  try {
    const write=viewport.write(encoder.encode('PREFIX\x1b[6n'),1n,1n);
    void write.catch(()=>{});
    while(!entered)await new Promise(resolve=>setTimeout(resolve,1));
    const rebinding=viewport.rebind({...binding,fencingGeneration:2});
    release(); await write; const rebound=await rebinding;
    assert.equal(replies[0].binding.fencingGeneration,1); assert.equal(replies[0].signal.aborted,true);
    assert.equal(rebound.cells[0],'PREFIX');assert.equal(rebound.outputSequence,1n);assert.equal(rebound.replayCursor,1n);
    const delta=await viewport.write(encoder.encode('-DELTA'),2n,2n);
    assert.equal(delta.cells[0],'PREFIX-DELTA');assert.equal(delta.binding.fencingGeneration,2);
    for(const next of [{...binding,fencingGeneration:2},{...binding,fencingGeneration:1},{...binding,fencingGeneration:3,processEpoch:'other'},{...binding,fencingGeneration:3,userId:'other'}]){
      await assert.rejects(viewport.rebind(next),/binding|fence|process/u);
      assert.equal(viewport.snapshot().cells[0],'PREFIX-DELTA');
    }
  }finally{release();viewport.dispose();}
});

test("a remote output frame is parsed in the current turn, not after a host timer tick", async () => {
  // @xterm/headless defers write() to setTimeout when its buffer is empty, which
  // on a Windows host costs a full ~15 ms timer tick per frame. The adapter arms
  // xterm's own input fast path so the parse runs synchronously. Without it the
  // write settles only after the timer, which fires after setImmediate here.
  const { viewport } = adapter();
  try {
    let settled = false;
    const write = viewport.write(encoder.encode("echo"), 1n, 1n).then((snapshot) => { settled = true; return snapshot; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, "the VTE write must not wait for a macrotask timer");
    const snapshot = await write;
    assert.equal(snapshot.cells[0], "echo");
  } finally { viewport.dispose(); }
});
