import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXIT_CODES, memoryStreams, parseArgv, runCli } from "../dist/index.js";

const API_KEY = "runa_sk_abcdefghijklmnop";
const future = "2099-01-01T00:00:00.000Z";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function capabilitySnapshot(capabilities, subjectScope = "account", subjectId) {
  return {
    schemaVersion: "1",
    subjectScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: future,
    etag: "fixture",
    capabilities,
  };
}

function fakeClient(overrides = {}) {
  return {
    async discoverCapabilities() { return capabilitySnapshot([]); },
    async listMachines() { return { items: [] }; },
    async createMachine() { throw new Error("unexpected create"); },
    async transitionMachine() { throw new Error("unexpected transition"); },
    async deleteMachine() { throw new Error("unexpected delete"); },
    async listAgentSessions() { return { items: [] }; },
    async createAgentSession() { throw new Error("unexpected create agent"); },
    async getAgentSession() { throw new Error("unexpected get agent"); },
    async renameAgentSession() { throw new Error("unexpected rename agent"); },
    async terminateAgentSession() { throw new Error("unexpected terminate agent"); },
    ...overrides,
  };
}

test("parser keeps subcommands separate from options and rejects duplicates", () => {
  const parsed = parseArgv(["machines", "create", "--name", "dev", "--yes", "--json"]);
  assert.equal(parsed.command, "machines");
  assert.deepEqual(parsed.operands, ["create"]);
  assert.deepEqual(parsed.options, { name: "dev", yes: true, json: true });
  assert.throws(() => parseArgv(["machines", "--json", "--json"]));
});

test("non-TTY help and version are versioned JSON records", async () => {
  const help = memoryStreams();
  assert.equal(await runCli(["--help"], { streams: help.streams }), EXIT_CODES.success);
  const helpRecord = JSON.parse(help.stdout());
  assert.equal(helpRecord.schema_version, "1");
  assert.equal(helpRecord.type, "result");
  const version = memoryStreams();
  assert.equal(await runCli(["--version"], { streams: version.streams }), EXIT_CODES.success);
  assert.equal(JSON.parse(version.stdout()).data.version, "0.1.0");
});

test("missing automation auth fails before a remote call and emits no prompt", async () => {
  let calls = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: {},
    clientFactory: () => fakeClient({ async listMachines() { calls += 1; return { items: [] }; } }),
  });
  assert.equal(exit, EXIT_CODES.auth);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.auth.required");
});

test("explicit login, whoami, and logout dispatch only to the interactive authority", async () => {
  const calls = [];
  const result = {
    profile: "default",
    sessionId: "00000000-0000-0000-0000-000000000002",
    context: {
      requiredTermsVersion: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "00000000-0000-0000-0000-000000000003" },
    },
  };
  const humanAuth = {
    async login() { calls.push("login"); return result; },
    async acquireAccessToken() { throw new Error("unexpected acquire"); },
    async whoami() { calls.push("whoami"); return result; },
    async logout() { calls.push("logout"); return { revoked: true }; },
  };
  for (const command of ["login", "whoami", "logout"]) {
    const streams = memoryStreams();
    assert.equal(await runCli([command], { streams: streams.streams, platform, env: {}, humanAuth }), EXIT_CODES.success);
    assert.equal(JSON.parse(streams.stdout()).command, command);
  }
  assert.deepEqual(calls, ["login", "whoami", "logout"]);
});

test("RUNA_API_KEY automation mode never falls back to or mutates interactive auth", async () => {
  let calls = 0;
  const humanAuth = {
    async login() { calls += 1; throw new Error("unexpected"); },
    async acquireAccessToken() { calls += 1; throw new Error("unexpected"); },
    async whoami() { calls += 1; throw new Error("unexpected"); },
    async logout() { calls += 1; throw new Error("unexpected"); },
  };
  const streams = memoryStreams();
  const exit = await runCli(["login"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    humanAuth,
  });
  assert.equal(exit, EXIT_CODES.auth);
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.auth.mode_conflict");
  assert.equal(calls, 0);
});

test("interactive bearer authenticates cloud commands without exposing or persisting the access token", async () => {
  const accessToken = `runa_at_${"a".repeat(43)}`;
  let observedAuthorization;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: {},
    humanAuth: {
      async login() { throw new Error("unexpected"); },
      async acquireAccessToken() { return accessToken; },
      async whoami() { throw new Error("unexpected"); },
      async logout() { throw new Error("unexpected"); },
    },
    fetch: async (_url, init) => {
      observedAuthorization = init.headers.Authorization;
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(observedAuthorization, `Bearer ${accessToken}`);
  assert.equal(streams.stdout().includes(accessToken), false);
  assert.equal(streams.stderr().includes(accessToken), false);
});

test("interactive capabilities use memory bearer without opening login, and auth errors remain secret-free", async () => {
  const accessToken = `runa_at_${"z".repeat(43)}`;
  let acquires = 0;
  let logins = 0;
  const humanAuth = {
    async login() { logins += 1; throw new Error("unexpected browser login"); },
    async acquireAccessToken() { acquires += 1; return accessToken; },
    async whoami() { throw new Error("unexpected"); },
    async logout() { throw new Error("unexpected"); },
  };
  const success = memoryStreams();
  assert.equal(await runCli(["capabilities"], {
    streams: success.streams,
    platform,
    env: {},
    humanAuth,
    fetch: async () => new Response(JSON.stringify({
      schema_version: "1",
      subject_scope: "account",
      observed_at: "2026-08-08T00:00:00.000Z",
      expires_at: future,
      etag: "interactive",
      capabilities: [],
    }), { status: 200 }),
  }), EXIT_CODES.success);
  assert.equal(acquires, 1);
  assert.equal(logins, 0);

  const rejected = memoryStreams();
  assert.equal(await runCli(["capabilities"], {
    streams: rejected.streams,
    platform,
    env: {},
    humanAuth,
    fetch: async () => new Response(JSON.stringify({ code: "cli_auth_rejected", detail: accessToken }), { status: 401 }),
  }), EXIT_CODES.auth);
  assert.equal(rejected.stderr().includes(accessToken), false);
  assert.match(JSON.parse(rejected.stderr()).error.hint, /runa login/u);
  assert.equal(logins, 0);
});

test("machine list calls the real public legacy Machine projection", async () => {
  const requests = [];
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    fetch: async (url, init) => {
      requests.push({ url: url.toString(), init });
      return new Response(JSON.stringify([{ id: "m_1", name: "dev", status: "running" }]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(requests[0].url, "https://api.runacode.io/v1/sessions");
  assert.equal(JSON.parse(streams.stdout()).data.items[0].id, "m_1");
  assert.equal(streams.stdout().includes(API_KEY), false);
});

test("absent capability is a negative control: no machine mutation occurs", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({ async createMachine() { creates += 1; return {}; } }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.capability.unknown");
});

test("malformed remote commands fail before vault, client, or configuration effects", async () => {
  let authCalls = 0;
  let clientCalls = 0;
  let configReads = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list", "--bogus", "value", "--json"], {
    streams: streams.streams,
    platform: {
      ...platform,
      async readSafeConfig() { configReads += 1; return { exists: false }; },
    },
    humanAuth: {
      async acquireAccessToken() { authCalls += 1; return "never"; },
    },
    clientFactory: () => {
      clientCalls += 1;
      return fakeClient();
    },
  });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(authCalls, 0);
  assert.equal(clientCalls, 0);
  assert.equal(configReads, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.usage.invalid");
});

test("root options cannot bypass validation by falling through to help", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["--timeout-ms", "not-a-number", "--json"], { streams: streams.streams });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(streams.stdout(), "");
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.usage.invalid");
});

test("advertised native capability admits exactly one documented mutation", async () => {
  let creates = 0;
  let key;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities() {
      return capabilitySnapshot([{
        id: "machines.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "financial",
        surfaces: ["cli"],
        requiredPermissions: ["machines:create"],
      }]);
    },
    async createMachine(_body, idempotencyKey) {
      creates += 1;
      key = idempotencyKey;
      return { id: "m_1", name: "dev", state: "creating" };
    },
  });
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(creates, 1);
  assert.equal(key, "operation-1");
  assert.equal(JSON.parse(streams.stdout()).data.state, "creating");
});

test("machine lifecycle uses the producer-owned grouped capability ID", async () => {
  const discoveries = [];
  let transitions = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      discoveries.push({ scope, resourceId });
      return capabilitySnapshot([{
        id: "machines.lifecycle",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:update"],
      }], scope, resourceId);
    },
    async transitionMachine(id, action) {
      transitions += 1;
      assert.equal(id, "m_1");
      assert.equal(action, "pause");
      return { id, name: "dev", state: "paused" };
    },
  });
  const exit = await runCli(["machines", "pause", "m_1", "--yes"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(transitions, 1);
  assert.deepEqual(discoveries, [{ scope: "machine", resourceId: "m_1" }]);
  assert.equal(JSON.parse(streams.stdout()).data.state, "paused");
});

function agentSession(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    name: "primary",
    agent: "claude-code",
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launch_pending",
    processState: "unknown",
    rowVersion: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentSession create keeps auth mode explicit and rename is capability-gated", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const bindingId = "44444444-4444-4444-8444-444444444444";
  const calls = [];
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      const id = scope === "machine" ? "agent_sessions.create" : "agent_sessions.rename";
      return capabilitySnapshot([{
        id,
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: [`${id}:permission`],
      }], scope, resourceId);
    },
    async createAgentSession(observedMachine, input, key) {
      calls.push({ operation: "create", observedMachine, input, key });
      return agentSession({ machineId: observedMachine, name: input.name, agent: input.agent, cwd: input.cwd, authMode: input.authMode });
    },
    async renameAgentSession(id, name) {
      calls.push({ operation: "rename", id, name });
      return agentSession({ id, name });
    },
  });

  const createStreams = memoryStreams();
  const createExit = await runCli([
    "agent-sessions", "create", "--machine", machineId, "--name", "review",
    "--agent", "codex", "--cwd", "/workspace/repo", "--auth-mode", "credential_binding",
    "--credential-binding", bindingId, "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: createStreams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(createExit, EXIT_CODES.success);
  assert.deepEqual(calls[0], {
    operation: "create",
    observedMachine: machineId,
    input: {
      name: "review",
      agent: "codex",
      cwd: "/workspace/repo",
      authMode: "credential_binding",
      credentialBindingId: bindingId,
    },
    key: "operation-1",
  });
  assert.equal(JSON.parse(createStreams.stdout()).data.process_state, "unknown");

  const renameStreams = memoryStreams();
  const renameExit = await runCli([
    "agent-sessions", "rename", sessionId, "--name", "renamed", "--yes",
  ], {
    streams: renameStreams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(renameExit, EXIT_CODES.success);
  assert.deepEqual(calls[1], { operation: "rename", id: sessionId, name: "renamed" });
  assert.equal(JSON.parse(renameStreams.stdout()).data.name, "renamed");
});

test("AgentSession capability subject mismatch blocks mutation before the client call", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities() {
      return capabilitySnapshot([{
        id: "agent_sessions.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:create"],
      }], "machine", "another-machine");
    },
    async createAgentSession() { creates += 1; return agentSession(); },
  });
  const exit = await runCli([
    "agent-sessions", "create", "--machine", "22222222-2222-4222-8222-222222222222",
    "--agent", "claude-code", "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.details.reason, "subject_scope_mismatch");
});

test("reserved cloud-terminal commands fail explicitly instead of simulating a session", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["claude"], { streams: streams.streams, platform, env: {} });
  assert.equal(exit, EXIT_CODES.unsupported);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "runa.capability.unsupported");
  assert.equal(error.details.reason, "terminal_runtime_unavailable");
});

test("package and runtime versions remain identical", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const streams = memoryStreams();
  await runCli(["--version"], { streams: streams.streams });
  assert.equal(JSON.parse(streams.stdout()).data.version, packageJson.version);
});
