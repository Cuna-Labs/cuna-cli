import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXIT_CODES, memoryStreams, parseArgv, runCli } from "../dist/index.js";

const API_KEY = "cuna_sk_abcdefghijklmnop";
// A machine ID in the one shape the product accepts. This fixture used to be
// "m_1", which the command layer waved through and the transport would have
// rejected -- so the test asserted a success the real client cannot produce.
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const future = "2026-08-08T00:00:30.000Z";
const FOREGROUND_SESSION_A = "11111111-1111-4111-8111-111111111111";
const FOREGROUND_SESSION_B = "22222222-2222-4222-8222-222222222222";
const FOREGROUND_SESSION_C = "33333333-3333-4333-8333-333333333333";
const FOREGROUND_SESSION_D = "44444444-4444-4444-8444-444444444444";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function capabilitySnapshot(capabilities, subjectScope = "account", subjectId) {
  return {
    schemaVersion: "1.0",
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
    async getIdentity() {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        email: "developer@example.test",
        workspaceAssigned: true,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        workspaceUsage: { estimatedSpendUsd: 1, estimatedRemainingUsd: 49, note: "estimate" },
      };
    },
    async discoverCapabilities() { return capabilitySnapshot([]); },
    async listMachines() { return { items: [] }; },
    async listRecords() { return []; },
    async listAuthorizations() { return []; },
    async listApiKeys() { return []; },
    async revokeApiKey() { throw new Error("unexpected revoke API key"); },
    async createMachine() { throw new Error("unexpected create"); },
    async transitionMachine() { throw new Error("unexpected transition"); },
    async deleteMachine() { throw new Error("unexpected delete"); },
    async listAgentSessions() { return { items: [] }; },
    async createAgentSession() { throw new Error("unexpected create agent"); },
    async getAgentSession() { throw new Error("unexpected get agent"); },
    async logoutAgentSessionAuth() { throw new Error("unexpected logout agent"); },
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
  // `cuna --help` is now the SHORT orientation. Both sentences below still
  // exist verbatim — they were relocated to `cuna help --all`, not removed —
  // and the two assertions that follow prove exactly that: absent from the
  // short help, present in the full one.
  assert.doesNotMatch(helpRecord.data.help, /Automatic local-to-cloud journey:/u);
  assert.match(helpRecord.data.help, /cuna help --all/u);
  const all = memoryStreams();
  assert.equal(await runCli(["help", "--all"], { streams: all.streams }), EXIT_CODES.success);
  const allRecord = JSON.parse(all.stdout());
  assert.match(allRecord.data.help, /Automatic local-to-cloud journey:/u);
  assert.match(allRecord.data.help, /Use --agent-session SESSION_ID to bypass reconciliation/u);
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
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.auth.required");
});

test("TC-037-03/07 records and authorizations remain capability-gated read-only parity operations", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const recordId = "11111111-1111-4111-8111-111111111111";
  const observed = [];
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      observed.push({ kind: "capability", scope, resourceId });
      const id = scope === "account" ? "records.list" : "authorizations.list";
      return capabilitySnapshot([{
        id,
        availability: "supported",
        interaction: "read_only",
        mutationClass: "none",
        surfaces: ["cli"],
        requiredPermissions: [],
      }], scope, resourceId);
    },
    async listRecords() {
      observed.push({ kind: "records" });
      return [{
        id: recordId,
        machineId,
        kind: "session.create",
        summary: "Machine created",
        detail: {},
        createdAt: "2026-08-08T00:00:00.000Z",
      }];
    },
    async listAuthorizations(id) {
      observed.push({ kind: "authorizations", id });
      return [{
        id: "rule-1",
        host: "api.example.com",
        path: "/v1",
        credential: "ANTHROPIC_API_KEY",
        target: { kind: "header", name: "Authorization", format: "Bearer ${credential}" },
        cacheTtlSeconds: 60,
      }];
    },
  });
  const records = memoryStreams();
  assert.equal(await runCli(["records", "list"], {
    streams: records.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(records.stdout()).data.items[0].id, recordId);

  const authorizations = memoryStreams();
  assert.equal(await runCli(["authorizations", "list", "--machine", machineId], {
    streams: authorizations.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(authorizations.stdout()).data.items[0].credential, "ANTHROPIC_API_KEY");
  assert.deepEqual(observed, [
    { kind: "capability", scope: "account", resourceId: undefined },
    { kind: "records" },
    { kind: "capability", scope: "machine", resourceId: machineId },
    { kind: "authorizations", id: machineId },
  ]);
});

test("TC-037-07 account, workspace, and usage expose only the closed public identity projection", async () => {
  const requests = [];
  const identity = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspaceAssigned: true,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    workspaceUsage: { estimatedSpendUsd: 1.25, estimatedRemainingUsd: 48.75, note: "estimate" },
  };
  const client = fakeClient({ async getIdentity() { requests.push("identity"); return identity; } });
  const cases = [
    [["account", "show"], "account.show", { id: identity.id, email: identity.email }],
    [["workspace", "show"], "workspace.show", { assigned: true }],
    [["usage", "show"], "usage.show", {
      estimated_spend_usd: 1.25,
      estimated_remaining_usd: 48.75,
      note: "estimate",
    }],
  ];
  for (const [argv, command, data] of cases) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => client,
    }), EXIT_CODES.success);
    const record = JSON.parse(streams.stdout());
    assert.equal(record.command, command);
    assert.deepEqual(record.data, data);
    assert.doesNotMatch(streams.stdout(), /tenant|credential|token/u);
  }
  assert.deepEqual(requests, ["identity", "identity", "identity"]);
});

test("workspace and usage preserve unassigned waitlist truth without fabricating estimates", async () => {
  const client = fakeClient({
    async getIdentity() {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        email: "developer@example.test",
        workspaceAssigned: false,
        waitlistPosition: 7,
      };
    },
  });
  const workspace = memoryStreams();
  assert.equal(await runCli(["workspace", "show"], {
    streams: workspace.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.deepEqual(JSON.parse(workspace.stdout()).data, { assigned: false, waitlist_position: 7 });

  const usage = memoryStreams();
  assert.equal(await runCli(["usage", "show"], {
    streams: usage.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.unsupported);
  assert.equal(JSON.parse(usage.stderr()).error.details.reason, "workspace_usage_unavailable");
});

test("account and workspace browser opens fail closed without handoff authority", async () => {
  for (const argv of [["account", "open"], ["workspace", "open"]]) {
    let identityReads = 0;
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => fakeClient({ async getIdentity() { identityReads += 1; throw new Error("unexpected"); } }),
    }), EXIT_CODES.unsupported);
    assert.equal(identityReads, 0);
    assert.equal(JSON.parse(streams.stderr()).error.details.reason, "browser_handoff_authority_unavailable");
  }
});

test("TC-037-02 unavailable parity capabilities perform no record or authorization request", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  let effects = 0;
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      return capabilitySnapshot([], scope, resourceId);
    },
    async listRecords() { effects += 1; return []; },
    async listAuthorizations() { effects += 1; return []; },
  });
  for (const argv of [
    ["records", "list"],
    ["authorizations", "list", "--machine", machineId],
  ]) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      now: () => Date.parse("2026-08-08T00:00:00Z"),
      clientFactory: () => client,
    }), EXIT_CODES.unsupported);
  }
  assert.equal(effects, 0);
});

test("TC-037-05 API-key list and revoke require fresh capability plus explicit destructive confirmation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const effects = [];
  const client = fakeClient({
    async discoverCapabilities(scope) {
      effects.push("capability");
      return capabilitySnapshot([{
        id: "api_keys.manage",
        availability: "supported",
        interaction: "native",
        mutationClass: "secret_revealing",
        surfaces: ["cli"],
        requiredPermissions: ["api_keys:manage", "auth:interactive"],
      }], scope);
    },
    async listApiKeys() {
      effects.push("list");
      return [{
        id,
        name: "automation",
        prefix: "cuna_sk_abcd",
        lastFour: "WXYZ",
        createdAt: "2026-08-08T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      }];
    },
    async revokeApiKey(observed) {
      effects.push(`revoke:${observed}`);
      return true;
    },
  });
  const list = memoryStreams();
  assert.equal(await runCli(["api-keys", "list"], {
    streams: list.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(list.stdout()).data.items[0].last_four, "WXYZ");

  const unconfirmed = memoryStreams();
  assert.equal(await runCli(["api-keys", "revoke", id], {
    streams: unconfirmed.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.policy);

  const revoke = memoryStreams();
  assert.equal(await runCli(["api-keys", "revoke", id, "--yes"], {
    streams: revoke.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(revoke.stdout()).data.revoked, true);
  assert.deepEqual(effects, ["capability", "list", "capability", `revoke:${id}`]);
});

test("API-key creation remains fail-closed until one-time-secret reconciliation exists", async () => {
  let effects = 0;
  const streams = memoryStreams();
  const exit = await runCli(["api-keys", "create", "--yes"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({ async listApiKeys() { effects += 1; return []; } }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(effects, 0);
  assert.equal(JSON.parse(streams.stderr()).error.details.reason, "api_key_create_reconciliation_unavailable");
});

test("explicit signup, login, whoami, access status, and logout dispatch only to the interactive authority", async () => {
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
    async signup() { calls.push("signup"); return { ...result, context: { ...result.context, admission: "waitlisted", workspace: { state: "unavailable" }, waitlistPosition: 17 } }; },
    async login() { calls.push("login"); return result; },
    async acquireAccessToken() { throw new Error("unexpected acquire"); },
    async whoami() { calls.push("whoami"); return result; },
    async logout() { calls.push("logout"); return { revoked: true }; },
  };
  for (const [argv, expectedCommand] of [
    [["signup"], "signup"],
    [["login"], "login"],
    [["whoami"], "whoami"],
    [["access", "status"], "access.status"],
    [["logout"], "logout"],
  ]) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, { streams: streams.streams, platform, env: {}, humanAuth }), EXIT_CODES.success);
    const record = JSON.parse(streams.stdout());
    assert.equal(record.command, expectedCommand);
    if (expectedCommand === "access.status") {
      assert.equal(record.data.identity, "active");
      assert.equal(record.data.admission, "admitted");
      assert.deepEqual(record.data.workspace, {
        state: "assigned",
        id: "00000000-0000-0000-0000-000000000003",
      });
    }
  }
  assert.deepEqual(calls, ["signup", "login", "whoami", "whoami", "logout"]);
});

test("access status rejects alternate actions before configuration or authentication effects", async () => {
  for (const argv of [["access"], ["access", "ready"], ["access", "status", "extra"]]) {
    let effects = 0;
    const streams = memoryStreams();
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      humanAuth: { async whoami() { effects += 1; throw new Error("unexpected"); } },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("CUNA_API_KEY automation mode never falls back to or mutates interactive auth", async () => {
  let calls = 0;
  const humanAuth = {
    async signup() { calls += 1; throw new Error("unexpected"); },
    async login() { calls += 1; throw new Error("unexpected"); },
    async acquireAccessToken() { calls += 1; throw new Error("unexpected"); },
    async whoami() { calls += 1; throw new Error("unexpected"); },
    async logout() { calls += 1; throw new Error("unexpected"); },
  };
  const streams = memoryStreams();
  const exit = await runCli(["login"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    humanAuth,
  });
  assert.equal(exit, EXIT_CODES.auth);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.auth.mode_conflict");
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
      schema_version: "1.0",
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
  assert.match(JSON.parse(rejected.stderr()).error.hint, /cuna login/u);
  assert.equal(logins, 0);
});

test("machine list calls the real public legacy Machine projection", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const requests = [];
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    fetch: async (url, init) => {
      requests.push({ url: url.toString(), init });
      return new Response(JSON.stringify([{ id: machineId, name: "dev", status: "running" }]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(requests[0].url, "https://api.getcuna.com/v1/sessions");
  assert.equal(JSON.parse(streams.stdout()).data.items[0].id, machineId);
  assert.equal(streams.stdout().includes(API_KEY), false);
});

test("absent capability is a negative control: no machine mutation occurs", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({ async createMachine() { creates += 1; return {}; } }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.capability.unknown");
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
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
});

test("root options cannot bypass validation by falling through to help", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["--timeout-ms", "not-a-number", "--json"], { streams: streams.streams });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(streams.stdout(), "");
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
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
    env: { CUNA_API_KEY: API_KEY },
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
      assert.equal(id, MACHINE_ID);
      assert.equal(action, "pause");
      return { id, name: "dev", state: "paused" };
    },
  });
  const exit = await runCli(["machines", "pause", MACHINE_ID, "--yes"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(transitions, 1);
  assert.deepEqual(discoveries, [{ scope: "machine", resourceId: MACHINE_ID }]);
  assert.equal(JSON.parse(streams.stdout()).data.state, "paused");
});

function agentSession(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
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
  const workspaceBindingId = "33333333-3333-4333-8333-333333333333";
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
    "--workspace-binding-id", workspaceBindingId, "--workspace-generation", "7",
    "--agent", "codex", "--cwd", "/workspace/repo", "--auth-mode", "credential_binding",
    "--credential-binding", bindingId, "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: createStreams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
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
      workspaceBindingId,
      workspaceGeneration: 7,
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
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(renameExit, EXIT_CODES.success);
  assert.deepEqual(calls[1], { operation: "rename", id: sessionId, name: "renamed" });
  assert.equal(JSON.parse(renameStreams.stdout()).data.name, "renamed");
});

test("agent logout binds confirmation to one exact AgentSession generation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const epoch = "33333333-3333-4333-8333-333333333333";
  const calls = [];
  const client = fakeClient({
    async getAgentSession(observedId) {
      calls.push({ operation: "get", id: observedId });
      return agentSession({ id, processEpoch: epoch, processState: "running", requestState: "launched" });
    },
    async discoverCapabilities(scope, resourceId) {
      calls.push({ operation: "capabilities", scope, resourceId });
      return capabilitySnapshot([{
        id: "agent_sessions.auth_logout",
        availability: "supported",
        interaction: "native",
        mutationClass: "destructive",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:update", "auth:interactive"],
      }], scope, resourceId);
    },
    async logoutAgentSessionAuth(observedId, observedEpoch) {
      calls.push({ operation: "logout", id: observedId, epoch: observedEpoch });
      return {
        observationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentSessionId: id,
        processEpoch: epoch,
        authMode: "interactive_login",
        agent: "claude-code",
        agentVersion: "2.1.226",
        adapterVersion: "runa.agent-auth.v1",
        observedAt: "2026-08-08T00:00:01.000Z",
        outcome: "logout_confirmed",
      };
    },
  });
  const streams = memoryStreams();
  const exit = await runCli(["agent", "logout", "--agent-session", id, "--yes"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(JSON.parse(streams.stdout()).data.outcome, "logout_confirmed");
  assert.deepEqual(calls, [
    { operation: "get", id },
    { operation: "capabilities", scope: "agent_session", resourceId: id },
    { operation: "logout", id, epoch },
  ]);

  const denied = memoryStreams();
  assert.notEqual(await runCli(["agent", "logout", "--agent-session", id], {
    streams: denied.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(calls.length, 3);
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
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7",
    "--agent", "claude-code", "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.details.reason, "subject_scope_mismatch");
});

test("valid automatic agent intents execute the effects-fenced journey and exact attach", async () => {
  const cases = [
    [
      "claude", "services/api", "--machine", "review", "--new-session", "--no-sync",
      "--auth-mode", "credential_binding", "--credential-binding", "44444444-4444-4444-8444-444444444444",
    ],
    ["codex", ".", "--new", "--auth-mode", "interactive_login"],
    ["openclaw", "tools", "--new-session"],
  ];
  for (const argv of cases) {
    const phases = [];
    let attached;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" },
      clientFactory: () => fakeClient(),
      automaticJourneyEffectsFactory: () => ({
        onPhase(phase) { phases.push(phase); },
        async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
        async observeMachines() {
          return [{ id: FOREGROUND_SESSION_A, name: "review", agent: "unknown", requestedAgentSupport: "supported", state: "running", ownership: "owned", freshness: "fresh", recency: "recent", resources: {}, costStatus: "known" }];
        },
        async createMachine() { return { id: FOREGROUND_SESSION_A, state: "running" }; },
        async reconcileMachineCreate() { return "unreconcilable"; },
        async ensureMachineReady({ machineId }) { return { id: machineId, state: "running" }; },
        async synchronizeWorkspace() { return { bindingId: FOREGROUND_SESSION_B, workspaceIdentity: FOREGROUND_SESSION_B, generation: 1, remoteCwd: "/workspace/projects/project" }; },
        async observeAgentSessions() { return []; },
        async createAgentSession({ machineId }) { return { id: FOREGROUND_SESSION_C, machineId }; },
        async ensureAgentSessionReady() { return { id: FOREGROUND_SESSION_C, machineId: FOREGROUND_SESSION_A }; },
        async attach(input) { attached = { id: input.agentSessionId, agent: input.expectedAgent }; },
        async reconcileCancellation() {},
      }),
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.deepEqual(attached, { id: FOREGROUND_SESSION_C, agent: argv[0] === "claude" ? "claude-code" : argv[0] });
    assert.equal(phases[0], "inspect-workspace");
    assert.equal(phases.at(-1), "attach");
  }
});

test("TC-004-01 explicit agent shorthand binds one AgentSession and its expected agent kind", async () => {
  const expectations = [
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["openclaw", "openclaw"],
  ];
  for (const [command, expectedAgent] of expectations) {
    let observed;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli([command, "--agent-session", FOREGROUND_SESSION_A], {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: async (input) => { observed = input; },
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.deepEqual(observed.agentSessionIds, [FOREGROUND_SESSION_A]);
    assert.deepEqual(observed.expectedAgentKinds, [expectedAgent]);
    assert.equal(streams.stdout(), "");
    assert.equal(streams.stderr(), "");
  }
});

test("explicit agent shorthand rejects ambiguous or misleading input before effects", async () => {
  for (const argv of [
    ["claude", ".", "--agent-session", FOREGROUND_SESSION_A],
    ["codex", "--agent-session", "not-a-session"],
    ["openclaw", "--agent-session", FOREGROUND_SESSION_A, "--new"],
  ]) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      env: {},
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("invalid automatic agent intents fail before config, auth, API, or terminal effects", async () => {
  const invalidIntents = [
    ["claude", "one", "two"],
    ["claude", "--new", "--machine", "existing"],
    ["codex", "--new", "--new-session"],
    ["openclaw", "--no-sync"],
    ["codex", "--auth-mode", "automatic"],
    ["claude", "--auth-mode", "credential_binding"],
    ["codex", "--credential-binding", "44444444-4444-4444-8444-444444444444"],
    ["claude", "--machine", "one", "--machine=two"],
    ["openclaw", "bad\u0000path"],
  ];
  for (const argv of invalidIntents) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: {
        ...platform,
        async readSafeConfig() { effects += 1; return { exists: false }; },
      },
      env: {},
      humanAuth: {
        async acquireAccessToken() { effects += 1; return "unexpected"; },
      },
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("TC-055-01 connect and AgentSession attach dispatch only explicit session IDs to the foreground runner", async () => {
  const calls = [];
  const runner = async (input) => { calls.push(input); };
  for (const argv of [
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B],
    ["agent-sessions", "attach", FOREGROUND_SESSION_C],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, FOREGROUND_SESSION_D],
  ]) {
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: runner,
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.equal(streams.stdout(), "");
    assert.equal(streams.stderr(), "");
  }
  assert.deepEqual(calls.map((call) => call.agentSessionIds), [
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B],
    [FOREGROUND_SESSION_C],
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C],
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, FOREGROUND_SESSION_D],
  ]);
  assert.equal(calls.every((call) => call.baseUrl === "https://api.getcuna.com"), true);
});

test("TC-055-11 non-TTY and JSON foreground requests fail before auth, configuration, client, or runner effects", async () => {
  for (const input of [
    { argv: ["connect", FOREGROUND_SESSION_A], streams: memoryStreams() },
    { argv: ["connect", FOREGROUND_SESSION_A, "--json"], streams: memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true }) },
    { argv: ["claude", "--agent-session", FOREGROUND_SESSION_A], streams: memoryStreams() },
    { argv: ["codex", "--agent-session", FOREGROUND_SESSION_A, "--json"], streams: memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true }) },
  ]) {
    let effects = 0;
    const exit = await runCli(input.argv, {
      streams: input.streams.streams,
      platform: {
        ...platform,
        async readSafeConfig() { effects += 1; return { exists: false }; },
      },
      env: {},
      humanAuth: {
        async acquireAccessToken() { effects += 1; return "unexpected"; },
      },
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
    assert.equal(JSON.parse(input.streams.stderr()).error.code, "cuna.usage.invalid");
  }
});

test("TC-055-07/11 terminal admission selects truthful plain fallback and preserves NO_COLOR", async () => {
  for (const kind of ["linux", "macos"]) {
    for (const env of [{}, { TERM: "" }, { TERM: "   " }, { TERM: "dumb" }]) {
      let observed;
      const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
      const exit = await runCli(["connect", FOREGROUND_SESSION_A], {
        streams: streams.streams,
        platform: { ...platform, kind },
        env: { ...env, CUNA_API_KEY: API_KEY },
        clientFactory: () => fakeClient(),
        foregroundTerminalRunner: async (input) => { observed = input; },
      });
      assert.equal(exit, EXIT_CODES.success);
      assert.equal(observed.presentationMode, "plain");
    }
  }

  for (const env of [
    { TERM: "xterm-256color", TMUX: "/tmp/tmux" },
    { TERM: "xterm-256color", SSH_TTY: "/dev/pts/1" },
    { TERM: "xterm-256color", CUNA_TERMINAL_MODE: "plain" },
  ]) {
    let observed;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
      streams: streams.streams,
      platform,
      env: { ...env, CUNA_API_KEY: API_KEY },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: async (input) => { observed = input; },
    }), EXIT_CODES.success);
    assert.equal(observed.presentationMode, "plain");
  }

  let windowsObserved;
  const windows = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: windows.streams,
    platform: { ...platform, kind: "windows" },
    env: { CUNA_API_KEY: API_KEY, TERM: "dumb" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async (input) => { windowsObserved = input; },
  }), EXIT_CODES.success);
  assert.equal(windowsObserved.hostPlatform, "win32");
  assert.equal(windowsObserved.terminalKind, "dumb");
  assert.equal(windowsObserved.presentationMode, "rich");

  let observed;
  const noColor = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: noColor.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY, NO_COLOR: "1", TERM: "xterm-256color" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async (input) => { observed = input; },
  }), EXIT_CODES.success);
  assert.equal(observed.color, false);
  assert.equal(observed.presentationMode, "rich");
  assert.equal(observed.hostPlatform, "linux");
  assert.equal(observed.terminalKind, "xterm-256color");
});

test("plain fallback rejects multiplexing and invalid mode before configuration, auth, or runner effects", async () => {
  for (const env of [
    { TERM: "dumb" },
    { TERM: "xterm-256color", TMUX: "/tmp/tmux" },
  ]) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B], {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      env,
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }

  let effects = 0;
  const invalid = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const exit = await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: invalid.streams,
    platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
    env: { TERM: "xterm", CUNA_TERMINAL_MODE: "decorated" },
    foregroundTerminalRunner: async () => { effects += 1; },
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(effects, 0);
});

test("TC-055-01 malformed, duplicate, and oversized connect identities fail before all effects", async () => {
  const invalid = [
    ["connect"],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_A],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"],
    ["connect", "bad/session"],
  ];
  for (const argv of invalid) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("doctor never advertises interactive browser auth without a verified platform vault", async () => {
  for (const kind of ["windows", "macos"]) {
    const streams = memoryStreams();
    const exit = await runCli(["doctor"], {
      streams: streams.streams,
      platform: { ...platform, kind },
      env: {},
    });
    assert.equal(exit, EXIT_CODES.success);
    const browserAuth = JSON.parse(streams.stdout()).data.runtime_features.find((item) => item.feature === "browser_auth");
    assert.equal(browserAuth.implementation, "unsupported");
    assert.notEqual(browserAuth.reason, "polling_continuation_v1_3");
  }
});

test("package and runtime versions remain identical", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const streams = memoryStreams();
  await runCli(["--version"], { streams: streams.streams });
  assert.equal(JSON.parse(streams.stdout()).data.version, packageJson.version);
});
