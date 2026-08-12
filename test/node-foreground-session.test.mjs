import assert from "node:assert/strict";
import test from "node:test";

import {
  runNodeForegroundSessions,
  selectNodeForegroundPresentation,
} from "../dist/runtime/node-foreground-session.js";
import { encodeTerminalControl, TERMINAL_PROTOCOL } from "../dist/terminal/codec.js";

const NOW = 1_800_000_000_000;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";

function runSupportedForegroundSessions(input, dependencies) {
  return runNodeForegroundSessions({
    terminalKind: "xterm-256color",
    hostPlatform: "linux",
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

test("plain fallback selection is explicit and conservative for nested or non-enriched terminals", () => {
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
    assert.match(activeFrame, /session running/u);
    assert.match(activeFrame, /terminal attached/u);
    assert.match(activeFrame, /auth unknown/u);
    assert.match(activeFrame, /sync unknown/u);
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
    () => new TextDecoder().decode(host.writes.at(-1)).includes("auth authenticated"),
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
    () => new TextDecoder().decode(mismatchedHost.writes.at(-1)).includes("auth unknown"),
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
    () => new TextDecoder().decode(host.writes.at(-1)).includes("auth unknown"),
    "evidence expiring at the exact observation clock must be omitted",
  );
  host.emitInput(Uint8Array.of(0x1d, 0x64));
  await operation;
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
