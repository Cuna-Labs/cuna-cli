import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";

import { runNodeForegroundSessions } from "../dist/runtime/node-foreground-session.js";
import { decodeTerminalControl, decodeTerminalFrame, encodeTerminalControl, encodeTerminalFrame, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";

/**
 * Row-for-row width of an attached terminal, end to end: the `cuna connect`
 * foreground (runtime, coordinator, headless VTE, host frame) against a fake
 * Machine that keeps one canonical screen at the writer's geometry. Its
 * provider re-renders on resize, its views follow that geometry, and every
 * redraw addresses each row with the cursor, the way a tmux view does, so a
 * local VTE narrower than the remote loses the end of each row instead of
 * wrapping it.
 *
 * Owner 2026-09-28 (Machine cd0696a7): after taking control from a 120-column
 * writer, a 143-column window showed 120-character rows of an OAuth URL with
 * 23 characters missing from each. These tests pin what the CLI owns: the
 * writer's remote PTY is this window, and no row is cut without a marker.
 */
const NOW = 1_800_000_000_000;
const SESSION = "74390003-5a12-4708-86b7-4ba490e747d9";
const MACHINE = "cd0696a7-fd94-4095-b3ed-05283de80469";
const VIEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL_TEXT = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers" +
  `&code_challenge=${"x".repeat(43)}&state=${"y".repeat(20)}`;
const encoder = new TextEncoder();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The supervisor sends seat and geometry notices as non-critical frames.
const notice = (type, sequence, payload) => encodeTerminalFrame({ type, sequence, critical: false, payload: encoder.encode(JSON.stringify(payload)) });

function providerScreen(columns) {
  const lines = ["Welcome to Claude Code", "Browser didn't open? Use the url below to sign in", ""];
  for (let offset = 0; offset < URL_TEXT.length; offset += columns) lines.push(URL_TEXT.slice(offset, offset + columns));
  lines.push("", "Paste code here if prompted >");
  return lines;
}

function redraw(screen, view) {
  let text = "\u001b[H\u001b[2J";
  screen.slice(0, view.rows).forEach((line, index) => { text += `\u001b[${index + 1};1H${line.slice(0, view.columns)}\u001b[K`; });
  return encoder.encode(text);
}

function capability(id) {
  const entry = (name) => ({ id: name, availability: "supported", interaction: "native", mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: ["terminal.connect"] });
  return {
    schemaVersion: "1.0", subjectScope: "agent_session", subjectId: id,
    observedAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 30_000).toISOString(), etag: `etag-${id}`,
    capabilities: [entry("terminal_connections.create"), entry("terminal_writers.transfer")],
  };
}

class Queue {
  values = []; waiters = []; closed = false;
  push(value) { const waiter = this.waiters.shift(); if (waiter) waiter({ done: false, value }); else this.values.push(value); }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }); }
  [Symbol.asyncIterator]() { return this; }
  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** One AgentSession on a Machine with the canonical-view supervisor. */
class FakeMachine {
  resizes = [];
  connections = [];
  writerEpoch = 1;
  #generation = 0;
  #grants = new Map();

  constructor(geometry, writer) { this.geometry = { ...geometry }; this.writer = writer; }

  controlPlane() {
    return {
      cancelTerminalConnection: async () => ({ cancelled: true }),
      discoverCapabilities: async (_scope, id) => capability(id),
      observeAgentSession: async (id) => ({
        authority: "cuna_agent_session_supervisor", userId: "user-1", machineId: MACHINE, agentSessionId: id,
        processEpoch: `epoch-${id}`, state: "running", observedAt: new Date(NOW - 500).toISOString(),
        expiresAt: new Date(NOW + 20_000).toISOString(), evidenceRevision: `revision-${id}`,
      }),
      createTerminalConnection: async (input) => {
        if (input.accessMode === "writer" && this.writer !== undefined && this.writer !== input.clientInstanceId) {
          throw Object.assign(new Error("held"), { details: { reason: "terminal_writer_held" } });
        }
        if (input.accessMode === "writer") this.writer = input.clientInstanceId;
        this.#generation += 1;
        const terminalSessionId = `00000000-0000-4000-8000-${String(this.#generation).padStart(12, "0")}`;
        const grant = {
          terminalSessionId, resumeHandle: "66666666-6666-4666-8666-666666666666",
          connectUrl: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
          connectToken: `runa_tc_${"A".repeat(43)}`, protocol: TERMINAL_PROTOCOL,
          capabilities: ["acknowledgement", "heartbeat", "live_resize", "resume", "signals"].map((name) => ({ name, availability: "supported" })),
          expiresAt: new Date(NOW + 20_000).toISOString(), agentSessionId: input.agentSessionId,
          processEpoch: `epoch-${input.agentSessionId}`, attachmentGeneration: this.#generation,
          accessMode: input.accessMode, clientInstanceId: input.clientInstanceId,
        };
        this.#grants.set(terminalSessionId, grant);
        return grant;
      },
      transferTerminalWriter: async (input) => {
        this.writer = input.clientInstanceId;
        this.writerEpoch = input.expectedWriterEpoch + 1;
        // The supervisor's order: the seat notice, then the geometry, which is
        // still the previous writer's until the new writer resizes.
        for (const connection of this.connections) {
          connection.accessMode = connection.clientInstanceId === this.writer ? "writer" : "observer";
          connection.push(notice("writer_epoch", 2n, { writerEpoch: this.writerEpoch, writerClientInstanceId: this.writer, accessMode: connection.accessMode }));
          connection.push(notice("control_state", 2n, { ...this.geometry, writerEpoch: this.writerEpoch }));
        }
        return {
          agentSessionId: input.agentSessionId, processEpoch: `epoch-${input.agentSessionId}`,
          writerEpoch: this.writerEpoch, writerClientInstanceId: input.clientInstanceId,
          transferPending: false, operationId: input.operationId, operationState: "committed",
        };
      },
    };
  }

  resize(columns, rows) {
    this.resizes.push({ columns, rows });
    const changed = columns !== this.geometry.columns || rows !== this.geometry.rows;
    this.geometry = { columns, rows };
    for (const connection of this.connections) {
      connection.push(notice("control_state", 2n, { columns, rows, writerEpoch: this.writerEpoch }));
      if (changed && connection.viewStarted) connection.output(redraw(providerScreen(columns), this.geometry));
    }
  }

  connector() {
    return {
      connect: async (input) => {
        const terminalSessionId = new URL(input.url).pathname.split("/").at(-2);
        const grant = this.#grants.get(terminalSessionId);
        const machine = this;
        const connection = {
          clientInstanceId: grant.clientInstanceId, accessMode: grant.accessMode,
          queue: new Queue(), outputSequence: 0n, viewStarted: false,
          push(bytes) { this.queue.push(bytes); },
          output(bytes) {
            this.outputSequence += 1n;
            this.push(encodeTerminalFrame({ type: "output", critical: false, sequence: this.outputSequence, payload: bytes }));
          },
        };
        this.connections.push(connection);
        connection.push(encodeTerminalControl("ready", 1n, {
          protocol: TERMINAL_PROTOCOL, agentSessionId: grant.agentSessionId, processEpoch: grant.processEpoch,
          fencingGeneration: grant.attachmentGeneration, resizeCapability: "live", accessMode: grant.accessMode,
          writerEpoch: this.writerEpoch, terminalViewProtocol: { name: "cuna.terminal-view.v1", operation: "new", history: "current_view" },
        }));
        return {
          connectionId: terminalSessionId,
          receive: () => connection.queue,
          async send(bytes) {
            const frame = decodeTerminalFrame(bytes);
            await delay(1);
            if (frame?.type === "resize") {
              assert.equal(connection.accessMode, "writer", "an observer's RESIZE would close its attachment");
              const value = decodeTerminalControl(frame);
              machine.resize(Number(value.columns), Number(value.rows));
            } else if (frame?.type === "resume") {
              const view = machine.geometry;
              connection.push(encodeTerminalControl("view_started", 0n, { protocol: "cuna.terminal-view.v1", operation: "new", viewId: VIEW, ...view }));
              connection.viewStarted = true;
              connection.output(redraw(providerScreen(view.columns), view));
              connection.push(encodeTerminalControl("view_ready", 0n, { viewId: VIEW, afterOutputSequence: connection.outputSequence.toString() }));
              connection.push(notice("control_state", 2n, { ...view, writerEpoch: machine.writerEpoch }));
            } else if (frame?.type === "heartbeat") {
              connection.push(encodeTerminalControl("heartbeat", frame.sequence, {}));
            }
          },
          async close() { connection.queue.close(); },
        };
      },
    };
  }
}

class Host {
  writes = [];
  constructor(columns, rows) { this.columns = columns; this.rows = rows; }
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() { return { restore: async () => undefined }; }
  async write(bytes) { this.writes.push(bytes.slice()); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize(listener) { this.resize = listener; return () => { this.resize = undefined; }; }
  emitInput(bytes) { this.input?.(bytes); }
  emitResize(columns, rows) { this.columns = columns; this.rows = rows; this.resize?.(); }
}

async function screen(host) {
  const terminal = new xterm.Terminal({ cols: host.columns, rows: host.rows, allowProposedApi: true });
  try {
    for (const bytes of host.writes) await new Promise((resolve) => terminal.write(bytes, resolve));
    return Array.from({ length: host.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "");
  } finally { terminal.dispose(); }
}

/** The URL rows the host shows, below the two Cuna bars. */
async function paintedUrlRows(host) {
  const rows = (await screen(host)).slice(2);
  const first = rows.findIndex((row) => row.startsWith("https://claude.com/"));
  const painted = [];
  for (let index = first; index >= 0 && index < rows.length && rows[index] !== ""; index += 1) painted.push(rows[index]);
  return painted;
}

function remoteUrlRows(columns) {
  const rows = [];
  for (let offset = 0; offset < URL_TEXT.length; offset += columns) rows.push(URL_TEXT.slice(offset, offset + columns));
  return rows;
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function connect(machine, host) {
  const operation = runNodeForegroundSessions({
    client: { async getAgentSession(id) { return {
      id, machineId: MACHINE, name: "claude-code", agent: "claude-code", cwd: "/workspace", authMode: "interactive_login",
      desiredState: "running", requestState: "launched", processState: "running", processEpoch: `epoch-${id}`,
      runtimeObservedAt: new Date(NOW - 500).toISOString(), rowVersion: 1,
      createdAt: new Date(NOW - 10_000).toISOString(), updatedAt: new Date(NOW - 500).toISOString(),
    }; } },
    baseUrl: "https://api.getcuna.com", agentSessionIds: [SESSION],
    terminalKind: "xterm-256color", hostPlatform: "linux", presentationMode: "rich",
  }, {
    host, environment: {}, controlPlane: machine.controlPlane(), terminalConnector: machine.connector(), clock: () => NOW,
    clientInstanceId: () => "cli:this-window", sessionRoster: false, mouseReporting: false,
  });
  const settled = operation.then(() => undefined, (error) => error);
  return {
    async detach() {
      host.emitInput(Uint8Array.of(0x1d, 0x64));
      assert.equal(await settled, undefined, "the run ends by a clean detach");
    },
  };
}

for (const [columns, rows] of [[186, 42], [157, 40], [120, 34]]) {
  test(`a writer's rows use the whole ${columns}x${rows} window and lose no character`, async () => {
    const machine = new FakeMachine({ columns: 80, rows: 24 }, undefined);
    const host = new Host(columns, rows);
    const run = await connect(machine, host);
    try {
      await waitFor(async () => (await paintedUrlRows(host)).length > 0, "the provider's screen is painted");
      assert.deepEqual(machine.geometry, { columns, rows: rows - 2 }, "the remote PTY is this window's content area");
      assert.deepEqual(await paintedUrlRows(host), remoteUrlRows(columns));
    } finally { await run.detach(); }
  });
}

test("taking control from a narrower writer resizes the PTY to this window and repaints every row whole", async () => {
  const machine = new FakeMachine({ columns: 120, rows: 32 }, "cli:other-writer");
  const host = new Host(143, 45);
  const run = await connect(machine, host);
  try {
    await waitFor(async () => (await screen(host))[1].includes("Observing (read-only)"), "this window starts as an observer");
    assert.deepEqual(await paintedUrlRows(host), remoteUrlRows(120), "an observer shows the writer's 120-column rows whole");
    assert.deepEqual(machine.resizes, [], "an observer never resizes the writer's PTY");

    host.emitInput(Uint8Array.of(0x1d, 0x77));
    await waitFor(() => machine.resizes.length > 0, "the new writer states this window's size");
    assert.deepEqual(machine.resizes, [{ columns: 143, rows: 43 }]);
    await waitFor(async () => JSON.stringify(await paintedUrlRows(host)) === JSON.stringify(remoteUrlRows(143)),
      "every 143-column row is painted whole after the takeover");

    host.emitResize(157, 40);
    await waitFor(() => machine.resizes.length > 1, "a later host resize reaches the PTY");
    assert.deepEqual(machine.resizes.at(-1), { columns: 157, rows: 38 });
    await waitFor(async () => JSON.stringify(await paintedUrlRows(host)) === JSON.stringify(remoteUrlRows(157)),
      "every 157-column row is painted whole after the resize");
  } finally { await run.detach(); }
});

test("an observer of a wider writer marks each cut row and hides no character silently", async () => {
  const machine = new FakeMachine({ columns: 200, rows: 40 }, "cli:other-writer");
  const host = new Host(186, 42);
  const run = await connect(machine, host);
  try {
    await waitFor(async () => (await paintedUrlRows(host)).length > 0, "the writer's screen is painted");
    const expected = remoteUrlRows(200).map((row) => row.length > 186 ? `${row.slice(0, 185)}›` : row);
    assert.deepEqual(await paintedUrlRows(host), expected);
    assert.match((await screen(host))[1], /view is 14 columns wider than this window/u);
    assert.deepEqual(machine.resizes, [], "an observer never resizes the writer's PTY");
  } finally { await run.detach(); }
});

test("an observer whose window grows past the writer shows the writer's rows whole, then takes control at the larger size", async () => {
  // Owner 2026-09-29: a 120x34 observer grown to 240x50 kept rows cut at the
  // writer's width, and after taking control rows stayed cut at 143. The
  // CLI's part: the observer shows exactly the writer's rows, and the new
  // writer states the whole larger window. (A supervisor view that never
  // follows the resize cut the rows in production; see the infra fix.)
  const machine = new FakeMachine({ columns: 143, rows: 40 }, "cli:other-writer");
  const host = new Host(120, 34);
  const run = await connect(machine, host);
  try {
    await waitFor(async () => (await paintedUrlRows(host)).length > 0, "the writer's screen is painted");
    const cut = remoteUrlRows(143).map((row) => row.length > 120 ? `${row.slice(0, 119)}›` : row);
    assert.deepEqual(await paintedUrlRows(host), cut, "a narrower observer marks every cut row");

    host.emitResize(240, 50);
    await waitFor(async () => JSON.stringify(await paintedUrlRows(host)) === JSON.stringify(remoteUrlRows(143)),
      "a wider observer shows the writer's 143-column rows whole");
    assert.deepEqual(machine.resizes, [], "an observer never resizes the writer's PTY");

    host.emitInput(Uint8Array.of(0x1d, 0x77));
    await waitFor(() => machine.resizes.length > 0, "the new writer states this window's size");
    assert.deepEqual(machine.resizes, [{ columns: 240, rows: 48 }]);
    await waitFor(async () => JSON.stringify(await paintedUrlRows(host)) === JSON.stringify(remoteUrlRows(240)),
      "every 240-column row is painted whole after the takeover");
  } finally { await run.detach(); }
});
