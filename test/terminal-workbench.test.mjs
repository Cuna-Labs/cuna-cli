import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import xterm from "@xterm/headless";
import { workbenchAppbarTargetAt, workbenchUpdate, withNamedSecretOverlay, workbenchNamedSecretTargetAt } from "../dist/terminal/workbench.js";

import {
  buildAppbarModel,
  renderWorkbenchFrame,
  ViewportRegistry,
  WorkbenchRenderError,
} from "../dist/index.js";

const now = Date.parse("2026-08-08T00:00:00.000Z");

test("revealing Unicode control characters cannot execute commands or erase the frame", async () => {
  const allTabs = tabs();
  const base = renderWorkbenchFrame({columns:120,rows:32,tabs:allTabs,activeTabId:allTabs[0].id,appbar:model()});
  const frame = withNamedSecretOverlay(base,{name:"Demo",masked:"********",focus:"secret",feedback:"Esc cancels",revealed:true,
    revealedValue:"FAKE\u009b2J\u202eAFTER\u2028"});
  assert.equal(frame.text.includes("\u009b"),false);
  assert.equal(frame.text.includes("\u202e"),false);
  assert.equal(frame.text.includes("\u2028"),false);
  assert.ok(frame.text.includes("\\u009b2J\\u202eAFTER\\u2028"));
  const terminal = new xterm.Terminal({cols:120,rows:32,allowProposedApi:true});
  try {
    await new Promise(resolve=>terminal.write(frame.bytes,resolve));
    assert.match(terminal.buffer.active.getLine(0).translateToString(true),/CUNA/u);
  } finally { terminal.dispose(); }
});

test("named-secret visible count and reveal cells stay in their declared targets across Unicode widths", async (t) => {
  const failures = [];
  const totals = { ascii: 0, cjk: 0, emoji: 0 };
  for (const [columns, rows] of [[30, 8], [80, 24], [120, 32]]) {
    const allTabs = tabs();
    const base = renderWorkbenchFrame({ columns, rows, tabs: allTabs, activeTabId: allTabs[0].id, appbar: model() });
    for (const [variant, value] of [["ascii", "aZ"], ["cjk", "a界"], ["emoji", "a🔒"]]) {
      const hiddenView = { name: "Demo", masked: "**", focus: "secret", feedback: "Enter saves · Esc cancels", revealed: false };
      const hidden = withNamedSecretOverlay(base, hiddenView);
      for (const mode of ["fresh", "incremental"]) for (const revealed of [false, true]) {
        const frame = revealed ? withNamedSecretOverlay(base, { ...hiddenView, revealed: true, revealedValue: value }) : hidden;
        const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
        try {
          if (mode === "incremental") await new Promise(resolve => terminal.write(hidden.bytes, resolve));
          await new Promise(resolve => terminal.write(mode === "incremental" ? workbenchUpdate(hidden, frame) : frame.bytes, resolve));
          const target = frame.secretTargets.find(item => item.target === "reveal");
          assert.ok(target);
          const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + target.row - 1);
          const observed = [];
          for (let column = 0; column < columns; column++) if (line?.getCell(column)?.getChars() === "◉") observed.push(column + 1);
          const countStart = target.firstColumn - 8;
          const countCells = Array.from({ length: 7 }, (_, offset) => line?.getCell(countStart - 1 + offset)?.getChars() ?? "").join("");
          const valid = observed.length === 1 && observed[0] === target.firstColumn &&
            workbenchNamedSecretTargetAt(frame, observed[0], target.row) === "reveal" && countCells === "    (2)";
          totals[variant]++;
          if (!valid) failures.push({ variant, columns, rows, mode, revealed, icon_columns: observed, target_column: target.firstColumn, count_aligned: countCells === "    (2)" });
        } finally { terminal.dispose(); }
      }
    }
  }
  t.diagnostic(JSON.stringify({ checks: totals, mismatches: failures }));
  assert.equal(failures.length, 0, "actual terminal control cells must coincide with the declared click geometry");
});

test("secret popup paints orange and binds clipped field/reveal cells to the actual frame", () => {
  const allTabs = tabs();
  for (const [columns, rows] of [[30,8],[80,24],[120,32]]) {
    const base = renderWorkbenchFrame({ columns, rows, tabs: allTabs, activeTabId: allTabs[0].id, appbar:model() });
    const view={name:"Database",masked:"***",focus:"secret",feedback:"Enter saves · Esc cancels",revealed:false};
    const hidden=withNamedSecretOverlay(base,view);
    assert.match(hidden.text,/48;2;235;86;37/u);
    const targets=hidden.secretTargets;
    assert.equal(targets.length,3);
    for(const target of targets) {
      assert.ok(target.row>=1&&target.row<=rows&&target.firstColumn>=1&&target.lastColumn<=columns);
      assert.equal(workbenchNamedSecretTargetAt(hidden,target.firstColumn,target.row),target.target);
      assert.equal(workbenchNamedSecretTargetAt(hidden,target.lastColumn,target.row),target.target);
    }
    assert.equal(workbenchNamedSecretTargetAt(hidden,0,targets[0].row),undefined);
    assert.match(hidden.text,/◉ show/u);
    const shown=withNamedSecretOverlay(base,{...view,revealed:true,revealedValue:"a\n😀"});
    assert.match(shown.text,columns === 30 ? /a\\…/u : /a\\n😀/u); assert.match(shown.text,/◉ hide/u);
    assert.doesNotMatch(withNamedSecretOverlay(base,{...view,revealedValue:"UNREVEALED_CANARY"}).text,/UNREVEALED_CANARY/u);
    assert.deepEqual(withNamedSecretOverlay(base,{...view,resizeRequired:true}).secretTargets,[]);
    assert.equal(withNamedSecretOverlay(base,{...view}).appbarTargets.length,0);
  }
});

test("a password scalar always changes visible progress after the mask fills, without moving reveal targets", async () => {
  const { NamedSecretOverlay } = await import("../dist/named-secrets/overlay.js");
  const context={agent_session_id:"11111111-1111-4111-8111-111111111111",machine_id:"22222222-2222-4222-8222-222222222222",workspace_binding_id:"33333333-3333-4333-8333-333333333333",process_epoch:"44444444-4444-4444-8444-444444444444",terminal_connection_id:"55555555-5555-4555-8555-555555555555",connect_token:"runa_tc_"+"A".repeat(43),writer_epoch:1};
  let serviceCalls=0;
  const unexpected=async()=>{serviceCalls++;throw new Error("editing must not contact the service");};
  for (const [columns,rows,length] of [[30,8,20],[80,24,60],[120,32,60],[30,8,4095]]) {
    const allTabs=tabs();
    const base=renderWorkbenchFrame({columns,rows,tabs:allTabs,activeTabId:allTabs[0].id,appbar:model()});
    const overlay=new NamedSecretOverlay({prepare:unexpected,create:unexpected,read:unexpected},()=>({context,userId:"66666666-6666-4666-8666-666666666666"}),()=>{});
    const terminal=new xterm.Terminal({cols:columns,rows,allowProposedApi:true});
    const input=value=>overlay.input(new TextEncoder().encode(value));
    const paint=async()=>{const frame=withNamedSecretOverlay(base,overlay.view);await new Promise(resolve=>terminal.write(frame.bytes,resolve));return {frame,lines:Array.from({length:rows},(_,row)=>terminal.buffer.active.getLine(row)?.translateToString(true)??"").join("\n")};};
    try {
      overlay.open();input("Demo\tX");const one=await paint();input("X");const two=await paint();
      assert.notEqual(one.lines,two.lines,"short-value input must visibly progress");
      input("X".repeat(length-2));const before=await paint();input("X");const after=await paint();
      assert.notEqual(before.lines,after.lines,"an additional scalar must change the actual screen after clipping");
      assert.match(after.lines,new RegExp(`\\(${length+1}\\)\\s+◉ show`,"u"));
      assert.match(after.lines,/Secret Name: Demo/u);
      assert.match(after.lines,/Up\/Down or Tab changes field/u);
      assert.match(after.lines,/Enter saves · Esc cancels/u);
      assert.deepEqual(before.frame.secretTargets,after.frame.secretTargets);
      const reveal=after.frame.secretTargets.find(target=>target.target==="reveal");
      assert.equal(reveal.lastColumn-reveal.firstColumn+1,6);
      assert.equal(workbenchNamedSecretTargetAt(after.frame,reveal.firstColumn,reveal.row),"reveal");
      assert.equal(workbenchNamedSecretTargetAt(after.frame,reveal.lastColumn,reveal.row),"reveal");
      input("\x7f");const back=await paint();assert.match(back.lines,new RegExp(`\\(${length}\\)\\s+◉ show`,"u"));
      overlay.close();overlay.open();input("Demo\t\x1b[200~a\n😀\x1b[201~");overlay.toggleReveal();
      const shown=await paint();assert.match(shown.lines,/\(3\)\s+◉ hide/u);
      assert.equal(overlay.view.revealedValue,"a\n😀");
      assert.ok(shown.frame.text.includes(columns===30?"a\\…":"a\\n"),"revealed escape text is safely clipped with the value");
      assert.equal(shown.frame.text.includes("a\n"),false,"the literal newline never reaches the frame");
      if(columns>30)assert.ok(shown.lines.includes("😀"));
      input("\x7f");const unicodeBack=await paint();assert.match(unicodeBack.lines,/\(2\)\s+◉ hide/u);
      overlay.close();overlay.open();const cleared=await paint();
      assert.doesNotMatch(cleared.lines,/\(\d+\)\s+◉ show/u,"cleared material must not look like a saved zero-length value");
      assert.deepEqual(withNamedSecretOverlay(base,{...overlay.view,resizeRequired:true}).secretTargets,[]);
    } finally { overlay.dispose();terminal.dispose(); }
  }
  assert.equal(serviceCalls,0);
});

test("real overlay transitions clear the UI count during submission, outcomes and expiry", async () => {
  const {NamedSecretOverlay}=await import("../dist/named-secrets/overlay.js");
  const context={agent_session_id:"11111111-1111-4111-8111-111111111111",machine_id:"22222222-2222-4222-8222-222222222222",workspace_binding_id:"33333333-3333-4333-8333-333333333333",process_epoch:"44444444-4444-4444-8444-444444444444",terminal_connection_id:"55555555-5555-4555-8555-555555555555",connect_token:"runa_tc_"+"A".repeat(43),writer_epoch:1};
  const allTabs=tabs(),base=renderWorkbenchFrame({columns:80,rows:24,tabs:allTabs,activeTabId:allTabs[0].id,appbar:model()});
  const until=async predicate=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail("overlay transition did not settle");};
  for(const outcome of ["COMMITTED","REJECTED","UNKNOWN","expired"]){
    let release,committed;
    const service={prepare:async()=>"66666666-6666-4666-8666-666666666666",create:async(op,name)=>{
      committed={operation_id:op,state:"committed",secret_id:"77777777-7777-4777-8777-777777777777",name,workspace_id:"66666666-6666-4666-8666-666666666666",committed_at:"2026-10-15T00:00:00Z"};
      if(outcome==="COMMITTED")await new Promise(resolve=>{release=resolve;});
      if(outcome==="UNKNOWN")throw new Error("synthetic unknown");
      return outcome==="REJECTED"?{operation_id:op,state:"rejected",secret_id:null,name:null,workspace_id:null,committed_at:null}:committed;
    },read:async()=>{if(outcome==="UNKNOWN")throw new Error("synthetic unavailable");return committed;}};
    const overlay=new NamedSecretOverlay(service,()=>({context,userId:"66666666-6666-4666-8666-666666666666"}),()=>{},outcome==="expired"?{plaintextLifetimeMs:5}:{});
    const cleared=()=>{assert.equal(overlay.view.masked,"");assert.doesNotMatch(stripVTControlCharacters(withNamedSecretOverlay(base,overlay.view).text),/\(\d+\)\s+◉ show/u);};
    try{
      overlay.open();overlay.input(new TextEncoder().encode("Demo\tXYZ"));
      assert.match(stripVTControlCharacters(withNamedSecretOverlay(base,overlay.view).text),/\(3\)\s+◉ show/u);
      if(outcome==="expired"){await until(()=>overlay.view.feedback.includes("expired"));cleared();continue;}
      overlay.input(Uint8Array.of(13));
      if(outcome==="COMMITTED"){await until(()=>typeof release==="function");assert.equal(overlay.state,"SUBMITTING");cleared();release();}
      await until(()=>overlay.persistence===outcome&&overlay.state!=="SUBMITTING"&&overlay.state!=="RECONCILING");cleared();
    }finally{release?.();overlay.dispose();}
  }
});

test("resize refusal has no field targets or count even at defensive sub-minimum renderer widths", async () => {
  const {NamedSecretOverlay}=await import("../dist/named-secrets/overlay.js");
  let canEdit=true;
  const context={agent_session_id:"session",machine_id:"machine",workspace_binding_id:"binding",process_epoch:"epoch",terminal_connection_id:"connection",writer_epoch:1};
  const unexpected=async()=>{throw new Error("resize must not dispatch");};
  const overlay=new NamedSecretOverlay({prepare:unexpected,create:unexpected,read:unexpected},()=>({context,userId:"user"}),()=>{},{canEdit:()=>canEdit});
  try{
    overlay.open();overlay.input(new TextEncoder().encode("Demo\tXYZ"));canEdit=false;overlay.geometryChanged(false);
    assert.equal(overlay.view.resizeRequired,true);assert.equal(overlay.view.masked,"");
    const allTabs=tabs(),base=renderWorkbenchFrame({columns:20,rows:3,tabs:allTabs,activeTabId:allTabs[0].id,appbar:model()});
    for(const [columns,rows] of [[20,3],[30,7],[1,1],[8,3],[13,7]]){
      // Below 20 columns is outside foreground admission; this separately
      // checks the exported renderer's defensive resize-only projection.
      const frame=withNamedSecretOverlay({...base,columns,rows},overlay.view);
      assert.deepEqual(frame.secretTargets,[]);assert.doesNotMatch(frame.text,/\(\d+\)\s+◉ show/u);
    }
  }finally{overlay.dispose();}
});

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
      // General Punctuation (the cut marker "…" among it) is one cell wide.
      : /\p{Extended_Pictographic}/u.test(character) || (point >= 0x1100 && point <= 0x3fffd && !(point >= 0x2000 && point <= 0x206f)) ? 2
      : 1;
  }
  assert.equal(width, 20);
  // eslint-disable-next-line no-control-regex -- stripping the renderer's own SGR/erase sequences
  assert.ok(appbar.replace(/\u001b\[[0-9;]*[mK]/gu, "").trimEnd().endsWith("…"), "a bar cut by the window says so");
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

test("a long active roster tab remains identifiable and clickable at 40 columns", () => {
  const sessions = [
    { agentSessionId: "active-long", number: 1, agent: "claude-code", label: "x".repeat(40), ended: false },
    { agentSessionId: "other", number: 2, agent: "codex", label: "other", ended: false },
  ];
  const frame = renderWorkbenchFrame({
    columns: 40, rows: 5, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions, activeSessionId: "active-long", mouseReporting: true,
  });
  const top = rowText(frame, 1);
  assert.equal(top.length, 40);
  assert.match(top, /\[1:Claude x+…\].*\+1/u);
  const target = frame.appbarTargets.find((entry) => entry.target === "session:active-long");
  assert.ok(target, "the visible active tab has a hit target");
  assert.ok(target.lastColumn <= 40);
  assert.equal(workbenchAppbarTargetAt(frame, target.firstColumn, 1), "session:active-long");
  assert.equal(workbenchAppbarTargetAt(frame, target.lastColumn, 1), "session:active-long");
  assert.equal(workbenchAppbarTargetAt(frame, target.lastColumn + 1, 1), undefined);
  const withAction = renderWorkbenchFrame({
    columns: 40, rows: 5, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions, activeSessionId: "active-long", action: "Copy link · Ctrl+] y", mouseReporting: true,
  });
  assert.match(rowText(withAction, 1), /\[1:Claude x+…\].*\+1/u, "the active tab takes priority over a long action");
  assert.ok(withAction.appbarTargets.some((entry) => entry.target === "session:active-long"));
  const wideLabel = renderWorkbenchFrame({
    columns: 40, rows: 5, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: [{ ...sessions[0], label: "界".repeat(40) }, sessions[1]], activeSessionId: "active-long",
  });
  assert.match(rowText(wideLabel, 1), /\[1:Claude 界+…\].*\+1/u);
  assert.ok(wideLabel.appbarTargets.some((entry) => entry.target === "session:active-long" && entry.lastColumn <= 40));
});

test("the copy/paste hint says a plain drag selects, and Shift+drag only while the agent uses the mouse", () => {
  // Owner 2026-09-29: "only typing works" -- the hint said Shift+drag while
  // Cuna reported the mouse only for its clickable bar. Cuna selects on a
  // plain drag itself unless the remote program asked for the mouse.
  const frame = (remoteMouse) => renderWorkbenchFrame({
    columns: 160, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions, activeSessionId: "session-claude", mouseReporting: true, remoteMouse,
  });
  const own = rowText(frame(false), 2);
  const agent = rowText(frame(true), 2);
  assert.doesNotMatch(own, /Shift\+drag/u);
  assert.match(agent, /Shift\+drag select/u);
  if (process.platform === "win32") {
    assert.match(own, /Claude auth authenticated.*Ctrl\+\] d detach · select \+ Ctrl\+C copy · Ctrl\+click opens a link · Ctrl\+Shift\+V paste $/u);
    assert.match(agent, /Claude auth authenticated.*Ctrl\+\] d detach · Shift\+drag select · Ctrl\+Shift\+C copy · Ctrl\+Shift\+V paste $/u);
  } else {
    assert.doesNotMatch(own, /Ctrl\+Shift\+C/u);
    assert.doesNotMatch(agent, /Ctrl\+Shift\+C/u);
  }
  assert.doesNotMatch(rowText(frame(false), 1), /Ctrl\+Shift/u);
});

// Owner 2026-10-04: a Ctrl+C meant to copy quit Claude Code. The attached bar
// now names the two keys on every host: how to leave without quitting the
// agent, and that a Ctrl+C copies only once text is selected.
test("the attached bar states the detach and copy keys in English on every host", () => {
  const frame = (columns, extra = {}) => renderWorkbenchFrame({
    columns, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions, activeSessionId: "session-claude", mouseReporting: true, ...extra,
  });
  assert.match(rowText(frame(160), 2), /Claude auth authenticated.*Ctrl\+\] d detach · select \+ Ctrl\+C copy/u);
  // Narrower: the two keys survive when the extras do not fit.
  assert.match(rowText(frame(100), 2), /Ctrl\+\] d detach · select \+ Ctrl\+C copy $/u);
  // A notice keeps the row's left side; the keys still follow when they fit.
  assert.match(rowText(frame(160, { notice: "Restoring terminal" }), 2), /Restoring terminal.*Ctrl\+\] d detach · select \+ Ctrl\+C copy/u);
});

test("a shown selection names its Ctrl+C copy key on every host, and only while it is shown", () => {
  const frame = (selection) => renderWorkbenchFrame({
    columns: 140, rows: 24, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false,
    sessions: rosterSessions, activeSessionId: "session-claude", mouseReporting: true,
    ...(selection === undefined ? {} : { selection }),
  });
  assert.match(rowText(frame([{ row: 0, start: 0, end: 5 }]), 2), /Claude auth authenticated.*Ctrl\+C copies the selection · Ctrl\+\] d detach $/u);
  assert.doesNotMatch(rowText(frame(undefined), 2), /Ctrl\+C copies the selection/u);
  assert.doesNotMatch(rowText(frame([]), 2), /Ctrl\+C copies the selection/u);
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

test("a cut observer row ends in Cuna's marker in the last cell, and a row may not claim that cell", async () => {
  const { renderBareViewport } = await import("../dist/terminal/workbench.js");
  const render = async (bytes, columns, rows) => {
    const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
    try {
      await new Promise(resolve => terminal.write(bytes, resolve));
      return Array.from({ length: rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "");
    } finally { terminal.dispose(); }
  };
  const allTabs = tabs();
  const cut = "c".repeat(79);
  const viewport = { ...allTabs[0].viewport, cells: [cut, "whole"], renderRows: undefined, displayWidths: [79, 5],
    continuedRows: [true, false], cursorX: 0, cursorY: 1 };
  for (const color of [true, false]) {
    const frame = renderWorkbenchFrame({ columns: 80, rows: 24, tabs: [{ ...allTabs[0], viewport }, allTabs[1]],
      activeTabId: allTabs[0].id, appbar: model(), color });
    const screen = await render(frame.bytes, 80, 24);
    assert.equal(screen[2], `${cut}›`, `workbench, color ${color}`);
    assert.equal(screen[3], "whole");
  }
  const bare = await render(renderBareViewport({ ...viewport, columns: 80, rows: 4 }), 80, 4);
  assert.equal(bare[0], `${cut}›`, "the plain observer draws the same marker");
  assert.equal(bare[1], "whole");
  assert.throws(() => renderWorkbenchFrame({ columns: 80, rows: 24,
    tabs: [{ ...allTabs[0], viewport: { ...viewport, cells: ["c".repeat(80), "whole"], displayWidths: [80, 5] } }, allTabs[1]],
    activeTabId: allTabs[0].id, appbar: model() }), WorkbenchRenderError, "a cut row cannot also fill the marker's cell");
});

test("a notice or status line cut by a narrow window ends in … and one that fits is untouched", () => {
  const long = "Observing (read-only) · view is 70 columns wider than this window (›) · Press Ctrl+] then w to take control";
  for (const rows of [24, 3]) {
    const frame = (columns, notice) => renderWorkbenchFrame({
      columns, rows, activeTabId: "tab-claude", tabs: tabs(), appbar: model(), color: false, notice,
    });
    const noticeRow = rows >= 5 ? 2 : 1;
    const cut = rowText(frame(60, long), noticeRow).trimEnd();
    assert.ok(cut.endsWith("…"), `${rows} rows: a cut notice ends in …: ${cut}`);
    assert.ok(cut.length <= 60);
    assert.doesNotMatch(rowText(frame(160, long), noticeRow), /…/u, `${rows} rows: a notice that fits is whole`);
  }
});

test("OpenCode without a provider sign-in says its default model needs none; other agents still say login required", () => {
  const [claude, codex] = tabs();
  const openCode = { ...claude, agent: "opencode" };
  const truth = (tab) => rowText(renderWorkbenchFrame({
    columns: 140, rows: 24, activeTabId: tab.id, tabs: [tab, codex].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index),
    appbar: model({ providerAuthentication: evidence("login_required") }), color: false,
  }), 2);
  assert.match(truth(openCode), /OpenCode default model \(no sign-in needed\)/u);
  assert.doesNotMatch(truth(openCode), /login required/u);
  assert.match(truth(claude), /Claude auth login required/u);
});
