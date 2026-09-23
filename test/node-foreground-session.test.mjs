import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import xterm from "@xterm/headless";

import { createPlatformAdapter } from "../dist/platform/adapter.js";
import { TERMINAL_CLIENT_BUSY_NOTICE, claimTerminalClientIdentity } from "../dist/runtime/terminal-client-identity.js";
import {
  runNodeForegroundSessions,
  selectNodeForegroundPresentation,
} from "../dist/runtime/node-foreground-session.js";
import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
import { encodeTerminalControl, encodeTerminalFrame, decodeTerminalFrame, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";
import { runtimeFailure } from "../dist/runtime/errors.js";

const NOW = 1_800_000_000_000;
async function visibleHostText(host) {
  const terminal = new xterm.Terminal({ cols: host.columns, rows: host.rows, allowProposedApi: true });
  try {
    for (const bytes of host.writes) await new Promise(resolve => terminal.write(bytes, resolve));
    return Array.from({ length: host.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
  } finally { terminal.dispose(); }
}
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";

for (const refreshedAvailability of ["supported", "unsupported"]) {
  test(`preflight renews expired authority once after slow auth inspection: ${refreshedAvailability}`, async () => {
    let time = NOW;
    let reads = 0;
    const events = [];
    const host = new FakeHost(events);
    const system = terminalSystem(events);
    const reached = new Error("fresh preflight admitted");
    const controlPlane = { ...system.controlPlane,
      async discoverCapabilities(_scope, id) {
        reads++;
        return { ...capability(id, reads === 1 ? "supported" : refreshedAvailability),
          observedAt: new Date(time - 100).toISOString(), expiresAt: new Date(time + 30000).toISOString() };
      },
      async observeAgentSession(id) { return observation(id, { observedAt: new Date(time - 100).toISOString(), expiresAt: new Date(time + 20000).toISOString() }); },
    };
    await assert.rejects(runSupportedForegroundSessions({
      client: fakeClient(events, { async getAgentSessionAuth() { time += 31000; throw new Error("auth status unavailable"); } }),
      baseUrl: "https://api.getcuna.com", agentSessionIds: [SESSION_A],
      onBeforeTerminalOwnership() { throw reached; },
    }, { host, controlPlane, terminalConnector: system.terminalConnector, clock: () => time }),
    refreshedAvailability === "supported" ? error => error === reached : /unsupported/u);
    assert.equal(reads, 2);
    assert.equal(host.acquired, 0);
  });
}

function runSupportedForegroundSessions(input, dependencies) {
  return runNodeForegroundSessions({
    terminalKind: "xterm-256color",
    hostPlatform: "linux",
    presentationMode: "rich",
    ...input,
  }, dependencies);
}

function session(id, overrides = {}) {
  return {
    id,
    machineId: "33333333-3333-4333-8333-333333333333",
    name: `session ${id.slice(0, 4)}`,
    agent: id === SESSION_A ? "claude-code" : "codex",
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    processEpoch: `epoch-${id}`,
    runtimeObservedAt: new Date(NOW - 500).toISOString(),
    rowVersion: 1,
    createdAt: new Date(NOW - 10_000).toISOString(),
    updatedAt: new Date(NOW - 500).toISOString(),
    ...overrides,
  };
}

function capability(id, availability = "supported") {
  return {
    schemaVersion: "1.0",
    subjectScope: "agent_session",
    subjectId: id,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
    etag: `etag-${id}`,
    capabilities: [{
      id: "terminal_connections.create",
      availability,
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["terminal.connect"],
    }],
  };
}

function observation(id, overrides = {}) {
  return {
    authority: "cuna_agent_session_supervisor",
    userId: "user-1",
    machineId: "33333333-3333-4333-8333-333333333333",
    agentSessionId: id,
    processEpoch: `epoch-${id}`,
    state: "running",
    observedAt: new Date(NOW - 500).toISOString(),
    expiresAt: new Date(NOW + 20_000).toISOString(),
    evidenceRevision: `revision-${id}`,
    ...overrides,
  };
}

function fakeClient(events, overrides = {}) {
  return {
    async getAgentSession(id) { events.push(`get:${id}`); return session(id); },
    ...overrides,
  };
}

class FakeHost {
  columns = 80;
  rows = 24;
  acquired = 0;
  restored = 0;
  writes = [];
  acquireModes = [];
  input;
  events;

  constructor(events) { this.events = events; }
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire(mode) {
    this.acquired += 1;
    this.acquireModes.push(mode);
    this.events.push("host:acquire");
    return { restore: async () => { this.restored += 1; this.events.push("host:restore"); } };
  }
  async write(bytes) {
    this.writes.push(bytes.slice());
    if (new TextDecoder().decode(bytes).startsWith("Detached ·")) this.events.push("detach-line");
  }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize() { return () => undefined; }
  emitInput(bytes) { this.input?.(bytes); }
}

test("one-session terminals select persistent Cuna chrome when capable and retain explicit fallbacks", () => {
  assert.equal(selectNodeForegroundPresentation({ platform: "win32", environment: {}, sessionCount: 1 }), "rich");
  assert.equal(selectNodeForegroundPresentation({ platform: "linux", terminalKind: "xterm-256color", environment: {}, sessionCount: 1 }), "rich");
  assert.equal(selectNodeForegroundPresentation({ platform: "darwin", terminalKind: "xterm-256color", environment: {}, sessionCount: 1 }), "rich");
  assert.equal(selectNodeForegroundPresentation({ platform: "win32", environment: { CUNA_TERMINAL_MODE: "rich" }, sessionCount: 1 }), "rich");
  assert.equal(selectNodeForegroundPresentation({ platform: "linux", terminalKind: "xterm-256color", environment: {} }), "rich");
  assert.equal(selectNodeForegroundPresentation({ platform: "linux", terminalKind: "dumb", environment: {} }), "plain");
  assert.equal(selectNodeForegroundPresentation({ platform: "linux", terminalKind: "screen-256color", environment: { TMUX: "/tmp/tmux" } }), "plain");
  assert.equal(selectNodeForegroundPresentation({ platform: "linux", terminalKind: "xterm", environment: { SSH_TTY: "/dev/pts/1" } }), "plain");
  assert.equal(selectNodeForegroundPresentation({ platform: "darwin", terminalKind: "xterm", environment: { CUNA_TERMINAL_MODE: "plain" } }), "plain");
  assert.throws(
    () => selectNodeForegroundPresentation({ platform: "linux", terminalKind: "dumb", environment: { CUNA_TERMINAL_MODE: "rich" } }),
    /cursor-addressing/u,
  );
  assert.throws(
    () => selectNodeForegroundPresentation({ platform: "linux", terminalKind: "xterm", environment: { CUNA_TERMINAL_MODE: "decorated" } }),
    /auto, rich, or plain/u,
  );
});

test("attach progress hands off before terminal ownership", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    onBeforeTerminalOwnership() { events.push("progress:stop"); },
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => host.input !== undefined, "foreground ownership should start after preflight");
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  assert.ok(events.indexOf(`get:${SESSION_A}`) < events.indexOf("progress:stop"));
  assert.ok(events.indexOf("progress:stop") < events.indexOf("host:acquire"));
  assert.equal(system.offers[0], "cuna.terminal-view.v1", "legacy raw READY remains accepted after the optional offer");
});

// PRD-PM-008 E14-D6. Detaching with Ctrl+] d used to print nothing, so the
// person could not tell whether the session survived or how to come back. One
// line, after the terminal is restored, says both.
test("E14-D6: detaching with Ctrl+] d prints one line after the terminal is restored", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => host.input !== undefined, "foreground ownership should start after preflight");
  const writesBeforeDetach = host.writes.length;
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
  const afterRestore = host.writes.slice(writesBeforeDetach).map((bytes) => new TextDecoder().decode(bytes));
  const line = afterRestore.at(-1);
  assert.equal(line, `Detached · session 1111 keeps running · cuna connect ${SESSION_A}\n`);
  assert.ok(events.indexOf("host:restore") < events.indexOf("detach-line"), "the line follows the restore, never precedes it");
});

// Control: a foreground that ends without a local detach prints no such line.
test("E14-D6 control: a cancelled foreground prints no detach line", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const abort = new AbortController();
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    signal: abort.signal,
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => host.input !== undefined, "foreground ownership should start after preflight");
  abort.abort();
  await operation.catch(() => undefined);
  assert.equal(host.restored, 1);
  const text = host.writes.map((bytes) => new TextDecoder().decode(bytes)).join("");
  assert.doesNotMatch(text, /Detached ·/u);
});

test("one pre-negotiation ticket race is recovered without repeating user input", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let connections = 0;
  const terminalConnector = {
    async connect(input) {
      connections += 1;
      if (connections === 1) {
        throw runtimeFailure(
          "terminal_disconnected",
          "The terminal WebSocket failed before negotiation completed.",
          { retryable: true },
        );
      }
      return await system.terminalConnector.connect(input);
    },
  };
  const operation = runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    hostPlatform: "win32",
    presentationMode: "plain",
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => connections === 2 && host.input !== undefined, "the fresh ticket should attach on the bounded retry");
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  assert.equal(connections, 2);
  // The host is held for the whole command (session tabs): the retry reuses
  // it, and it is restored exactly once, after the last attempt.
  assert.equal(host.acquired, 1);
  assert.equal(host.restored, 1);
});

test("a failed early-terminal retry preserves the first typed failure alongside fresh capability refusal", async () => {
  const events = [], host = new FakeHost(events), system = terminalSystem(events);
  const first = runtimeFailure("terminal_disconnected", "The terminal WebSocket failed before negotiation completed.", { retryable: true });
  const second = runtimeFailure("capability_unknown", "Current terminal authority is unavailable.", {
    retryable: false, safeDetails: { capability_id: "terminal_connections.create", reason_code: "supervisor_registry_unavailable" },
  });
  const discover = system.controlPlane.discoverCapabilities.bind(system.controlPlane);
  let connections = 0, retryReads = 0;
  system.controlPlane.discoverCapabilities = async (...args) => {
    if (connections > 0) { retryReads++; throw second; }
    return await discover(...args);
  };
  await assert.rejects(runNodeForegroundSessions({
    client: fakeClient(events), baseUrl: "https://api.getcuna.com", agentSessionIds: [SESSION_A],
    hostPlatform: "win32", presentationMode: "plain",
  }, {
    host, controlPlane: system.controlPlane, clock: () => NOW,
    terminalConnector: { async connect() { connections++; throw first; } },
  }), error => {
    assert.equal(error.code, second.code);
    assert.equal(error.message, second.message);
    assert.equal(error.retryable, second.retryable);
    assert.deepEqual(error.safeDetails, { ...second.safeDetails, prior_attempt_code: first.code });
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [first, second], "causal order remains available without flattening error messages into safe metadata");
    return true;
  });
  assert.equal(connections, 1, "retry capability refusal precedes another connection");
  assert.equal(retryReads, 1, "only one bounded retry is attempted");
  assert.equal(host.acquired, 1);
  assert.equal(host.restored, 1, "the first attempt is cleaned before retry capability discovery");
});

test("one early post-ready passthrough close is recovered without another command", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let connections = 0;
  const terminalConnector = {
    async connect(input) {
      connections += 1;
      const connection = await system.terminalConnector.connect(input);
      if (connections === 1) queueMicrotask(() => system.interruptActiveConnections());
      return connection;
    },
  };
  const operation = runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    hostPlatform: "win32",
    presentationMode: "plain",
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => connections === 2 && host.input !== undefined, "the early remote close should reattach once");
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  assert.equal(connections, 2);
  // The host is held for the whole command (session tabs): the retry reuses
  // it, and it is restored exactly once, after the last attempt.
  assert.equal(host.acquired, 1);
  assert.equal(host.restored, 1);
});

class AsyncByteQueue {
  values = [];
  waiters = [];
  closed = false;
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function terminalSystem(events, availability = () => "supported", canonical = false) {
  let generation = 0;
  let connectFailuresRemaining = 0;
  const grants = new Map();
  const activeQueues = new Set();
  const offers = [];
  const sent = [];
  const issuedRequests = new Map();
  const cancelledRequests = [];
  const controlPlane = {
    async cancelTerminalConnection(input) {
      const { signal, ...request } = input;
      assert.ok(issuedRequests.has(input.idempotencyKey), "cleanup names an issued request");
      assert.deepEqual(request, issuedRequests.get(input.idempotencyKey), "cleanup preserves original subject/body/key");
      assert.equal(signal.aborted, false, "cleanup has independent bounded cancellation");
      cancelledRequests.push(request);
      return { cancelled: true };
    },
    async discoverCapabilities(_scope, id) {
      events.push(`capability:${id}`);
      return capability(id, availability(id));
    },
    async observeAgentSession(id) {
      events.push(`observe:${id}`);
      return observation(id);
    },
    async createTerminalConnection(input) {
      const { signal: _signal, ...request } = input;
      issuedRequests.set(input.idempotencyKey, request);
      events.push(`grant:${input.agentSessionId}`);
      generation += 1;
      const terminalSessionId = `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;
      const grant = {
        terminalSessionId,
        resumeHandle: "66666666-6666-4666-8666-666666666666",
        connectUrl: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
        connectToken: `runa_tc_${"A".repeat(43)}`,
        protocol: TERMINAL_PROTOCOL,
        capabilities: [
          { name: "acknowledgement", availability: "supported" },
          { name: "heartbeat", availability: "supported" },
          { name: "live_resize", availability: "supported" },
          { name: "resume", availability: "supported" },
          { name: "signals", availability: "supported" },
        ],
        expiresAt: new Date(NOW + 20_000).toISOString(),
        agentSessionId: input.agentSessionId,
        processEpoch: `epoch-${input.agentSessionId}`,
        attachmentGeneration: generation,
      };
      grants.set(terminalSessionId, grant);
      return grant;
    },
  };
  const terminalConnector = {
    async connect(input) {
      events.push("wire:connect");
      offers.push(input.terminalViewProtocol);
      if (connectFailuresRemaining > 0) {
        connectFailuresRemaining -= 1;
        throw new Error("replacement unavailable");
      }
      const terminalSessionId = new URL(input.url).pathname.split("/").at(-2);
      const grant = grants.get(terminalSessionId);
      assert.ok(grant);
      const queue = new AsyncByteQueue();
      activeQueues.add(queue);
      queue.push(encodeTerminalControl("ready", 1n, {
        protocol: TERMINAL_PROTOCOL,
        agentSessionId: grant.agentSessionId,
        processEpoch: grant.processEpoch,
        fencingGeneration: grant.attachmentGeneration,
        resizeCapability: "live",
        accessMode: "writer",
        writerEpoch: 1,
        ...(canonical ? {terminalViewProtocol:{name:"cuna.terminal-view.v1",operation:"new",history:"current_view"}} : {}),
      }));
      events.push("wire:connected");
      return {
        connectionId: terminalSessionId,
        receive: () => queue,
        async send(bytes) { sent.push(decodeTerminalFrame(bytes)); },
        async close() { events.push(`wire:close:${terminalSessionId}`); activeQueues.delete(queue); queue.close(); },
      };
    },
  };
  return {
    controlPlane,
    offers, sent,
    /** The client instance each grant was requested for, in order. */
    grantClients: () => [...issuedRequests.values()].map((request) => request.clientInstanceId),
    push(bytes) { for (const queue of activeQueues) queue.push(bytes); },
    cancelledRequests,
    terminalConnector,
    failNextConnections(count) { connectFailuresRemaining = count; },
    interruptActiveConnections() {
      for (const queue of activeQueues) {
        activeQueues.delete(queue);
        queue.close();
      }
    },
  };
}

async function waitUntil(predicate, message, timeoutMs) {
  if (timeoutMs === undefined) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } else {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  if (predicate()) return;
  assert.fail(message);
}

test("TC-004-01 agent shorthand mismatch fails before capability, grant, or terminal acquisition", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSession(id) {
        events.push(`get:${id}`);
        return session(id, { agent: "codex" });
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    expectedAgentKinds: ["claude-code"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  }), /does not match/u);
  assert.deepEqual(events, [`get:${SESSION_A}`]);
  assert.equal(host.acquired, 0);
  assert.equal(host.restored, 0);
});

test("agent shorthand expected-kind cardinality fails before every external effect", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A, SESSION_B],
    expectedAgentKinds: ["claude-code"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  }), /bind every requested AgentSession/u);
  assert.deepEqual(events, []);
  assert.equal(host.acquired, 0);
});

test("TC-055-02 Windows does not misclassify a capable console from an inherited TERM=dumb value", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 0;
  await assert.rejects(runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    terminalKind: "dumb",
    hostPlatform: "win32",
  }, {
    host,
    clock: () => NOW,
  }), /dimensions/u);
  assert.deepEqual(events, []);
  assert.equal(host.acquired, 0);
});

test("TC-055-01 invalid, duplicate, zero, and five-session requests fail before every effect", async () => {
  const invalidRequests = [
    [],
    [SESSION_A, SESSION_A],
    ["not-a-canonical-uuid"],
    [SESSION_A, SESSION_B, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"],
  ];
  for (const agentSessionIds of invalidRequests) {
    const events = [];
    const host = new FakeHost(events);
    await assert.rejects(runNodeForegroundSessions({
      client: fakeClient(events),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds,
    }, { host, clock: () => NOW }));
    assert.deepEqual(events, []);
    assert.equal(host.acquired, 0);
  }
});

test("TC-055-01/02 all explicit sessions preflight before host ownership and one-use grants", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events, (id) => id === SESSION_B ? "unsupported" : "supported");
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A, SESSION_B],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW }), /unsupported/u);
  assert.equal(host.acquired, 0);
  assert.equal(events.some((event) => event.startsWith("grant:")), false);
  assert.equal(events.includes(`capability:${SESSION_A}`), true);
  assert.equal(events.includes(`capability:${SESSION_B}`), true);
});

test("an unknown terminal capability stops before session observation, grant, socket, or terminal ownership", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events, () => "unknown");
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW }),
  (error) => error?.code === "capability_unknown");

  assert.deepEqual(events, [`get:${SESSION_A}`, `capability:${SESSION_A}`]);
  assert.equal(host.acquired, 0);
});

test("TC-055-01 session authority drift fails before host ownership", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  system.controlPlane.observeAgentSession = async (id) => observation(id, { processEpoch: "replacement-epoch" });
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW }), /changed/u);
  assert.equal(host.acquired, 0);
});

test("outer preflight authority is retained through runtime attach and rejects a replacement process generation before grant", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let observations = 0;
  system.controlPlane.observeAgentSession = async (id) => {
    observations += 1;
    return observation(id, observations === 1 ? {} : {
      processEpoch: "replacement-epoch",
      evidenceRevision: "replacement-revision",
    });
  };
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: {
      async connect() {
        events.push("wire:connect");
        throw new Error("replacement generation reached transport");
      },
    },
    clock: () => NOW,
  }), /preflight|changed|generation/u);
  assert.equal(events.some((event) => event.startsWith("grant:")), false);
  assert.equal(events.includes("wire:connect"), false);
  assert.equal(host.restored, 1);
});

test("process and capability authority are revalidated after one-use grant and before transport connection", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let observations = 0;
  let capabilityReads = 0;
  system.controlPlane.observeAgentSession = async (id) => {
    observations += 1;
    return observation(id, observations < 3 ? {} : {
      processEpoch: "post-grant-replacement",
      evidenceRevision: "post-grant-replacement-revision",
    });
  };
  system.controlPlane.discoverCapabilities = async (_scope, id) => {
    capabilityReads += 1;
    events.push(`capability:${id}`);
    return capability(id, capabilityReads < 3 ? "supported" : "unsupported");
  };
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: {
      async connect() {
        events.push("wire:connect");
        throw new Error("revoked capability reached transport");
      },
    },
    clock: () => NOW,
  }), /unsupported|changed|generation/u);
  assert.equal(events.filter((event) => event.startsWith("grant:")).length, 1);
  assert.equal(events.includes("wire:connect"), false);
  assert.equal(host.restored, 1);
});

test("TC-055-01/13 foreground composition attaches one through four exact sessions and restores the host", async () => {
  const available = [SESSION_A, SESSION_B, SESSION_C, SESSION_D];
  for (let count = 1; count <= available.length; count += 1) {
    const sessionIds = available.slice(0, count);
    const events = [];
    const host = new FakeHost(events);
    host.columns = 120;
    const system = terminalSystem(events);
    const controller = new AbortController();
    const operation = runSupportedForegroundSessions({
      client: fakeClient(events),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds: sessionIds,
      signal: controller.signal,
    }, {
      host,
      controlPlane: system.controlPlane,
      terminalConnector: system.terminalConnector,
      clock: () => NOW,
      clientInstanceId: () => `client:test:${count}`,
    });
    // Identical frames are no longer rewritten, so a raw write count is not a
    // reliable "is active" proxy; wait for the active workbench content itself.
    await waitUntil(() => host.writes.some(bytes => new TextDecoder().decode(bytes).includes("terminal attached")), `the ${count}-session workbench should become active`);
    assert.match(new TextDecoder().decode(host.writes[0]), new RegExp(`ATTACHING ${count} EXACT`, "u"));
    const activeFrame = await visibleHostText(host);
    assert.match(activeFrame, /terminal attached/u);
    assert.match(activeFrame, /Claude auth unknown/u);
    assert.doesNotMatch(activeFrame, /machine unknown|session (?:running|stale)|sync unknown/u);
    controller.abort();
    await assert.rejects(operation, /cancelled/u);
    assert.equal(host.acquired, 1);
    assert.equal(host.restored, 1);
    assert.deepEqual(events.filter((event) => event.startsWith("grant:")), sessionIds.map((id) => `grant:${id}`));
    const acquireIndex = events.indexOf("host:acquire");
    assert.equal(events.slice(0, acquireIndex).filter((event) => event.startsWith("capability:")).length, count);
    assert.equal(events.slice(0, acquireIndex).filter((event) => event.startsWith("observe:")).length, count);
    assert.equal(events.slice(0, acquireIndex).filter((event) => event.startsWith("grant:")).length, 0);
  }
});

test("terminal-connections POST remains attach authority when the local runtime observation expiry is old", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  system.controlPlane.observeAgentSession = async (id) => {
    events.push(`observe:${id}`);
    return observation(id, {
      observedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW - 30_000).toISOString(),
    });
  };
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => events.includes(`grant:${SESSION_A}`) && events.includes("wire:connected"), "backend-authorized attach did not reach the terminal wire");
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  assert.equal(events.filter((event) => event === `grant:${SESSION_A}`).length, 1);
  assert.equal(host.restored, 1);
});

test("TC-055-13 explicit local detach is a clean success after complete restoration", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => host.writes.length > 1, "the foreground session should become active");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
  assert.equal(events.some((event) => event.startsWith("wire:close:")), true);
});

test("TC-055-06 appbar accepts only fresh auth evidence for the exact AgentSession epoch", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSessionAuth(id) {
        events.push(`auth:${id}`);
        return {
          observationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agentSessionId: id,
          agent: "claude-code",
          processEpoch: `epoch-${id}`,
          authMode: "interactive_login",
          agentVersion: "2.1.226",
          adapterVersion: "runa.agent-auth.v1",
          evidenceClass: "provider_cli_login_status",
          observedAt: new Date(NOW - 250).toISOString(),
          validUntil: new Date(NOW + 10_000).toISOString(),
          state: "authenticated",
        };
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(
    () => new TextDecoder().decode(host.writes.at(-1)).includes("Claude auth authenticated"),
    "fresh process-scoped provider evidence should reach the appbar",
  );
  assert.equal(events.includes(`auth:${SESSION_A}`), true);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;

  const mismatchedEvents = [];
  const mismatchedHost = new FakeHost(mismatchedEvents);
  mismatchedHost.columns = 160;
  const mismatchedSystem = terminalSystem(mismatchedEvents);
  const mismatched = runSupportedForegroundSessions({
    client: fakeClient(mismatchedEvents, {
      async getAgentSessionAuth(id) {
        return {
          observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          agentSessionId: id,
          agent: "claude-code",
          processEpoch: "sibling-epoch",
          authMode: "interactive_login",
          agentVersion: "2.1.226",
          adapterVersion: "runa.agent-auth.v1",
          evidenceClass: "provider_cli_login_status",
          observedAt: new Date(NOW - 250).toISOString(),
          validUntil: new Date(NOW + 10_000).toISOString(),
          state: "authenticated",
        };
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host: mismatchedHost,
    controlPlane: mismatchedSystem.controlPlane,
    terminalConnector: mismatchedSystem.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(
    () => new TextDecoder().decode(mismatchedHost.writes.at(-1)).includes("Claude auth unknown"),
    "sibling process evidence must be omitted",
  );
  mismatchedHost.emitInput(Uint8Array.of(0x1d, 0x64));
  await mismatched;
});

test("TC-055-06 auth evidence expiring exactly now cannot reach the appbar", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSessionAuth(id) {
        return {
          observationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          agentSessionId: id,
          agent: "claude-code",
          processEpoch: `epoch-${id}`,
          authMode: "interactive_login",
          agentVersion: "2.1.226",
          adapterVersion: "runa.agent-auth.v1",
          evidenceClass: "provider_cli_login_status",
          observedAt: new Date(NOW - 30_000).toISOString(),
          validUntil: new Date(NOW).toISOString(),
          state: "authenticated",
        };
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(
    () => new TextDecoder().decode(host.writes.at(-1)).includes("Claude auth unknown"),
    "evidence expiring at the exact observation clock must be omitted",
  );
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
});

test("an unsupported provider direct attach is unavailable before auth, capability, grant, host, or terminal effects", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let authReads = 0;
  await assert.rejects(
    runSupportedForegroundSessions({
      client: fakeClient(events, {
        async getAgentSession(id) {
          return session(id, { agent: "openclaw" });
        },
        async getAgentSessionAuth() {
          authReads += 1;
          throw new Error("must not read provider auth for an unavailable provider");
        },
      }),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds: [SESSION_A],
    }, {
      host,
      controlPlane: system.controlPlane,
      terminalConnector: system.terminalConnector,
      clock: () => NOW,
    }),
    (error) => error?.code === "capability_unsupported",
  );
  assert.equal(authReads, 0);
  assert.equal(host.acquired, 0);
  assert.equal(events.some((event) => event.startsWith("capability:") || event.startsWith("grant:") || event.startsWith("wire:")), false);
});

test("OpenCode direct attach reaches the PTY with live terminal and exact provider auth evidence", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSession(id) {
        events.push(`get:${id}`);
        return session(id, { agent: "opencode" });
      },
      async getAgentSessionAuth(id) {
        events.push(`auth:${id}`);
        return {
          observationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          agentSessionId: id,
          agent: "opencode",
          processEpoch: `epoch-${id}`,
          authMode: "interactive_login",
          agentVersion: "1.0.0",
          adapterVersion: "cuna.opencode-auth.v1",
          evidenceClass: "provider_cli_credential_presence",
          observedAt: new Date(NOW - 250).toISOString(),
          validUntil: new Date(NOW + 10_000).toISOString(),
          state: "login_required",
        };
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    expectedAgentKinds: ["opencode"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => events.includes("wire:connected"), "OpenCode should reach the exact terminal wire");
  assert.equal(events.includes(`auth:${SESSION_A}`), true);
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /OpenCode auth login required/u);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

for (const missingAuthCode of ["cuna.remote.not_found", "cuna.remote.operation_not_served"]) {
test(`OpenCode ${missingAuthCode} enters a current ready PTY for interactive login`, async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSession(id) {
        events.push(`get:${id}`);
        return session(id, { agent: "opencode" });
      },
      async getAgentSessionAuth(id) {
        events.push(`auth:${id}`);
        throw new CunaError({
          code: missingAuthCode,
          message: "No provider auth observation exists yet.",
          exitCode: EXIT_CODES.remote,
        });
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    expectedAgentKinds: ["opencode"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });

  await waitUntil(() => events.includes("wire:connected"), "missing auth evidence should reach the login PTY");
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /OpenCode auth login required/u);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});
}

test("OpenCode auth endpoint errors enter a current ready PTY for interactive login", async () => {
  for (const [label, error] of [
    ["missing resource", new CunaError({
      code: "cuna.remote.not_found",
      message: "No provider auth observation exists yet.",
      exitCode: EXIT_CODES.remote,
    })],
    ["off-contract observation", new CunaError({
      code: "cuna.remote.malformed_response",
      message: "The provider auth observation could not be decoded.",
      exitCode: EXIT_CODES.remote,
    })],
    ["transport fault", new Error("provider auth read interrupted")],
  ]) {
    const events = [];
    const host = new FakeHost(events);
    host.columns = 160;
    const system = terminalSystem(events);
    const operation = runSupportedForegroundSessions({
      client: fakeClient(events, {
        async getAgentSession(id) {
          events.push(`get:${id}`);
          return session(id, { agent: "opencode" });
        },
        async getAgentSessionAuth() {
          throw error;
        },
      }),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds: [SESSION_A],
      expectedAgentKinds: ["opencode"],
    }, {
      host,
      controlPlane: system.controlPlane,
      terminalConnector: system.terminalConnector,
      clock: () => NOW,
    });
    await waitUntil(() => events.includes("wire:connected"), `${label} should reach the login PTY`);
    assert.match(new TextDecoder().decode(host.writes.at(-1)), /OpenCode auth login required/u);
    host.emitInput(Uint8Array.of(0x1d, 0x64));
    await operation;
  }
});

test("a slow OpenCode auth observation is advisory and cannot delay a ready PTY", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSession(id) {
        events.push(`get:${id}`);
        return session(id, { agent: "opencode" });
      },
      async getAgentSessionAuth(id, signal) {
        events.push(`auth:${id}`);
        await new Promise((_resolve, reject) => {
          const rejectOnAbort = () => {
            events.push(`auth-aborted:${id}`);
            reject(signal?.reason ?? new Error("auth probe aborted"));
          };
          if (signal?.aborted) rejectOnAbort();
          else signal?.addEventListener("abort", rejectOnAbort, { once: true });
        });
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    expectedAgentKinds: ["opencode"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });

  await waitUntil(() => events.includes(`auth-aborted:${SESSION_A}`), "the advisory auth read should be bounded");
  await waitUntil(() => events.includes("wire:connected"), "a fresh OpenCode process should reach its PTY after the bounded auth read");
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /OpenCode auth login required/u);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

test("OpenCode missing auth observation still rejects stale or unavailable process readiness", async () => {
  for (const [label, processState, evidence] of [
    ["unavailable", "failed", { state: "failed" }],
    ["stale", "running", {
      observedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW - 1).toISOString(),
    }],
  ]) {
    const events = [];
    const host = new FakeHost(events);
    const system = terminalSystem(events);
    system.controlPlane.observeAgentSession = async (id) => {
      events.push(`observe:${id}`);
      return observation(id, evidence);
    };
    await assert.rejects(
      runSupportedForegroundSessions({
        client: fakeClient(events, {
          async getAgentSession(id) {
            events.push(`get:${id}`);
            return session(id, { agent: "opencode", processState });
          },
          async getAgentSessionAuth() {
            throw new CunaError({
              code: "cuna.remote.not_found",
              message: "No provider auth observation exists yet.",
              exitCode: EXIT_CODES.remote,
            });
          },
        }),
        baseUrl: "https://api.getcuna.com",
        agentSessionIds: [SESSION_A],
        expectedAgentKinds: ["opencode"],
      }, {
        host,
        controlPlane: system.controlPlane,
        terminalConnector: system.terminalConnector,
        clock: () => NOW,
      }),
      (error) => error?.code === "remote_state_unproven",
      `${label} process evidence must fail closed`,
    );
    assert.equal(events.some((event) => event.startsWith("grant:")), false);
    assert.equal(host.acquired, 0);
  }
});

test("OpenCode login admission rejects credential binding and an unavailable auth observation", async () => {
  for (const [label, authMode, authStatus] of [
    ["credential-binding", "credential_binding", undefined],
    ["auth-unavailable", "interactive_login", {
      observationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agentSessionId: SESSION_A,
      agent: "opencode",
      processEpoch: null,
      authMode: "interactive_login",
      agentVersion: "unavailable",
      adapterVersion: "cuna.opencode-auth.v1",
      evidenceClass: "insufficient",
      observedAt: new Date(NOW).toISOString(),
      validUntil: new Date(NOW).toISOString(),
      state: "unavailable",
    }],
  ]) {
    const events = [];
    const host = new FakeHost(events);
    const system = terminalSystem(events);
    await assert.rejects(
      runSupportedForegroundSessions({
        client: fakeClient(events, {
          async getAgentSession(id) {
            events.push(`get:${id}`);
            return session(id, { agent: "opencode", authMode });
          },
          async getAgentSessionAuth() {
            if (authStatus !== undefined) return authStatus;
            throw new CunaError({
              code: "cuna.remote.not_found",
              message: "No provider auth observation exists yet.",
              exitCode: EXIT_CODES.remote,
            });
          },
        }),
        baseUrl: "https://api.getcuna.com",
        agentSessionIds: [SESSION_A],
        expectedAgentKinds: ["opencode"],
      }, {
        host,
        controlPlane: system.controlPlane,
        terminalConnector: system.terminalConnector,
        clock: () => NOW,
      }),
      (error) => error?.code === "remote_state_unproven",
      `${label} must fail closed`,
    );
    assert.equal(events.some((event) => event.startsWith("grant:")), false);
    assert.equal(host.acquired, 0);
  }
});

test("OpenCode matching unavailable auth abstention enters the current PTY as login required", async () => {
  const events = [];
  const host = new FakeHost(events);
  host.columns = 160;
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events, {
      async getAgentSession(id) {
        return session(id, { agent: "opencode" });
      },
      async getAgentSessionAuth(id) {
        return {
          observationId: "abababab-abab-4bab-8bab-abababababab",
          agentSessionId: id,
          agent: "opencode",
          processEpoch: `epoch-${id}`,
          authMode: "interactive_login",
          agentVersion: "unavailable",
          adapterVersion: "cuna.opencode-auth.v1",
          evidenceClass: "insufficient",
          observedAt: new Date(NOW).toISOString(),
          validUntil: new Date(NOW).toISOString(),
          state: "unavailable",
        };
      },
    }),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    expectedAgentKinds: ["opencode"],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });

  await waitUntil(() => events.includes("wire:connected"), "matching auth abstention must not block terminal authority");
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /OpenCode auth login required/u);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

test("OpenCode login admission rejects a provider auth observation for another agent", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  await assert.rejects(
    runSupportedForegroundSessions({
      client: fakeClient(events, {
        async getAgentSession(id) {
          return session(id, { agent: "opencode" });
        },
        async getAgentSessionAuth(id) {
          return {
            observationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            agentSessionId: id,
            agent: "codex",
            processEpoch: `epoch-${id}`,
            authMode: "interactive_login",
            agentVersion: "1.0.0",
            adapterVersion: "runa.agent-auth.v1",
            evidenceClass: "provider_cli_credential_presence",
            observedAt: new Date(NOW - 250).toISOString(),
            validUntil: new Date(NOW + 10_000).toISOString(),
            state: "login_required",
          };
        },
      }),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds: [SESSION_A],
      expectedAgentKinds: ["opencode"],
    }, {
      host,
      controlPlane: system.controlPlane,
      terminalConnector: system.terminalConnector,
      clock: () => NOW,
    }),
    (error) => error?.code === "remote_state_unproven",
  );
  assert.equal(events.some((event) => event.startsWith("grant:")), false);
  assert.equal(host.acquired, 0);
});

test("TC-009-02/05 plain mode binds one exact session without painting an appbar", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    presentationMode: "plain",
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => events.includes("wire:connected"), "the exact passthrough PTY should connect");
  assert.deepEqual(host.acquireModes, ["plain"]);
  assert.deepEqual(host.writes, [], "plain mode must not paint appbar or progress bytes");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

test("plain mode rejects multiple sessions before API, grant, host, or wire effects", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A, SESSION_B],
    presentationMode: "plain",
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  }), /exactly one/u);
  assert.deepEqual(events, []);
  assert.equal(host.acquired, 0);
});

test("TC-055-13 a recovered terminal can detach cleanly after automatic reconnect exhaustion", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
    coordinatorOptions: { reconnectAttempts: 2, reconnectBaseDelayMs: 1 },
  });
  await waitUntil(() => events.filter((event) => event === "wire:connected").length === 1, "the initial terminal should connect");
  system.failNextConnections(2);
  system.interruptActiveConnections();
  await waitUntil(() => events.filter((event) => event === "wire:connect").length === 3, "automatic reconnect should exhaust two attempts");
  await new Promise((resolve) => setTimeout(resolve, 10));
  host.emitInput(Uint8Array.of(0x1d, 0x72));
  await waitUntil(() => events.filter((event) => event === "wire:connected").length === 2, "manual retry should recover the terminal");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

test("TC-055-13 cancellation after a pending preflight read prevents later admission stages", async () => {
  const events = [];
  const host = new FakeHost(events);
  const controller = new AbortController();
  let release;
  const client = fakeClient(events, {
    async getAgentSession(id, signal) {
      events.push(`get:${id}`);
      assert.equal(signal, controller.signal);
      await new Promise((resolve) => { release = resolve; });
      return session(id);
    },
  });
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client,
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    signal: controller.signal,
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => typeof release === "function", "the preflight read should be pending");
  controller.abort();
  release();
  await assert.rejects(operation, /cancelled/u);
  assert.equal(events.some((event) => event.startsWith("observe:")), false);
  assert.equal(events.some((event) => event.startsWith("grant:")), false);
  assert.equal(host.acquired, 0);
});

test("TC-055-13 a partial second-tab attach failure detaches the first tab and restores once", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let connects = 0;
  const connector = {
    async connect(input) {
      connects += 1;
      if (connects === 2) throw new Error("second attachment failed");
      return system.terminalConnector.connect(input);
    },
  };
  await assert.rejects(runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A, SESSION_B],
  }, { host, controlPlane: system.controlPlane, terminalConnector: connector, clock: () => NOW }), /second attachment failed/u);
  assert.equal(host.restored, 1);
  assert.equal(events.filter((event) => event.startsWith("wire:close:")).length, 1);
});

test("TC-055-11 TERM=dumb selects one-session plain fallback without appbar bytes", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    terminalKind: "dumb",
    hostPlatform: "linux",
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => events.includes("wire:connected"), "TERM=dumb should attach through plain mode");
  assert.deepEqual(host.acquireModes, ["plain"]);
  assert.deepEqual(host.writes, []);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
});

test("one capable Windows session uses persistent Cuna chrome and Ctrl+C detaches cleanly", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    hostPlatform: "win32",
  }, {
    host,
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => events.includes("wire:connected"), "rich session should attach before local detach");
  await waitUntil(() => host.writes.length > 0, "persistent Cuna chrome should render after attach");
  assert.deepEqual(host.acquireModes, [undefined]);
  assert.match(new TextDecoder().decode(host.writes.at(-1)), / CUNA/u);
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  assert.equal(host.restored, 1);
  assert.equal(events.filter((event) => event.startsWith("wire:close:")).length, 1);
});

test("TC-055-11 inherited non-Windows TERM=dumb selects plain fallback", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runNodeForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
  }, {
    host,
    platform: "linux",
    environment: { TERM: "dumb" },
    controlPlane: system.controlPlane,
    terminalConnector: system.terminalConnector,
    clock: () => NOW,
  });
  await waitUntil(() => events.includes("wire:connected"), "inherited TERM=dumb should attach through plain mode");
  assert.deepEqual(host.acquireModes, ["plain"]);
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
});

test("TC-055-11 non-Windows missing and blank TERM use deterministic plain fallback", async () => {
  for (const environment of [{}, { TERM: "   " }]) {
    const events = [];
    const host = new FakeHost(events);
    const system = terminalSystem(events);
    const operation = runNodeForegroundSessions({
      client: fakeClient(events),
      baseUrl: "https://api.getcuna.com",
      agentSessionIds: [SESSION_A],
      hostPlatform: "darwin",
    }, {
      host,
      environment,
      controlPlane: system.controlPlane,
      terminalConnector: system.terminalConnector,
      clock: () => NOW,
    });
    await waitUntil(() => events.includes("wire:connected"), "missing TERM should attach through plain mode");
    assert.deepEqual(host.acquireModes, ["plain"]);
    assert.deepEqual(host.writes, []);
    host.emitInput(Uint8Array.of(0x1d, 0x64));
    await operation;
  }
});

test("TC-055-07 no-color foreground rendering emits no color control sequences", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const controller = new AbortController();
  const operation = runSupportedForegroundSessions({
    client: fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    color: false,
    signal: controller.signal,
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => host.writes.length > 1, "no-color workbench should render after readiness");
  controller.abort();
  await assert.rejects(operation, /cancelled/u);
  assert.equal(host.writes.every((bytes) => !new TextDecoder().decode(bytes).includes("48;2;")), true);
});


test("default Windows foreground factory offers canonical views and waits for current view", async () => {
  const events=[];const host=new FakeHost(events);const system=terminalSystem(events,()=>"supported",true);
  const operation=runNodeForegroundSessions({client:fakeClient(events),baseUrl:"https://api.getcuna.com",agentSessionIds:[SESSION_A],hostPlatform:"win32"}, {host,environment:{},controlPlane:system.controlPlane,terminalConnector:system.terminalConnector,clock:()=>NOW});
  void operation.catch(()=>undefined);
  try {
    await waitUntil(()=>host.writes.some(b=>new TextDecoder().decode(b).includes("Restoring terminal")),"factory must show restoring before current view");
    assert.equal(system.offers[0],"cuna.terminal-view.v1");
    host.emitInput(Uint8Array.of(65));
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(system.sent.filter(f=>f.type==="input").length,0);
    const viewId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    system.push(encodeTerminalControl("view_started",0n,{protocol:"cuna.terminal-view.v1",operation:"new",viewId,columns:80,rows:22}));
    system.push(encodeTerminalFrame({type:"output",critical:false,sequence:1n,payload:new TextEncoder().encode("CURRENT VIEW")}));
    await waitUntil(()=>host.writes.some(b=>new TextDecoder().decode(b).includes("CURRENT VIEW")),"factory awaited renderer must consume current view");
    assert.ok((await visibleHostText(host)).includes("Restoring terminal"));
    system.push(encodeTerminalControl("view_ready",0n,{viewId,afterOutputSequence:"1"}));
    await waitUntil(()=>!new TextDecoder().decode(host.writes.at(-1)).includes("Restoring terminal"),"factory leaves restoring after ready");
    host.emitInput(Uint8Array.of(66));
    await waitUntil(()=>system.sent.some(f=>f.type==="input"),"ready view permits user input");
    assert.deepEqual([...system.sent.find(f=>f.type==="input").payload],[66]);
  } finally {host.emitInput(Uint8Array.of(3));await operation;}
});

/* -------------------------------------------------------------------------- */
/* R14: the same computer re-attaches as the same terminal client               */
/* -------------------------------------------------------------------------- */

async function terminalClientScope(t) {
  const home = await mkdtemp(join(tmpdir(), "cuna-foreground-client-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"), XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") };
  return { platform: createPlatformAdapter({ env, homeDirectory: home }), profile: "default" };
}

/** Attach once to SESSION_A and detach cleanly with Ctrl+] d; answer the client the grant was asked for. */
async function attachAndDetach(input) {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const notices = [];
  const operation = runSupportedForegroundSessions({
    client: input.client ?? fakeClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    onNotice: (line) => notices.push(line),
    ...(input.terminalClients === undefined ? {} : { terminalClients: input.terminalClients }),
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW });
  await waitUntil(() => host.input !== undefined, "foreground ownership should start after preflight");
  if (input.exit === true) system.push(encodeTerminalControl("exit", 2n, { exitCode: 0, reason: "exited" }));
  else host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation.catch(() => undefined);
  const [client] = system.grantClients();
  assert.ok(client, "the run must have asked for a grant");
  return { client, notices };
}

test("R14: a clean detach and re-attach from this computer asks for the seat as the same client", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const first = await attachAndDetach({ terminalClients });
  const second = await attachAndDetach({ terminalClients });
  assert.equal(second.client, first.client);
  assert.deepEqual([...first.notices, ...second.notices], [], "a sole attachment says nothing about its client");
});

test("NEGATIVE CONTROL R14: without the remembered client every run is a new one", async () => {
  const first = await attachAndDetach({});
  const second = await attachAndDetach({});
  assert.notEqual(second.client, first.client);
});

test("R14: a session in a typed terminal state takes its remembered client with it", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const first = await attachAndDetach({ terminalClients });
  const ended = await attachAndDetach({
    terminalClients,
    client: { async getAgentSession(id) { return session(id, { desiredState: "terminated" }); } },
  });
  const third = await attachAndDetach({ terminalClients });
  assert.equal(new Set([first.client, ended.client, third.client]).size, 3);
});

test("R14: a process exit seen on the wire ends the remembered client", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const exited = await attachAndDetach({ terminalClients, exit: true });
  const next = await attachAndDetach({ terminalClients });
  assert.notEqual(next.client, exited.client);
});

test("R14: while another attachment here holds the client, a second one is new and says so in one line", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const holder = await claimTerminalClientIdentity(terminalClients, session(SESSION_A));
  t.after(() => holder.release());
  const second = await attachAndDetach({ terminalClients });
  assert.notEqual(second.client, holder.clientInstanceId, "two processes are never the same client at once");
  assert.deepEqual(second.notices, [TERMINAL_CLIENT_BUSY_NOTICE]);
});

/* -------------------------------------------------------------------------- */
/* Session tabs: a switch is a sequence of single-session runs                  */
/* -------------------------------------------------------------------------- */

function machineClient(events) {
  const sessions = {
    [SESSION_A]: session(SESSION_A, { name: "projA", agent: "claude-code", createdAt: new Date(NOW - 20_000).toISOString() }),
    [SESSION_B]: session(SESSION_B, { name: "projB", agent: "claude-code" }),
  };
  return {
    async getAgentSession(id) { events.push(`get:${id}`); return sessions[id]; },
    async listAgentSessions() { return { items: Object.values(sessions) }; },
  };
}

async function clickTab(host, text) {
  await waitUntil(() => new TextDecoder().decode(host.writes.at(-1) ?? new Uint8Array()).includes(text), `the bar shows ${text}`);
  const top = (await visibleHostText(host)).split("\n")[0];
  const column = top.indexOf(text) + 1;
  assert.ok(column > 0, top);
  host.emitInput(new TextEncoder().encode(`\u001b[<0;${column};1M`));
}

test("session tabs: a click attaches the other session as its own client, and going back resumes the first client", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const operation = runSupportedForegroundSessions({
    client: machineClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    terminalClients,
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW, mouseReporting: true });
  await clickTab(host, "2:Claude projB");
  await waitUntil(() => system.grantClients().length === 2 && host.input !== undefined, "B is attached");
  await waitUntil(() => /\[2:Claude projB\]/u.test(new TextDecoder().decode(host.writes.at(-1))), "B is the bracketed tab");
  await clickTab(host, "1:Claude projA");
  await waitUntil(() => system.grantClients().length === 3 && host.input !== undefined, "A is attached again");
  await waitUntil(() => /\[1:Claude projA\]/u.test(new TextDecoder().decode(host.writes.at(-1))), "A is the bracketed tab");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  const grants = events.filter((event) => event.startsWith("grant:"));
  assert.deepEqual(grants, [`grant:${SESSION_A}`, `grant:${SESSION_B}`, `grant:${SESSION_A}`]);
  const [first, second, third] = system.grantClients();
  assert.notEqual(second, first, "B is not attached as A's client");
  assert.equal(third, first, "back on A, the same client asks for the seat: it resumes, no takeover");
  assert.equal(host.acquired, 1, "the host terminal is held across the switch");
  assert.equal(host.restored, 1);
  const text = host.writes.map((bytes) => new TextDecoder().decode(bytes)).join("");
  assert.match(text, /SWITCHING TO CLAUDE PROJB/u);
  const lines = host.writes.map((bytes) => new TextDecoder().decode(bytes)).filter((line) => line.startsWith("Detached ·"));
  assert.deepEqual(lines.sort(), [
    `Detached · projA keeps running · cuna connect ${SESSION_A}\n`,
    `Detached · projB keeps running · cuna connect ${SESSION_B}\n`,
  ]);
  assert.ok(events.lastIndexOf("host:restore") < events.indexOf("detach-line"), "the lines follow the one restore");
});

test("session tabs: when the target cannot be attached, the run returns once to the session it left and says why", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events, (id) => id === SESSION_B ? "unsupported" : "supported");
  const operation = runSupportedForegroundSessions({
    client: machineClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    terminalClients,
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW, mouseReporting: true });
  await clickTab(host, "2:Claude projB");
  await waitUntil(() => system.grantClients().length === 2 && host.input !== undefined, "A is attached again");
  await waitUntil(() => /Could not switch to Claude projB: capability/u.test(new TextDecoder().decode(host.writes.at(-1))), "the reason is on the bar");
  const [first, back] = system.grantClients();
  assert.equal(back, first, "the way back is the same client");
  assert.deepEqual(events.filter((event) => event.startsWith("grant:")), [`grant:${SESSION_A}`, `grant:${SESSION_A}`], "B never got a grant");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.equal(host.restored, 1);
});

test("session tabs: Ctrl+C while switching ends the run; both sessions keep running", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const controlPlane = { ...system.controlPlane,
    async observeAgentSession(id, signal) {
      if (id === SESSION_B) {
        await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          void gateB.then(resolve);
        });
      }
      return await system.controlPlane.observeAgentSession(id, signal);
    },
  };
  const operation = runSupportedForegroundSessions({
    client: machineClient(events),
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: [SESSION_A],
    terminalClients,
  }, { host, controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW, mouseReporting: true });
  await clickTab(host, "2:Claude projB");
  await waitUntil(() => new TextDecoder().decode(host.writes.at(-1)).includes("SWITCHING TO CLAUDE PROJB"), "the switching screen");
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /Checking [^\r\n]+ · 3s/u,
    "a blocked switch keeps naming the step and shows elapsed seconds");
  host.emitInput(Uint8Array.of(0x03));
  await operation;
  releaseB();
  assert.deepEqual(events.filter((event) => event.startsWith("grant:")), [`grant:${SESSION_A}`]);
  assert.equal(host.restored, 1);
  const lines = host.writes.map((bytes) => new TextDecoder().decode(bytes)).filter((line) => line.startsWith("Detached ·"));
  assert.deepEqual(lines, [`Detached · projA keeps running · cuna connect ${SESSION_A}\n`]);
});

test("session tabs: a switch does not wait on a slow provider sign-in probe", async (t) => {
  const terminalClients = await terminalClientScope(t);
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  const probes = [];
  const client = {
    ...machineClient(events),
    async getAgentSessionAuth(id, signal) {
      probes.push({ id, bounded: signal !== undefined });
      if (id === SESSION_A) throw new Error("auth status unavailable");
      // B's probe never answers: only its own abort can end it.
      return await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const operation = runSupportedForegroundSessions({
    client, baseUrl: "https://api.getcuna.com", agentSessionIds: [SESSION_A], terminalClients,
  }, { host, controlPlane: system.controlPlane, terminalConnector: system.terminalConnector, clock: () => NOW, mouseReporting: true });
  await clickTab(host, "2:Claude projB");
  const started = Date.now();
  await waitUntil(() => system.grantClients().length === 2, "B is granted", 4_000);
  await waitUntil(() => host.input !== undefined && /\[2:Claude projB\]/u.test(new TextDecoder().decode(host.writes.at(-1))), "B is on screen");
  assert.ok(Date.now() - started < 5_000, "bounded by the 2 s advisory timeout");
  assert.match(new TextDecoder().decode(host.writes.at(-1)), /Claude auth unknown/u, "an unanswered probe is shown as unknown");
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
  assert.deepEqual(probes.map((probe) => probe.id), [SESSION_A, SESSION_B]);
});
