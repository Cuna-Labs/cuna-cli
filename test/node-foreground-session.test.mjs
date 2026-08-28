import assert from "node:assert/strict";
import test from "node:test";

import {
  runNodeForegroundSessions,
  selectNodeForegroundPresentation,
} from "../dist/runtime/node-foreground-session.js";
import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
import { encodeTerminalControl, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";
import { runtimeFailure } from "../dist/runtime/errors.js";

const NOW = 1_800_000_000_000;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";

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
  async write(bytes) { this.writes.push(bytes.slice()); }
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
  assert.equal(host.acquired, 2);
  assert.equal(host.restored, 2);
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
  assert.equal(host.acquired, 2);
  assert.equal(host.restored, 2);
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

function terminalSystem(events, availability = () => "supported") {
  let generation = 0;
  let connectFailuresRemaining = 0;
  const grants = new Map();
  const activeQueues = new Set();
  const controlPlane = {
    async discoverCapabilities(_scope, id) {
      events.push(`capability:${id}`);
      return capability(id, availability(id));
    },
    async observeAgentSession(id) {
      events.push(`observe:${id}`);
      return observation(id);
    },
    async createTerminalConnection(input) {
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
      }));
      events.push("wire:connected");
      return {
        connectionId: terminalSessionId,
        receive: () => queue,
        async send() {},
        async close() { events.push(`wire:close:${terminalSessionId}`); activeQueues.delete(queue); queue.close(); },
      };
    },
  };
  return {
    controlPlane,
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

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
    await waitUntil(() => host.writes.length > count, `the ${count}-session workbench should become active`);
    assert.match(new TextDecoder().decode(host.writes[0]), new RegExp(`ATTACHING ${count} EXACT`, "u"));
    const activeFrame = new TextDecoder().decode(host.writes.at(-1));
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

test("OpenCode direct attach is unavailable before auth, capability, grant, host, or terminal effects", async () => {
  const events = [];
  const host = new FakeHost(events);
  const system = terminalSystem(events);
  let authReads = 0;
  await assert.rejects(
    runSupportedForegroundSessions({
      client: fakeClient(events, {
        async getAgentSession(id) {
          return session(id, { agent: "opencode" });
        },
        async getAgentSessionAuth() {
          authReads += 1;
          throw new Error("must not read provider auth for unavailable OpenCode");
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

test("OpenCode direct attach reaches the PTY only with the compiled gate and exact provider auth evidence", async () => {
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
    opencodeEnabled: true,
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
    opencodeEnabled: true,
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
      opencodeEnabled: true,
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
        opencodeEnabled: true,
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
        opencodeEnabled: true,
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
      opencodeEnabled: true,
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
