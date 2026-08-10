import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createRunaApiClient,
  decodeApiKeyList,
  decodeAuditRecords,
  decodeAgentSessionItem,
  decodeAgentSessionAuth,
  decodeAgentSessionAuthLogout,
  decodeCapabilitySnapshot,
  decodeCredentialRules,
  decodeMachinePage,
  decodeRunaIdentity,
  decodeTerminalConnectionGrant,
  decideCapability,
  RunaError,
} from "../dist/index.js";

const future = "2026-08-08T00:00:30.000Z";
const past = "2000-01-01T00:00:00.000Z";

function capability(overrides = {}) {
  return {
    id: "machines.create",
    availability: "supported",
    surfaces: ["cli"],
    interaction: "native",
    mutation_class: "financial",
    required_permissions: ["machines:create"],
    ...overrides,
  };
}

function snapshot(capabilities, expiresAt = future) {
  return {
    schema_version: "1.0",
    subject_scope: "account",
    observed_at: "2026-08-08T00:00:00.000Z",
    expires_at: expiresAt,
    etag: "fixture",
    capabilities,
  };
}

test("unknown capability enum values are converted to unknown and cannot authorize", () => {
  const decoded = decodeCapabilitySnapshot(snapshot([capability({ availability: "future_value" })]));
  assert.equal(decoded.capabilities[0].availability, "unknown");
  assert.equal(decideCapability(decoded, "machines.create", Date.parse("2026-08-08T00:00:00Z")).status, "unknown");
});

test("expired and duplicate capability evidence is unknown", () => {
  const expired = decodeCapabilitySnapshot(snapshot([capability()], past));
  assert.equal(decideCapability(expired, "machines.create").status, "unknown");
  const duplicate = decodeCapabilitySnapshot(snapshot([capability(), capability()]));
  assert.equal(decideCapability(duplicate, "machines.create", Date.parse("2026-08-08T00:00:00Z")).reason, "capability_ambiguous");
});

test("future-dated and inverted capability evidence is unknown", () => {
  const futureObserved = decodeCapabilitySnapshot({
    ...snapshot([capability()]),
    observed_at: "2098-01-01T00:00:00.000Z",
  });
  assert.equal(decideCapability(futureObserved, "machines.create", Date.parse("2026-08-08T00:00:00Z")).status, "unknown");
  const inverted = decodeCapabilitySnapshot({
    ...snapshot([capability()]),
    observed_at: "2099-01-02T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(decideCapability(inverted, "machines.create", Date.parse("2098-01-01T00:00:00Z")).status, "unknown");
});

test("unknown capability schema and excessive lease duration cannot authorize", () => {
  assert.throws(
    () => decodeCapabilitySnapshot({ ...snapshot([capability()]), schema_version: "2.0" }),
    /schema version/u,
  );
  const excessive = decodeCapabilitySnapshot({
    ...snapshot([capability()]),
    expires_at: "2026-08-08T00:02:00.001Z",
  });
  assert.equal(decideCapability(excessive, "machines.create", Date.parse("2026-08-08T00:00:00Z")).status, "unknown");
});

test("Cuna identity decoder is closed and preserves only public account authority", () => {
  const decoded = decodeRunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      id: "22222222-2222-4222-8222-222222222222",
      usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "estimate" },
    },
  });
  assert.deepEqual(decoded, {
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspaceAssigned: true,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    workspaceUsage: {
      estimatedSpendUsd: 1,
      estimatedRemainingUsd: 49,
      note: "estimate",
    },
  });
  assert.deepEqual(decodeRunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: { assigned: false, waitlist_position: 7 },
  }), {
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspaceAssigned: false,
    waitlistPosition: 7,
  });
  assert.throws(() => decodeRunaIdentity({
    id: "not-a-uuid",
    email: "developer@example.test",
    workspace: { assigned: false, waitlist_position: 1 },
  }));
  assert.throws(() => decodeRunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      id: "22222222-2222-4222-8222-222222222222",
      usage: {},
    },
    tenant_id: "forbidden",
  }));
  assert.throws(() => decodeRunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "estimate" },
    },
  }), /workspace identity/u);
});

test("TC-037-09 records and authorization decoders reject secret and terminal-control disclosure", () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    kind: "session.create",
    summary: "Machine created",
    detail: { agent: "codex", resources: [1, 512] },
    created_at: "2026-08-08T00:00:00.000Z",
  };
  assert.equal(decodeAuditRecords([record])[0].kind, "session.create");
  assert.throws(() => decodeAuditRecords([{ ...record, detail: { token: "cuna_sk_abcdefghijk" } }]));
  assert.throws(() => decodeAuditRecords([{ ...record, summary: "safe\u001b[31m" }]));

  const rule = {
    id: "rule-1",
    host: "api.example.com",
    path: "/v1",
    credential: "ANTHROPIC_API_KEY",
    target: { header: "Authorization", format: "Bearer ${credential}" },
    cache_ttl_secs: 60,
  };
  assert.deepEqual(decodeCredentialRules([rule])[0].target, {
    kind: "header",
    name: "Authorization",
    format: "Bearer ${credential}",
  });
  assert.throws(() => decodeCredentialRules([{ ...rule, target: { header: "Authorization", param: "key", format: "x" } }]));
  assert.throws(() => decodeCredentialRules([{ ...rule, host: "api.example.com\nforged" }]));
});

test("TC-037-03 read-only parity clients use exact record and authorization routes", async () => {
  const requests = [];
  const machineId = "22222222-2222-4222-8222-222222222222";
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return [];
    },
  });
  await client.listRecords();
  await client.listAuthorizations(machineId);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v1/records" },
    { method: "GET", path: `/v1/sessions/${machineId}/authorizations` },
  ]);
  await assert.rejects(client.listAuthorizations("not-a-machine"));
  assert.equal(requests.length, 2);
});

test("machine get binds the exact public machine authority before selection", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const machine = {
    id: machineId,
    name: "development",
    state: "running",
    agent: "claude-code",
    vcpus: 1,
    memory_mib: 512,
    created_at: "2026-08-08T00:00:00.000Z",
  };
  const client = createRunaApiClient({
    async request(request) {
      calls.push(request);
      return machine;
    },
  });

  assert.equal((await client.getMachine(machineId)).id, machineId);
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: `/v1/sessions/${machineId}` },
  ]);

  await assert.rejects(client.getMachine("not-a-machine"));
  assert.equal(calls.length, 1);

  const substituted = createRunaApiClient({
    async request() {
      return { ...machine, id: "33333333-3333-4333-8333-333333333333" };
    },
  });
  await assert.rejects(
    substituted.getMachine(machineId),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
});

test("TC-037-05 API-key metadata is closed and never accepts a plaintext secret", async () => {
  const metadata = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "automation",
    prefix: "cuna_sk_abcd",
    last_four: "WXYZ",
    created_at: "2026-08-08T00:00:00.000Z",
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  };
  assert.equal(decodeApiKeyList([metadata])[0].name, "automation");
  assert.throws(() => decodeApiKeyList([{ ...metadata, key: "cuna_sk_abcdefghijklmnopqrstuvwxyz" }]));
  assert.throws(() => decodeApiKeyList([{ ...metadata, last_four: "too-long" }]));
});

test("TC-037-03 API-key list and revoke use exact public routes and closed acknowledgement", async () => {
  const requests = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return request.method === "GET" ? [] : { ok: true };
    },
  });
  await client.listApiKeys();
  assert.equal(await client.revokeApiKey(id), true);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v1/api-keys" },
    { method: "DELETE", path: `/v1/api-keys/${id}` },
  ]);
  await assert.rejects(client.revokeApiKey("invalid"));
  assert.equal(requests.length, 2);
});

function agentSession(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machine_id: "22222222-2222-4222-8222-222222222222",
    workspace_binding_id: "33333333-3333-4333-8333-333333333333",
    workspace_generation: 7,
    name: "primary",
    agent: "claude-code",
    cwd: "/workspace",
    auth_mode: "interactive_login",
    desired_state: "running",
    request_state: "launch_pending",
    process_state: "unknown",
    row_version: 0,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentSession decoder preserves separate intent and observed runtime truth", () => {
  const decoded = decodeAgentSessionItem(agentSession({
    request_state: "launched",
    process_state: "running",
    process_epoch: "33333333-3333-4333-8333-333333333333",
    runtime_observed_at: "2026-08-08T00:00:01.000Z",
    runtime_expires_at: "2026-08-08T00:00:31.000Z",
    row_version: 4,
  }));
  assert.equal(decoded.name, "primary");
  assert.equal(decoded.requestState, "launched");
  assert.equal(decoded.processState, "running");
  assert.equal(decoded.workspaceBindingId, "33333333-3333-4333-8333-333333333333");
  assert.equal(decoded.workspaceGeneration, 7);
  assert.equal(decoded.runtimeExpiresAt, "2026-08-08T00:00:31.000Z");
  assert.equal(decoded.rowVersion, 4);
  assert.equal(Object.hasOwn(decoded, "state"), false);
  assert.throws(() => decodeAgentSessionItem(agentSession({ process_state: "healthy" })));
  assert.throws(() => decodeAgentSessionItem(agentSession({ row_version: -1 })));
  assert.throws(() => decodeAgentSessionItem(agentSession({ workspace_generation: undefined })));
  assert.throws(() => decodeAgentSessionItem(agentSession({ workspace_generation: 0 })));
  assert.throws(() => decodeAgentSessionItem(agentSession({
    workspace_binding_id: undefined,
    workspace_id: "33333333-3333-4333-8333-333333333333",
  })));
  assert.throws(() => decodeAgentSessionItem(agentSession({ internal_provider: "forbidden" })));
});

function agentSessionAuth(overrides = {}) {
  return {
    observation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agent_session_id: "11111111-1111-4111-8111-111111111111",
    process_epoch: "33333333-3333-4333-8333-333333333333",
    auth_mode: "interactive_login",
    agent_version: "2.1.226",
    adapter_version: "runa.agent-auth.v1",
    evidence_class: "provider_cli_login_status",
    observed_at: "2026-08-08T00:00:01.000Z",
    valid_until: "2026-08-08T00:00:31.000Z",
    state: "authenticated",
    ...overrides,
  };
}

test("AgentSession authentication evidence is closed, fresh, and process-scoped", () => {
  const decoded = decodeAgentSessionAuth(agentSessionAuth());
  assert.equal(decoded.agentSessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(decoded.processEpoch, "33333333-3333-4333-8333-333333333333");
  assert.equal(decoded.state, "authenticated");
  assert.equal(decoded.validUntil, "2026-08-08T00:00:31.000Z");
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ state: "signed_in" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ process_epoch: "not-an-epoch" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ valid_until: "2026-08-07T23:59:59.000Z" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ valid_until: "2026-08-08T00:00:31.001Z" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ adapter_version: "runa.agent-auth.v1-local" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ agent_version: "2.1.226-local" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ valid_until: "2026-08-08T00:00:01.000Z" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ credential_path: "/root/.codex/auth.json" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "authenticated",
    evidence_class: "insufficient",
  })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "configured",
    auth_mode: "interactive_login",
    evidence_class: "credential_binding_authority",
  })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "login_required",
    process_epoch: null,
  })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "unavailable",
    evidence_class: "provider_cli_login_status",
    valid_until: "2026-08-08T00:00:01.000Z",
  })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "unavailable",
    evidence_class: "insufficient",
  })));
  const unavailable = decodeAgentSessionAuth(agentSessionAuth({
    state: "unavailable",
    evidence_class: "insufficient",
    agent_version: "unavailable",
    process_epoch: null,
    valid_until: "2026-08-08T00:00:01.000Z",
  }));
  assert.equal(unavailable.state, "unavailable");
});

test("AgentSession auth client uses the child route and rejects sibling evidence", async () => {
  const requested = "11111111-1111-4111-8111-111111111111";
  const requests = [];
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return agentSessionAuth();
    },
  });
  const status = await client.getAgentSessionAuth(requested);
  assert.equal(status.state, "authenticated");
  assert.deepEqual(requests, [{ method: "GET", path: `/v1/agent-sessions/${requested}/agent-auth` }]);

  const sibling = createRunaApiClient({
    async request() {
      return agentSessionAuth({ agent_session_id: "44444444-4444-4444-8444-444444444444" });
    },
  });
  await assert.rejects(
    sibling.getAgentSessionAuth(requested),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
});

function agentSessionAuthLogout(overrides = {}) {
  return {
    observation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agent_session_id: "11111111-1111-4111-8111-111111111111",
    process_epoch: "33333333-3333-4333-8333-333333333333",
    auth_mode: "interactive_login",
    agent: "claude-code",
    agent_version: "2.1.226",
    adapter_version: "runa.agent-auth.v1",
    observed_at: "2026-08-08T00:00:01.000Z",
    outcome: "logout_confirmed",
    ...overrides,
  };
}

test("AgentSession provider logout sends and confirms one exact process generation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const epoch = "33333333-3333-4333-8333-333333333333";
  const requests = [];
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return agentSessionAuthLogout();
    },
  });
  const receipt = await client.logoutAgentSessionAuth(id, epoch);
  assert.equal(receipt.outcome, "logout_confirmed");
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/agent-sessions/${id}/agent-auth/logout`,
    body: { process_epoch: epoch },
  }]);
  const sibling = createRunaApiClient({
    async request() {
      return agentSessionAuthLogout({ process_epoch: "44444444-4444-4444-8444-444444444444" });
    },
  });
  await assert.rejects(
    sibling.logoutAgentSessionAuth(id, epoch),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
  assert.throws(() => decodeAgentSessionAuthLogout(agentSessionAuthLogout({ principal_uid: 63001 })));
});

test("AgentSession create recovery uses the original idempotency key on a read-only authority", async () => {
  const requests = [];
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return agentSession();
    },
  });
  const recovered = await client.inspectAgentSessionCreate("stable-agent-create-key");
  assert.equal(recovered.id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(requests, [{
    method: "GET",
    path: "/v1/agent-session-creates",
    idempotencyKey: "stable-agent-create-key",
  }]);
  await assert.rejects(
    client.inspectAgentSessionCreate("short"),
    (error) => error instanceof RunaError && error.code === "runa.usage.invalid",
  );
  assert.equal(requests.length, 1);
});

test("AgentSession client sends bounded pagination, complete create intent, and exact rename path", async () => {
  const requests = [];
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      if (request.method === "GET" && request.path.includes("/agent-sessions")) {
        return { items: [agentSession()], next_cursor: "next-opaque" };
      }
      return agentSession({ name: request.body?.name ?? "primary" });
    },
  });
  const machineId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const page = await client.listAgentSessions(machineId, { limit: 25, cursor: "cursor-opaque" });
  assert.equal(page.nextCursor, "next-opaque");
  await client.createAgentSession(machineId, {
    name: "review",
    agent: "codex",
    cwd: "/workspace/repo",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
    authMode: "credential_binding",
    credentialBindingId: "44444444-4444-4444-8444-444444444444",
  }, "operation-1");
  const renamed = await client.renameAgentSession(sessionId, "renamed");
  assert.equal(renamed.name, "renamed");
  assert.deepEqual(requests[0].query, { limit: "25", cursor: "cursor-opaque" });
  assert.deepEqual(requests[1].body, {
    name: "review",
    agent: "codex",
    cwd: "/workspace/repo",
    workspace_binding_id: "33333333-3333-4333-8333-333333333333",
    workspace_generation: 7,
    auth_mode: "credential_binding",
    credential_binding_id: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal(requests[1].idempotencyKey, "operation-1");
  assert.equal(requests[2].method, "PATCH");
  assert.equal(requests[2].path, `/v1/agent-sessions/${sessionId}`);
  assert.deepEqual(requests[2].body, { name: "renamed" });
});

test("AgentSession client rejects malformed page and auth bindings before transport", async () => {
  let requests = 0;
  const client = createRunaApiClient({ async request() { requests += 1; return {}; } });
  const machineId = "22222222-2222-4222-8222-222222222222";
  await assert.rejects(client.listAgentSessions(machineId, { limit: 0 }), RunaError);
  await assert.rejects(client.listAgentSessions(machineId, { cursor: "bad\nvalue" }), RunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace/../escape",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
  }, "operation-1"), RunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
    authMode: "credential_binding",
  }, "operation-2"), RunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 0,
  }, "operation-3"), RunaError);
  await assert.rejects(client.renameAgentSession(
    "11111111-1111-4111-8111-111111111111",
    "",
  ), RunaError);
  assert.equal(requests, 0);
});

test("AgentSession client rejects producer responses bound to a sibling resource", async () => {
  const requestedMachine = "22222222-2222-4222-8222-222222222222";
  const requestedSession = "11111111-1111-4111-8111-111111111111";
  const siblingMachine = "33333333-3333-4333-8333-333333333333";
  const siblingSession = "44444444-4444-4444-8444-444444444444";

  const machineMismatch = createRunaApiClient({
    async request(request) {
      if (request.method === "GET") return { items: [agentSession({ machine_id: siblingMachine })] };
      return agentSession({ machine_id: siblingMachine });
    },
  });
  await assert.rejects(
    machineMismatch.listAgentSessions(requestedMachine),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
  await assert.rejects(
    machineMismatch.createAgentSession(requestedMachine, {
      agent: "claude-code",
      cwd: "/workspace",
      workspaceBindingId: "33333333-3333-4333-8333-333333333333",
      workspaceGeneration: 7,
    }, "operation-sibling"),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );

  const workspaceMismatch = createRunaApiClient({
    async request() {
      return agentSession({ workspace_binding_id: "55555555-5555-4555-8555-555555555555" });
    },
  });
  await assert.rejects(
    workspaceMismatch.createAgentSession(requestedMachine, {
      agent: "claude-code",
      cwd: "/workspace",
      workspaceBindingId: "33333333-3333-4333-8333-333333333333",
      workspaceGeneration: 7,
    }, "operation-workspace-substitution"),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );

  const sessionMismatch = createRunaApiClient({
    async request() { return agentSession({ id: siblingSession }); },
  });
  await assert.rejects(
    sessionMismatch.getAgentSession(requestedSession),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
  await assert.rejects(
    sessionMismatch.renameAgentSession(requestedSession, "renamed"),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
  await assert.rejects(
    sessionMismatch.terminateAgentSession(requestedSession),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
});

function terminalGrant(overrides = {}) {
  const terminalSessionId = "55555555-5555-4555-8555-555555555555";
  return {
    terminal_session_id: terminalSessionId,
    resume_handle: "66666666-6666-4666-8666-666666666666",
    connect_url: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
    connect_token: `runa_tc_${"A".repeat(43)}`,
    protocol: "runa.terminal.v1",
    capabilities: [
      { name: "acknowledgement", availability: "supported" },
      { name: "heartbeat", availability: "supported" },
      { name: "live_resize", availability: "unknown" },
      { name: "resume", availability: "supported" },
      { name: "signals", availability: "unsupported" },
    ],
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("terminal grant decoder is closed, complete, and secret-url separated", () => {
  const decoded = decodeTerminalConnectionGrant(terminalGrant());
  assert.equal(decoded.protocol, "runa.terminal.v1");
  assert.equal(decoded.capabilities.length, 5);
  assert.equal(decoded.connectUrl.includes(decoded.connectToken), false);
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({ tenant_id: "forbidden" })));
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    connect_url: `wss://api.getcuna.com/v1/terminal-connections/55555555-5555-4555-8555-555555555555/stream?token=secret`,
  })));
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    capabilities: terminalGrant().capabilities.slice(0, 4),
  })));
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    capabilities: [
      ...terminalGrant().capabilities.slice(0, 4),
      { name: "resume", availability: "supported" },
    ],
  })));
});

test("terminal grant client sends exact idempotent intent and rejects unsafe inputs before transport", async () => {
  const requests = [];
  const client = createRunaApiClient({
    async request(request) {
      requests.push(request);
      return terminalGrant();
    },
  });
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const grant = await client.createTerminalConnection(sessionId, {
    protocol: "runa.terminal.v1",
    clientInstanceId: "windows-cli-01",
    resumeHandle: "66666666-6666-4666-8666-666666666666",
  }, "terminal-operation-1");
  assert.equal(grant.terminalSessionId, "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(requests[0], {
    method: "POST",
    path: `/v1/agent-sessions/${sessionId}/terminal-connections`,
    body: {
      protocol: "runa.terminal.v1",
      client_instance_id: "windows-cli-01",
      resume_handle: "66666666-6666-4666-8666-666666666666",
    },
    idempotencyKey: "terminal-operation-1",
  });
  await assert.rejects(
    client.createTerminalConnection(sessionId, {
      protocol: "runa.terminal.v1",
      clientInstanceId: "contains space",
    }, "terminal-operation-2"),
    RunaError,
  );
  await assert.rejects(
    client.createTerminalConnection(sessionId, {
      protocol: "runa.terminal.v1",
      clientInstanceId: "safe",
      resumeHandle: "not-a-uuid",
    }, "terminal-operation-3"),
    RunaError,
  );
  assert.equal(requests.length, 1);
});

test("machine client enforces canonical create bounds before transport", async () => {
  let requests = 0;
  const client = createRunaApiClient({ async request() { requests += 1; return {}; } });
  await assert.rejects(client.createMachine({ name: "dev" }, "short"), RunaError);
  await assert.rejects(client.createMachine({ name: "" }, "operation-1"), RunaError);
  await assert.rejects(client.createMachine({ name: "dev", vcpus: 9 }, "operation-2"), RunaError);
  await assert.rejects(client.createMachine({ name: "dev", memoryMiB: 511 }, "operation-3"), RunaError);
  assert.equal(requests, 0);
});

test("machine transition rejects a producer response bound to a sibling machine", async () => {
  const requested = "22222222-2222-4222-8222-222222222222";
  const sibling = "33333333-3333-4333-8333-333333333333";
  const client = createRunaApiClient({
    async request() { return { id: sibling, name: "sibling", status: "running" }; },
  });
  await assert.rejects(
    client.transitionMachine(requested, "start"),
    (error) => error instanceof RunaError && error.code === "runa.remote.malformed_response",
  );
});

test("legacy array shape remains safe while canonical machine identity is enforced", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const page = decodeMachinePage([{ id, name: "dev", status: "running", memory_mib: 512, vcpus: 1, url: "https://internal.invalid" }]);
  assert.deepEqual(page, { items: [{ id, name: "dev", state: "running", vcpus: 1, memoryMiB: 512 }] });
  assert.equal(JSON.stringify(page).includes("internal.invalid"), false);
  assert.throws(() => decodeMachinePage([{ id: "m_1", name: "legacy", status: "running" }]));
});

test("HTTP transport binds origin, authorization, idempotency, and public path", async () => {
  let observed;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async (url, init) => {
      observed = { url: url.toString(), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const createRequestId = "11111111-1111-4111-8111-111111111111";
  await transport.request({ method: "POST", path: "/v1/sessions", body: { name: "x" }, idempotencyKey: "op_1", machineCreateRequestId: createRequestId });
  assert.equal(observed.url, "https://api.getcuna.com/v1/sessions");
  assert.equal(observed.init.headers.Authorization, "Bearer cuna_sk_abcdefghijklmnop");
  assert.equal(observed.init.headers["Idempotency-Key"], "op_1");
  assert.equal(observed.init.headers["X-Cuna-Machine-Create-Request-Id"], createRequestId);
  assert.equal(observed.init.headers.Accept, "application/json, application/problem+json");
});

test("Cuna transport emits only the canonical pre-GA authority names", async () => {
  const observations = [];
  const fetch = async (url, init) => {
    observations.push({ url: url.toString(), headers: init.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch,
  }).request({ method: "GET", path: "/v1/sessions", continuationSecret: `cuna_ct_${"c".repeat(43)}` });
  assert.equal(observations[0].url, "https://api.getcuna.com/v1/sessions");
  assert.equal(observations[0].headers["User-Agent"].startsWith("cuna-cli/"), true);
  assert.equal(observations[0].headers["X-Cuna-Continuation"].startsWith("cuna_ct_"), true);
  assert.equal(observations[0].headers["X-Runa-Continuation"], undefined);
  assert.equal(observations.length, 1);
});

test("pre-aborted HTTP requests perform no fetch effect", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancel-before-dispatch"));
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/sessions", signal: controller.signal }),
    (error) => error instanceof RunaError && error.code === "runa.network.cancelled",
  );
  assert.equal(calls, 0);
});

test("HTTP timeout retryability fails closed for requests with ambiguous side effects", async () => {
  const fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 5,
    fetch,
  });

  for (const request of [
    { method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" },
    { method: "DELETE", path: "/v1/sessions/m_1" },
  ]) {
    await assert.rejects(
      transport.request(request),
      (error) => error instanceof RunaError && error.code === "runa.network.timeout" && error.retryable === false,
    );
  }

  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/sessions" }),
    (error) => error instanceof RunaError && error.code === "runa.network.timeout" && error.retryable === true,
  );
});

test("HTTP errors expose only stable safe metadata", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({ code: "policy_denied", message: "raw secret cuna_sk_bad" }), {
      status: 403,
      headers: { "x-request-id": "req_safe" },
    }),
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/sessions/m_1/stop" }),
    (error) => error instanceof RunaError && error.code === "runa.policy.denied" && JSON.stringify(error.details).includes("cuna_sk_bad") === false,
  );
});

test("HTTP errors preserve retryability only from a closed canonical Problem", async () => {
  const requestId = "66666666-6666-4666-8666-666666666666";
  const makeTransport = (status, retryable, overrides = {}) => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/request_failed",
      title: "Request failed",
      status,
      code: "request_failed",
      request_id: requestId,
      retryable,
      ...overrides,
    }), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "untrusted-header" },
    }),
  });

  await assert.rejects(
    makeTransport(503, false).request({ method: "GET", path: "/v1/capabilities" }),
    (error) => error instanceof RunaError &&
      error.code === "runa.network.service_unavailable" &&
      error.retryable === false &&
      error.details?.reason === "request_failed" &&
      error.details?.request_id === requestId,
  );
  await assert.rejects(
    makeTransport(400, true).request({ method: "GET", path: "/v1/capabilities" }),
    (error) => error instanceof RunaError &&
      error.code === "runa.remote.rejected" &&
      error.retryable === true,
  );
  await assert.rejects(
    makeTransport(503, false, { provider: "forbidden" }).request({
      method: "GET",
      path: "/v1/capabilities",
    }),
    (error) => error instanceof RunaError &&
      error.retryable === true &&
      error.details?.request_id === "untrusted-header",
  );
});

test("workspace sync Problems preserve only the negotiated protocol and canonical capability vector", async () => {
  const requestId = "77777777-7777-4777-8777-777777777777";
  const capabilities = [
    "atomic_generation_commit",
    "bounded_manifest_pages",
    "content_digest_verification",
    "explicit_reconciliation",
    "ordered_generation_changes",
    "policy_bound_admission",
  ];
  const makeTransport = (status, overrides = {}) => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/workspace_sync_protocol_incompatible",
      title: "Workspace sync protocol incompatible",
      status,
      code: "workspace_sync_protocol_incompatible",
      request_id: requestId,
      retryable: status >= 500,
      action: status >= 500 ? "retry" : "none",
      detail: "The requested workspace sync protocol is not available.",
      selected_protocol: status >= 500 ? null : 2,
      capabilities: status >= 500 ? [] : capabilities,
      ...overrides,
    }), {
      status,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "x-request-id": "untrusted-header",
      },
    }),
  });

  await assert.rejects(
    makeTransport(426).request({ method: "POST", path: "/v1/workspaces/w_1/sync-sessions" }),
    (error) => error instanceof RunaError &&
      error.code === "runa.remote.rejected" &&
      error.retryable === false &&
      error.details?.reason === "workspace_sync_protocol_incompatible" &&
      error.details?.selected_protocol === 2 &&
      JSON.stringify(error.details?.capabilities) === JSON.stringify(capabilities) &&
      error.details?.request_id === requestId,
  );
  await assert.rejects(
    makeTransport(503).request({ method: "GET", path: "/v1/workspaces/w_1/sync-sessions/a_1/changes" }),
    (error) => error instanceof RunaError &&
      error.code === "runa.network.service_unavailable" &&
      error.retryable === true &&
      error.details?.selected_protocol === null &&
      Array.isArray(error.details?.capabilities) &&
      error.details.capabilities.length === 0 &&
      error.details?.request_id === requestId,
  );

  for (const malformed of [
    { selected_protocol: null, capabilities },
    { selected_protocol: 2, capabilities: capabilities.slice(0, -1) },
    { selected_protocol: 2, capabilities: [capabilities[1], capabilities[0], ...capabilities.slice(2)] },
  ]) {
    await assert.rejects(
      makeTransport(503, malformed).request({ method: "GET", path: "/v1/workspaces/w_1/sync-sessions/a_1/changes" }),
      (error) => error instanceof RunaError &&
        error.code === "runa.network.service_unavailable" &&
        error.retryable === true &&
        error.details?.request_id === "untrusted-header" &&
        error.details?.selected_protocol === undefined &&
        error.details?.capabilities === undefined,
    );
  }
});

test("invalid public IDs never reach transport (property-style adversarial corpus)", async () => {
  let calls = 0;
  const client = createRunaApiClient({ async request() { calls += 1; return {}; } });
  for (const candidate of ["", "../x", "a/b", "a?b", " a", "a b", "💥", "x".repeat(129)]) {
    await assert.rejects(client.getAgentSession(candidate), RunaError);
  }
  assert.equal(calls, 0);
});
