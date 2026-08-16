import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppbarModel,
  renderWorkbenchFrame,
  ViewportRegistry,
  WorkbenchRenderError,
} from "../dist/index.js";

const now = Date.parse("2026-08-08T00:00:00.000Z");
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
  assert.match(frame.text, /auth authenticated/);
  assert.match(frame.text, /3;1H.*codex viewport/s);
  assert.doesNotMatch(frame.text, /claude viewport/);
});

test("unknown, stale, and unavailable truth is labeled and never rendered as zero or success", () => {
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
  assert.match(frame.text, /auth unknown/);
  assert.match(frame.text, /sync stale/);
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
  for (const character of appbar.normalize("NFC")) {
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
