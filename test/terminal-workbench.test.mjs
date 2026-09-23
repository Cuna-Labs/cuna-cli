import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { workbenchAppbarTargetAt, workbenchUpdate } from "../dist/terminal/workbench.js";

import {
  buildAppbarModel,
  renderWorkbenchFrame,
  ViewportRegistry,
  WorkbenchRenderError,
} from "../dist/index.js";

const now = Date.parse("2026-08-08T00:00:00.000Z");

test("incremental workbench writes preserve host cells, colors and cursor across edits and clears", async () => {
  const full = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const incremental = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const write = (terminal, bytes) => new Promise(resolve => terminal.write(bytes, resolve));
  const snapshot = terminal => {
    const buffer = terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY, rows: Array.from({ length: 24 }, (_, row) =>
      Array.from({ length: 80 }, (_, column) => {
        const cell = buffer.getLine(row).getCell(column);
        return [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor(), cell.isBold()];
      })) };
  };
  let previous;
  let fullBytes = 0;
  let deltaBytes = 0;
  try {
    for (const [index, text] of ["hello world", "hello", "", "你好", "a", "a"].entries()) {
      const allTabs = tabs();
      const viewport = allTabs[0].viewport;
      allTabs[0] = { ...allTabs[0], viewport: { ...viewport, cells: [text], renderRows: undefined,
        displayWidths: [text === "你好" ? 4 : text.length], cursorX: index, cursorY: index % 2 } };
      const frame = renderWorkbenchFrame({ columns: 80, rows: 24, tabs: allTabs,
        activeTabId: allTabs[0].id, appbar: model(), notice: index === 3 ? "Connected" : undefined });
      const delta = workbenchUpdate(previous, frame);
      await write(full, frame.bytes);
      await write(incremental, delta);
      assert.deepEqual(snapshot(incremental), snapshot(full), `edit ${index}`);
      fullBytes += frame.bytes.length;
      deltaBytes += delta.length;
      assert.equal(workbenchUpdate(frame, frame).length, 0);
      previous = frame;
    }
    assert.ok(deltaBytes < fullBytes / 2, `${deltaBytes} incremental vs ${fullBytes} full bytes`);
    assert.equal(workbenchUpdate(undefined, previous), previous.bytes);
    assert.equal(workbenchUpdate({ ...previous, columns: 79 }, previous), previous.bytes);
    assert.equal(workbenchUpdate({ ...previous, activeTabId: "another" }, previous), previous.bytes);
  } finally { full.dispose(); incremental.dispose(); }
});
const binding = (session, generation = 1) => ({
  userId: "user-1",
  machineId: "machine-1",
  agentSessionId: session,
  processEpoch: `epoch-${session}`,
  fencingGeneration: generation,
});
const evidence = (value, source = "fixture") => [{
  value,
  source,
  observedAt: now - 100,
  expiresAt: now + 10_000,
  correlationId: `${source}-${value}`,
}];

function model(overrides = {}) {
  return buildAppbarModel({
    now,
    machineLifecycle: evidence("running"),
    agentSessionLifecycle: evidence("running"),
    attachment: evidence("online"),
    providerAuthentication: evidence("authenticated"),
    workspaceSync: evidence("converged"),
    ...overrides,
  });
}

function tabs() {
  const registry = new ViewportRegistry();
  registry.open("tab-claude", binding("session-claude"), 80, 20);
  registry.open("tab-codex", binding("session-codex"), 80, 20);
  registry.applyRenderedFrame({
    tabId: "tab-claude",
    binding: binding("session-claude"),
    outputSequence: 1n,
    replayCursor: 1n,
    cells: ["claude viewport"],
    modes: { bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true },
  });
  registry.applyRenderedFrame({
    tabId: "tab-codex",
    binding: binding("session-codex"),
    outputSequence: 1n,
    replayCursor: 1n,
    cells: ["codex viewport"],
    modes: { bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true },
  });
  return [
    { id: "tab-claude", label: "primary", agent: "claude-code", viewport: registry.require("tab-claude") },
    { id: "tab-codex", label: "review", agent: "codex", viewport: registry.require("tab-codex") },
  ];
}

test("rich workbench keeps a persistent orange Cuna appbar above the selected isolated viewport", () => {
  const frame = renderWorkbenchFrame({
    columns: 80,
    rows: 24,
    activeTabId: "tab-codex",
    tabs: tabs(),
    appbar: model(),
  });
  assert.equal(frame.appbarRows, 2);
  assert.equal(frame.viewportRows, 22);
  assert.match(frame.text, /48;2;235;86;37m/);
  assert.match(frame.text, /CUNA.*Claude primary.*\[2:Codex review\]/s);
  assert.doesNotMatch(frame.text, /\bRUNA\b/u);
  assert.match(frame.text, /Codex auth authenti/);
  assert.match(frame.text, /3;1H.*codex viewport/s);
  assert.doesNotMatch(frame.text, /claude viewport/);
});

test("foreground appbar omits auxiliary stale truth and never renders unknown metrics as success", () => {
  const frame = renderWorkbenchFrame({
    columns: 140,
    rows: 8,
    activeTabId: "tab-claude",
    tabs: tabs(),
    appbar: model({
      providerAuthentication: [],
      workspaceSync: [{
        value: "converged",
        source: "sync",
        observedAt: now - 20_000,
        expiresAt: now - 10_000,
        correlationId: "stale-sync",
      }],
      tokensSaved: [],
    }),
  });
  assert.match(frame.text, /Claude auth unknown/);
  assert.doesNotMatch(frame.text, /machine |session |sync /u);
  assert.match(frame.text, /tokens saved unknown/);
  assert.doesNotMatch(frame.text, /tokens saved 0|signed in|100%/i);
});

test("tab labels and viewport cells cannot inject host terminal controls", () => {
  const unsafeTabs = tabs();
  unsafeTabs[0] = { ...unsafeTabs[0], label: "bad\u001b[2J\nname" };
  const frame = renderWorkbenchFrame({
    columns: 80,
    rows: 6,
    activeTabId: "tab-claude",
    tabs: unsafeTabs,
    appbar: model(),
  });
  assert.equal(frame.text.includes("bad\u001b[2J"), false);
  assert.match(frame.text, /bad\[2Jname/);

  const registry = new ViewportRegistry();
  registry.open("bad", binding("bad"), 80, 5);
  const raw = registry.require("bad");
  assert.throws(() => renderWorkbenchFrame({
    columns: 80,
    rows: 6,
    activeTabId: "bad",
    tabs: [{ ...unsafeTabs[0], id: "bad", viewport: { ...raw, cells: ["remote\u001b[H"] } }],
    appbar: model(),
  }), WorkbenchRenderError);
});

test("trusted appbar removes bidi controls and truncates by terminal cell width", () => {
  const unsafeTabs = tabs();
  unsafeTabs[0] = { ...unsafeTabs[0], label: "safe\u202Eevil 界界 🚀 e\u0301" };
  const frame = renderWorkbenchFrame({
    columns: 20,
    rows: 3,
    activeTabId: "tab-claude",
    tabs: unsafeTabs,
    appbar: model(),
    color: false,
  });
  assert.equal(frame.text.includes("\u202E"), false);
  const appbar = frame.text.slice(frame.text.indexOf("\u001b[1;1H") + 6, frame.text.indexOf("\u001b[2;1H"));
  let width = 0;
  assert.ok(appbar.startsWith("\u001b[0m\u001b[2K"), "erase stale header cells before repainting");
  // eslint-disable-next-line no-control-regex -- the escape introducer is the subject under test
  for (const character of appbar.replace(/\u001b\[[0-9;]*[mK]/gu, "").normalize("NFC")) {
    const point = character.codePointAt(0);
    width += /[\p{M}\p{Cf}]/u.test(character) ? 0
      : /\p{Extended_Pictographic}/u.test(character) || (point >= 0x1100 && point <= 0x3fffd) ? 2
      : 1;
  }
  assert.equal(width, 20);
});

test("small admitted terminals collapse to one truthful appbar row without fabricated progress", () => {
  const frame = renderWorkbenchFrame({
    columns: 30,
    rows: 3,
    activeTabId: "tab-claude",
    tabs: tabs(),
    appbar: model(),
    color: false,
  });
  assert.equal(frame.appbarRows, 1);
  assert.equal(frame.viewportRows, 2);
  assert.doesNotMatch(frame.text, /48;2;/);
  assert.match(frame.text, /CUNA  Claude primary/);
  assert.doesNotMatch(frame.text, /\bRUNA\b/u);
});

test("compact notices keep the Cuna brand while sanitizing untrusted text", () => {
  const frame = renderWorkbenchFrame({
    columns: 40,
    rows: 2,
    activeTabId: "tab-claude",
    tabs: tabs(),
    appbar: model(),
    notice: "Preparing\u001b[2J workspace",
    color: false,
  });
  assert.match(frame.text, /CUNA  Preparing\[2J workspace/u);
  assert.doesNotMatch(frame.text, /\bRUNA\b/u);
  assert.equal(frame.text.includes("\u001b[2J workspace"), false);
});

test("workbench restores the selected remote cursor below the appbar without forcing visibility", () => {
  const selected = tabs();
  selected[0] = {
    ...selected[0],
    viewport: {
      ...selected[0].viewport,
      cursorX: 4,
      cursorY: 2,
      modes: { ...selected[0].viewport.modes, cursorVisible: false },
    },
  };
  const frame = renderWorkbenchFrame({
    columns: 80,
    rows: 8,
    activeTabId: "tab-claude",
    tabs: selected,
    appbar: model(),
    color: false,
  });
  assert.equal(frame.text.endsWith("\u001b[5;5H\u001b[?25l"), true);
  assert.equal(frame.text.endsWith("\u001b[?25h"), false);
});

const rosterSessions = [
  { agentSessionId: "session-claude", number: 1, agent: "claude-code", label: "projA", ended: false },
  { agentSessionId: "session-b", number: 2, agent: "claude-code", label: "projB", ended: false },
  { agentSessionId: "session-c", number: 3, agent: "claude-code", label: "old", ended: true },
];

function rowText(frame, row) {
  const start = frame.text.indexOf(`\u001b[${row};1H`);
  const end = frame.text.indexOf(`\u001b[${row + 1};1H`);
  // eslint-disable-next-line no-control-regex -- stripping the renderer's own SGR/erase sequences
  return frame.text.slice(start, end).replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "").replace(/^\d+;1H/u, "");
}

test("the Machine's sessions are the first-row tabs, on the right, the attached one bracketed", () => {
  const frame = renderWorkbenchFrame({
    columns: 100, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions, activeSessionId: "session-claude",
  });
  const top = rowText(frame, 1);
  assert.equal(top.length, 100);
  assert.match(top, /^ CUNA\s+\[1:Claude projA\] {3}2:Claude projB {4}3:Claude old ended  $/u);
  assert.doesNotMatch(top, /review|primary/u, "the attached-tab labels give way to the roster");
  const second = frame.appbarTargets.find((target) => target.target === "session:session-b");
  assert.ok(second);
  assert.equal(top.slice(second.firstColumn - 1, second.lastColumn), " 2:Claude projB ");
  assert.equal(workbenchAppbarTargetAt(frame, second.firstColumn, 1), "session:session-b");
  assert.equal(workbenchAppbarTargetAt(frame, second.lastColumn, 1), "session:session-b");
  assert.equal(workbenchAppbarTargetAt(frame, second.firstColumn, 2), undefined, "only the tab row is clickable");
  assert.equal(workbenchAppbarTargetAt(frame, 2, 1), undefined, "the CUNA brand is not a tab");
});

test("a roster that does not name the attached session is not shown", () => {
  const frame = renderWorkbenchFrame({
    columns: 100, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions.slice(1), activeSessionId: "session-claude",
  });
  assert.match(rowText(frame, 1), /\[1:Claude primary\]/u);
  assert.deepEqual(frame.appbarTargets.map((target) => target.target), ["tab:tab-claude", "tab:tab-codex"]);
});

test("tabs that do not fit give way to a count, never the attached one", () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    agentSessionId: `s${index + 1}`, number: index + 1, agent: "claude-code", label: `project-${index + 1}`, ended: false,
  }));
  const frame = renderWorkbenchFrame({
    columns: 60, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: many, activeSessionId: "s8",
  });
  const top = rowText(frame, 1);
  assert.equal(top.length, 60);
  assert.match(top, /\[8:Claude project-8\]/u);
  assert.match(top, /\+\d+ $/u);
  const shown = frame.appbarTargets.length;
  assert.equal(Number(top.match(/\+(\d+) $/u)[1]), 9 - shown);
});

test("the copy/paste hint moves to the second row and says Shift+drag while the mouse is reported", () => {
  const frame = renderWorkbenchFrame({
    columns: 140, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions, activeSessionId: "session-claude", mouseReporting: true,
  });
  const second = rowText(frame, 2);
  if (process.platform === "win32") {
    assert.match(second, /Claude auth authenticated.*Shift\+drag select \| Ctrl\+Shift\+C copy \| Ctrl\+Shift\+V paste $/u);
  } else {
    assert.doesNotMatch(second, /Ctrl\+Shift\+C/u);
  }
  assert.doesNotMatch(rowText(frame, 1), /Ctrl\+Shift/u);
});

test("workbench safely re-emits VTE-parsed palette and RGB styles", () => {
  const registry = new ViewportRegistry();
  registry.open("styled", binding("styled"), 80, 4);
  const baseStyle = {
    bold: false, dim: false, italic: false, underline: false, blink: false,
    inverse: false, invisible: false, strikethrough: false, overline: false,
    foreground: null, background: null,
  };
  registry.applyRenderedFrame({
    tabId: "styled",
    binding: binding("styled"),
    outputSequence: 1n,
    replayCursor: 1n,
    cells: ["orange rgb"],
    displayWidths: [10],
    renderRows: [[
      { text: "orange", width: 6, style: { ...baseStyle, foreground: { mode: "palette", value: 208 } } },
      { text: " rgb", width: 4, style: { ...baseStyle, bold: true, foreground: { mode: "rgb", value: 0x0a141e } } },
    ]],
    modes: { bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true },
  });
  const tab = { id: "styled", label: "styled", agent: "claude-code", viewport: registry.require("styled") };

  const colored = renderWorkbenchFrame({ columns: 80, rows: 6, activeTabId: "styled", tabs: [tab], appbar: model() });
  assert.equal(colored.text.includes("\u001b[0;38;5;208morange"), true);
  assert.equal(colored.text.includes("\u001b[0;1;38;2;10;20;30m rgb"), true);

  const plain = renderWorkbenchFrame({ columns: 80, rows: 6, activeTabId: "styled", tabs: [tab], appbar: model(), color: false });
  assert.match(plain.text, /orange rgb/u);
  assert.doesNotMatch(plain.text, /38;5;208|38;2;10;20;30/u);
});
