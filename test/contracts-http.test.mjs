import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ORIGINS,
  API_WEBSOCKET_ORIGINS,
  CREDENTIAL_BRANDS,
  createHttpTransport,
  createCunaApiClient,
  decodeApiKeyCreation,
  decodeApiKeyList,
  decodeAuditRecords,
  decodeAgentSessionItem,
  decodeAgentSessionAuth,
  decodeAgentSessionAuthLogout,
  decodeAgentSessionTerminalSeat,
  decodeCapabilitySnapshot,
  decodeCredentialRules,
  decodeMachinePage,
  decodeCunaIdentity,
  MACHINE_LIFECYCLE_REQUEST_BUDGET_MS,
  decodeTerminalConnectionGrant,
  decideCapability,
  requireCapability,
  ContractViolation,
  CunaError,
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
    // The predicate token and the field, not prose: this is what now reaches the
    // user as `details.predicate` / `details.field`.
    /supported_schema_version at schema_version/u,
  );
  const excessive = decodeCapabilitySnapshot({
    ...snapshot([capability()]),
    expires_at: "2026-08-08T00:02:00.001Z",
  });
  assert.equal(decideCapability(excessive, "machines.create", Date.parse("2026-08-08T00:00:00Z")).status, "unknown");
});

test("Cuna identity decoder is closed and preserves only public account authority", () => {
  const decoded = decodeCunaIdentity({
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
  assert.deepEqual(decodeCunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: { assigned: false, waitlist_position: 7 },
  }), {
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspaceAssigned: false,
    waitlistPosition: 7,
  });
  assert.throws(() => decodeCunaIdentity({
    id: "not-a-uuid",
    email: "developer@example.test",
    workspace: { assigned: false, waitlist_position: 1 },
  }));
  assert.throws(() => decodeCunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      id: "22222222-2222-4222-8222-222222222222",
      usage: {},
    },
    tenant_id: "forbidden",
  }));
  // This is the exact body production serves today: `workspace.id` omitted while
  // `assigned` is true. It must be rejected, and the rejection must NAME the
  // field — the old message said "Malformed Cuna workspace identity" for any of
  // ten different faults, and finding which one required a throwaway script.
  assert.throws(() => decodeCunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "estimate" },
    },
  }), (error) => error instanceof ContractViolation &&
    error.field === "workspace.id" &&
    error.predicate === "required_when_workspace_assigned");

  // A sibling fault under the same subtree must name a DIFFERENT field. Without
  // this row, one hard-coded `field` would satisfy the assertion above.
  assert.throws(() => decodeCunaIdentity({
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspace: {
      assigned: true,
      id: "22222222-2222-4222-8222-222222222222",
      usage: { est_spend_usd: 1, est_remaining_usd: 49, note: 7 },
    },
  }), (error) => error instanceof ContractViolation &&
    error.field === "workspace.usage.note" &&
    error.predicate === "string");
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
  const client = createCunaApiClient({
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
  const client = createCunaApiClient({
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

  const substituted = createCunaApiClient({
    async request() {
      return { ...machine, id: "33333333-3333-4333-8333-333333333333" };
    },
  });
  await assert.rejects(
    substituted.getMachine(machineId),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
});

test("machine list uses the public unpaginated route without invented query parameters", async () => {
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return [];
    },
  });
  const page = await client.listMachines();
  assert.deepEqual(page.items, []);
  assert.deepEqual(requests, [{
    method: "GET",
    path: "/v1/sessions",
  }]);
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

// `display_prefix` is read straight from the key row. Every row created before
// the rename carries `runa_sk_`, so a single-brand pin here made `key list`
// raise on every existing key instead of listing it.
test("API-key display metadata decodes every brand the key store has ever stored", () => {
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
  // Literal floor: a loop over CREDENTIAL_BRANDS alone stays green when the
  // list shrinks, which is the exact failure being regressed against.
  assert.ok(CREDENTIAL_BRANDS.includes("cuna"));
  assert.ok(CREDENTIAL_BRANDS.includes("runa"));
  for (const brand of new Set(["cuna", "runa", ...CREDENTIAL_BRANDS])) {
    const prefix = `${brand}_sk_`;
    assert.equal(
      decodeApiKeyList([{ ...metadata, prefix }])[0].prefix,
      prefix,
      prefix,
    );
    assert.equal(
      decodeApiKeyList([{ ...metadata, prefix: `${prefix}abcd` }])[0].prefix,
      `${prefix}abcd`,
      `${prefix}abcd`,
    );
  }
  assert.throws(() => decodeApiKeyList([{ ...metadata, prefix: "evil_sk_abcd" }]));
  assert.throws(() => decodeApiKeyList([{ ...metadata, prefix: "cuna_at_abcd" }]));
});

test("TC-037-03 API-key create, list and revoke use exact public routes and closed acknowledgement", async () => {
  const requests = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const created = {
    id,
    name: "local automation",
    prefix: "cuna_sk_",
    last_four: "WXYZ",
    created_at: "2026-08-08T00:00:00.000Z",
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    idempotency_replayed: false,
    key: `cuna_sk_${"a".repeat(16)}WXYZ`,
  };
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return request.method === "GET" ? [] : request.method === "POST" ? created : { ok: true };
    },
  });
  assert.equal((await client.createApiKey({ name: "local automation" })).key, created.key);
  await client.listApiKeys();
  assert.equal(await client.revokeApiKey(id), true);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "POST", path: "/v1/api-keys" },
    { method: "GET", path: "/v1/api-keys" },
    { method: "DELETE", path: `/v1/api-keys/${id}` },
  ]);
  await assert.rejects(client.revokeApiKey("invalid"));
  assert.equal(requests.length, 3);
  assert.throws(() => decodeApiKeyCreation({ ...created, key: "not-a-credential" }));
  assert.throws(() => decodeApiKeyCreation({ ...created, last_four: "ABCD" }));
  const { key: _omitted, ...replayed } = created;
  assert.equal(decodeApiKeyCreation({ ...replayed, idempotency_replayed: true }).idempotencyReplayed, true);
  assert.throws(() => decodeApiKeyCreation({ ...created, idempotency_replayed: true }));
  assert.throws(() => decodeApiKeyCreation({ ...replayed, idempotency_replayed: false }));
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
  const legacyOpenCode = decodeAgentSessionItem(agentSession({
    agent: "opencode",
    auth_mode: "credential_binding",
  }));
  assert.equal(legacyOpenCode.agent, "opencode");
  assert.equal(legacyOpenCode.authMode, "credential_binding");
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
    agent: "claude-code",
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
  assert.equal(decoded.agent, "claude-code");
  assert.equal(decoded.processEpoch, "33333333-3333-4333-8333-333333333333");
  assert.equal(decoded.state, "authenticated");
  assert.equal(decoded.validUntil, "2026-08-08T00:00:31.000Z");
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ state: "signed_in" })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ process_epoch: "not-an-epoch" })));
  const { agent: _agent, ...withoutAgent } = agentSessionAuth();
  assert.throws(() => decodeAgentSessionAuth(withoutAgent));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({ agent: "unknown-agent" })));
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
  const opencodeConfigured = decodeAgentSessionAuth(agentSessionAuth({
    agent: "opencode",
    agent_version: "1.18.23",
    state: "configured",
    auth_mode: "interactive_login",
    evidence_class: "provider_cli_credential_presence",
  }));
  assert.equal(opencodeConfigured.state, "configured");
  const opencodeLoginRequired = decodeAgentSessionAuth(agentSessionAuth({
    agent: "opencode",
    agent_version: "1.18.23",
    state: "login_required",
    auth_mode: "interactive_login",
    evidence_class: "provider_cli_credential_presence",
  }));
  assert.equal(opencodeLoginRequired.state, "login_required");
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    agent: "codex",
    agent_version: "0.147.0",
    state: "authenticated",
    auth_mode: "interactive_login",
    evidence_class: "provider_cli_login_status",
  })));
  assert.throws(() => decodeAgentSessionAuth(agentSessionAuth({
    state: "authenticated",
    auth_mode: "interactive_login",
    evidence_class: "provider_cli_credential_presence",
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
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return agentSessionAuth();
    },
  });
  const status = await client.getAgentSessionAuth(requested);
  assert.equal(status.state, "authenticated");
  assert.deepEqual(requests, [{ method: "GET", path: `/v1/agent-sessions/${requested}/agent-auth` }]);

  const sibling = createCunaApiClient({
    async request() {
      return agentSessionAuth({ agent_session_id: "44444444-4444-4444-8444-444444444444" });
    },
  });
  await assert.rejects(
    sibling.getAgentSessionAuth(requested),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
});

function terminalSeat(overrides = {}) {
  return {
    agent_session_id: "11111111-1111-4111-8111-111111111111",
    process_epoch: "33333333-3333-4333-8333-333333333333",
    state: "available",
    unavailable_reason: null,
    writer_epoch: 2,
    writer_client_instance_id: "cli:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    writer_attached: true,
    writer_attached_at: "2026-09-02T00:00:00.500Z",
    writer_detached_at: null,
    observed_at: "2026-09-02T00:00:01.000Z",
    ...overrides,
  };
}

test("terminal seat decoder accepts every producer state and is closed", () => {
  const held = decodeAgentSessionTerminalSeat(terminalSeat());
  assert.deepEqual(held, {
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    processEpoch: "33333333-3333-4333-8333-333333333333",
    state: "available",
    unavailableReason: null,
    writerEpoch: 2,
    writerClientInstanceId: "cli:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    writerAttached: true,
    writerAttachedAt: "2026-09-02T00:00:00.500Z",
    writerDetachedAt: null,
    observedAt: "2026-09-02T00:00:01.000Z",
  });
  assert.equal(Object.isFrozen(held), true);
  const free = decodeAgentSessionTerminalSeat(terminalSeat({
    writer_client_instance_id: null, writer_attached: false, writer_attached_at: null,
  }));
  assert.equal(free.writerClientInstanceId, null);
  assert.equal(free.writerAttached, false);
  // The writer this seat still names has gone: the terminal is reusable.
  const detached = decodeAgentSessionTerminalSeat(terminalSeat({
    writer_attached: false, writer_detached_at: "2026-09-02T00:00:00.900Z",
  }));
  assert.equal(detached.writerAttached, false);
  assert.equal(detached.writerDetachedAt, "2026-09-02T00:00:00.900Z");
  const none = decodeAgentSessionTerminalSeat(terminalSeat({
    process_epoch: null, state: "none", writer_epoch: 0, writer_client_instance_id: null,
    writer_attached: false, writer_attached_at: null,
  }));
  assert.equal(none.state, "none");
  assert.equal(none.processEpoch, null);
  assert.equal(none.writerEpoch, 0);
  const unrecoverable = decodeAgentSessionTerminalSeat(terminalSeat({
    state: "owner_unrecoverable", unavailable_reason: "master_not_attested",
  }));
  assert.equal(unrecoverable.state, "owner_unrecoverable");
  assert.equal(unrecoverable.unavailableReason, "master_not_attested");

  const { observed_at: _dropped, ...missing } = terminalSeat();
  for (const [label, shape, predicate] of [
    ["not an object", "seat", "object"],
    ["unknown field", terminalSeat({ attachments: 1 }), "exact_key_set"],
    ["missing field", missing, "exact_key_set"],
    ["non-uuid session id", terminalSeat({ agent_session_id: "session-1" }), "canonical_uuid"],
    ["non-uuid process epoch", terminalSeat({ process_epoch: "epoch" }), "canonical_uuid_or_null"],
    ["unknown state", terminalSeat({ state: "busy" }), "known_enum_value"],
    ["numeric reason", terminalSeat({ unavailable_reason: 7 }), "string_or_null"],
    ["negative writer epoch", terminalSeat({ writer_epoch: -1 }), "non_negative_integer"],
    ["string writer epoch", terminalSeat({ writer_epoch: "2" }), "non_negative_integer"],
    ["unsafe holder", terminalSeat({ writer_client_instance_id: "cli one\n" }), "client_instance_id_or_null"],
    ["undefined holder", terminalSeat({ writer_client_instance_id: undefined }), "client_instance_id_or_null"],
    ["unparseable timestamp", terminalSeat({ observed_at: "yesterday" }), "timestamp"],
    ["non-boolean liveness", terminalSeat({ writer_attached: "yes" }), "boolean"],
    ["missing liveness", terminalSeat({ writer_attached: undefined }), "boolean"],
    ["attached with nobody holding the seat", terminalSeat({ writer_client_instance_id: null }),
      "writer_attached_without_writer"],
    ["unparseable attach time", terminalSeat({ writer_attached_at: "recently" }), "timestamp_or_null"],
    ["unparseable detach time", terminalSeat({ writer_detached_at: 7 }), "timestamp_or_null"],
  ]) {
    assert.throws(
      () => decodeAgentSessionTerminalSeat(shape),
      (error) => error instanceof ContractViolation && error.predicate === predicate,
      label,
    );
  }
});

test("terminal seat client reads the exact child route and rejects a sibling's seat", async () => {
  const requested = "11111111-1111-4111-8111-111111111111";
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return terminalSeat();
    },
  });
  const seat = await client.getAgentSessionTerminalSeat(requested);
  assert.equal(seat.writerEpoch, 2);
  assert.deepEqual(requests, [{ method: "GET", path: `/v1/agent-sessions/${requested}/terminal` }]);

  await assert.rejects(
    client.getAgentSessionTerminalSeat("not-a-uuid"),
    (error) => error instanceof CunaError && error.code === "cuna.usage.invalid",
  );
  assert.equal(requests.length, 1);

  const sibling = createCunaApiClient({
    async request() {
      return terminalSeat({ agent_session_id: "44444444-4444-4444-8444-444444444444" });
    },
  });
  await assert.rejects(
    sibling.getAgentSessionTerminalSeat(requested),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      error.details?.operation === `GET /v1/agent-sessions/${requested}/terminal` &&
      error.details?.field === "agent_session_id",
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
  const client = createCunaApiClient({
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
  const sibling = createCunaApiClient({
    async request() {
      return agentSessionAuthLogout({ process_epoch: "44444444-4444-4444-8444-444444444444" });
    },
  });
  await assert.rejects(
    sibling.logoutAgentSessionAuth(id, epoch),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
  assert.throws(() => decodeAgentSessionAuthLogout(agentSessionAuthLogout({ principal_uid: 63001 })));
});

test("AgentSession create recovery uses the original idempotency key on a read-only authority", async () => {
  const requests = [];
  const client = createCunaApiClient({
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
    (error) => error instanceof CunaError && error.code === "cuna.usage.invalid",
  );
  assert.equal(requests.length, 1);
});

test("AgentSession client sends bounded pagination, complete create intent, and exact rename path", async () => {
  const requests = [];
  const client = createCunaApiClient({
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

test("OpenCode AgentSession client requires and serializes interactive login", async () => {
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return agentSession({ agent: request.body?.agent, auth_mode: request.body?.auth_mode });
    },
  });
  const machineId = "22222222-2222-4222-8222-222222222222";
  const input = {
    agent: "opencode",
    cwd: "/workspace/repo",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
  };
  await client.createAgentSession(machineId, {
    ...input,
    authMode: "interactive_login",
  }, "opencode-interactive-create");
  assert.deepEqual(requests[0].body, {
    agent: "opencode",
    cwd: "/workspace/repo",
    workspace_binding_id: "33333333-3333-4333-8333-333333333333",
    workspace_generation: 7,
    auth_mode: "interactive_login",
  });
  await assert.rejects(
    client.createAgentSession(machineId, input, "opencode-missing-auth"),
    CunaError,
  );
  await assert.rejects(
    client.createAgentSession(machineId, {
      ...input,
      authMode: "credential_binding",
      credentialBindingId: "44444444-4444-4444-8444-444444444444",
    }, "opencode-credential-binding"),
    CunaError,
  );
  assert.equal(requests.length, 1);
});

test("AgentSession client rejects malformed page and auth bindings before transport", async () => {
  let requests = 0;
  const client = createCunaApiClient({ async request() { requests += 1; return {}; } });
  const machineId = "22222222-2222-4222-8222-222222222222";
  await assert.rejects(client.listAgentSessions(machineId, { limit: 0 }), CunaError);
  await assert.rejects(client.listAgentSessions(machineId, { cursor: "bad\nvalue" }), CunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace/../escape",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
  }, "operation-1"), CunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
    authMode: "credential_binding",
  }, "operation-2"), CunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 0,
  }, "operation-3"), CunaError);
  await assert.rejects(client.renameAgentSession(
    "11111111-1111-4111-8111-111111111111",
    "",
  ), CunaError);
  assert.equal(requests, 0);
});

test("AgentSession client rejects producer responses bound to a sibling resource", async () => {
  const requestedMachine = "22222222-2222-4222-8222-222222222222";
  const requestedSession = "11111111-1111-4111-8111-111111111111";
  const siblingMachine = "33333333-3333-4333-8333-333333333333";
  const siblingSession = "44444444-4444-4444-8444-444444444444";

  const machineMismatch = createCunaApiClient({
    async request(request) {
      if (request.method === "GET") return { items: [agentSession({ machine_id: siblingMachine })] };
      return agentSession({ machine_id: siblingMachine });
    },
  });
  await assert.rejects(
    machineMismatch.listAgentSessions(requestedMachine),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
  await assert.rejects(
    machineMismatch.createAgentSession(requestedMachine, {
      agent: "claude-code",
      cwd: "/workspace",
      workspaceBindingId: "33333333-3333-4333-8333-333333333333",
      workspaceGeneration: 7,
    }, "operation-sibling"),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );

  const workspaceMismatch = createCunaApiClient({
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
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );

  const sessionMismatch = createCunaApiClient({
    async request() { return agentSession({ id: siblingSession }); },
  });
  await assert.rejects(
    sessionMismatch.getAgentSession(requestedSession),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
  await assert.rejects(
    sessionMismatch.renameAgentSession(requestedSession, "renamed"),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
  await assert.rejects(
    sessionMismatch.terminateAgentSession(requestedSession),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
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

// The grant is minted by whichever API host is deployed and the token brand is
// on the "free to rename" list. Pinning either to one brand breaks the terminal
// with no window: `cuna terminal` is a hard failure, not a degraded path.
test("terminal grant decoder admits every minted connect origin and token brand", () => {
  const terminalSessionId = "55555555-5555-4555-8555-555555555555";
  // Literal floor: production mints the grant under whichever API host is
  // deployed, and the token brand is on the "free to rename" list. Neither
  // list may shrink, and a loop over them alone would not notice.
  assert.ok(API_WEBSOCKET_ORIGINS.includes("wss://api.getcuna.com"));
  assert.ok(API_WEBSOCKET_ORIGINS.includes("wss://api.runacode.io"));
  for (const origin of new Set([
    "wss://api.getcuna.com", "wss://api.runacode.io", ...API_WEBSOCKET_ORIGINS,
  ])) {
    for (const brand of new Set(["cuna", "runa", ...CREDENTIAL_BRANDS])) {
      const grant = terminalGrant({
        connect_url: `${origin}/v1/terminal-connections/${terminalSessionId}/stream`,
        connect_token: `${brand}_tc_${"A".repeat(43)}`,
      });
      const decoded = decodeTerminalConnectionGrant(grant);
      assert.equal(decoded.connectUrl, grant.connect_url, grant.connect_url);
      assert.equal(decoded.connectToken, grant.connect_token, grant.connect_token);
    }
  }
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    connect_url: `wss://api.evil.test/v1/terminal-connections/${terminalSessionId}/stream`,
  })));
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    connect_token: `evil_tc_${"A".repeat(43)}`,
  })));
  assert.throws(() => decodeTerminalConnectionGrant(terminalGrant({
    connect_url: `${API_WEBSOCKET_ORIGINS[0]}/v1/terminal-connections/66666666-6666-4666-8666-666666666666/stream`,
  })));
});

test("terminal grant client sends exact idempotent intent and rejects unsafe inputs before transport", async () => {
  const requests = [];
  const client = createCunaApiClient({
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
    CunaError,
  );
  await assert.rejects(
    client.createTerminalConnection(sessionId, {
      protocol: "runa.terminal.v1",
      clientInstanceId: "safe",
      resumeHandle: "not-a-uuid",
    }, "terminal-operation-3"),
    CunaError,
  );
  assert.equal(requests.length, 1);
});

test("machine client enforces canonical create bounds before transport", async () => {
  let requests = 0;
  const client = createCunaApiClient({ async request() { requests += 1; return {}; } });
  await assert.rejects(client.createMachine({ name: "dev" }, "short"), CunaError);
  await assert.rejects(client.createMachine({ name: "" }, "operation-1"), CunaError);
  await assert.rejects(client.createMachine({ name: "dev", vcpus: 9 }, "operation-2"), CunaError);
  await assert.rejects(client.createMachine({ name: "dev", memoryMiB: 511 }, "operation-3"), CunaError);
  assert.equal(requests, 0);
});

test("machine transition rejects a producer response bound to a sibling machine", async () => {
  const requested = "22222222-2222-4222-8222-222222222222";
  const sibling = "33333333-3333-4333-8333-333333333333";
  const client = createCunaApiClient({
    async request() { return { id: sibling, name: "sibling", status: "running" }; },
  });
  await assert.rejects(
    client.transitionMachine(requested, "start"),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
});

test("terminal supervisor replacement has one explicit POST with no body or idempotency key", async () => {
  const requested = "22222222-2222-4222-8222-222222222222";
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return { id: requested, name: "open-dev", status: "running" };
    },
  });
  const machine = await client.replaceMachineSupervisor(requested);
  assert.equal(machine.id, requested);
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/sessions/${requested}/supervisor/replace`,
    settleWith: "cuna machines list",
    // A supervisor replacement boots the Machine and waits for the new fence
    // to accept control, so it carries the lifecycle budget, not the list
    // default. The shape stays exact: still no body, still no idempotency key.
    budgetMs: MACHINE_LIFECYCLE_REQUEST_BUDGET_MS,
  }]);

  await assert.rejects(client.replaceMachineSupervisor("not-a-machine-id"), CunaError);
  assert.equal(requests.length, 1, "invalid input must not reach the replacement route");
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

// The strict paste-code protocol has no terminal-held continuation credential.
test("Cuna transport never emits a continuation-secret header", async () => {
  const observations = [];
  const fetch = async (url, init) => {
    observations.push({ url: url.toString(), headers: init.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const secret = `cuna_ct_${"c".repeat(43)}`;
  await createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch,
    // An untyped caller cannot restore the retired field: HttpRequest no longer
    // admits it, and the runtime transport ignores it rather than transporting a
    // secret to either old or new infrastructure.
  }).request({ method: "GET", path: "/v1/sessions", continuationSecret: secret });
  assert.equal(observations[0].url, "https://api.getcuna.com/v1/sessions");
  assert.equal(observations[0].headers["User-Agent"].startsWith("cuna-cli/"), true);
  assert.equal(observations[0].headers["X-Cuna-Continuation"], undefined);
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
    (error) => error instanceof CunaError && error.code === "cuna.network.cancelled",
  );
  assert.equal(calls, 0);
});

/**
 * REPLACES "HTTP timeout retryability fails closed for requests with ambiguous
 * side effects", which asserted `cuna.network.timeout` with `retryable: false`
 * for POST and DELETE.
 *
 * That test was green on the defect. Measured 2026-08-19 against Fly release
 * v93: `cuna machines create --yes` printed exactly that record while the
 * machine reached `running` five seconds later. The assertion was not wrong
 * about what the code did; it was wrong about what the code should do, because
 * the detector that fired was this process's own `setTimeout` and the code it
 * minted named the network.
 *
 * Fail-closed retryability has not been abandoned — it has been moved to the
 * detector it actually belongs to, `cuna.network.failed`, which is asserted in
 * `test/observation-budget.test.mjs`.
 */
test("an elapsed request budget is reported as the CLI's budget, for every method", async () => {
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
    { method: "GET", path: "/v1/sessions" },
  ]) {
    await assert.rejects(
      transport.request(request),
      (error) => error instanceof CunaError &&
        error.code === "cuna.client.response_budget_elapsed" &&
        error.retryable === true,
    );
  }
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
    (error) => error instanceof CunaError && error.code === "cuna.policy.denied" && JSON.stringify(error.details).includes("cuna_sk_bad") === false,
  );
});

test("OpenCode provider admission names the Machine remedy from the durable server refusal", async () => {
  const requestId = "55555555-5555-4555-8555-555555555555";
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/agent_session_provider_unavailable",
      title: "Agent provider unavailable",
      status: 409,
      code: "agent_session_provider_unavailable",
      request_id: requestId,
      retryable: false,
      detail: "The requested provider is not installed on this Machine.",
      action: "none",
    }), { status: 409, headers: { "content-type": "application/problem+json" } }),
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/agent-sessions" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.provider_not_installed" &&
      error.exitCode === 8 &&
      error.details?.reason === "agent_session_provider_unavailable" &&
      error.details?.request_id === requestId &&
      /Machine configured for OpenCode/u.test(error.hint ?? ""),
  );
});

test("OpenCode supervisor upgrade refusal proves no AgentSession was created", async () => {
  const requestId = "56565656-5656-4656-8656-565656565656";
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/opencode_supervisor_upgrade_required",
      title: "OpenCode terminal supervisor upgrade required",
      status: 409,
      code: "opencode_supervisor_upgrade_required",
      request_id: requestId,
      retryable: false,
      detail: "This Machine needs terminal supervisor v2 before OpenCode can start.",
      action: "none",
    }), { status: 409, headers: { "content-type": "application/problem+json" } }),
  });
  await assert.rejects(
    transport.request({
      method: "POST",
      path: "/v1/sessions/33333333-3333-4333-8333-333333333333/agent-sessions",
      body: { agent: "opencode" },
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.opencode_supervisor_upgrade_required" &&
      error.exitCode === 8 &&
      error.details?.reason === "opencode_supervisor_upgrade_required" &&
      error.details?.request_id === requestId &&
      /No OpenCode AgentSession was created/u.test(error.hint ?? ""),
  );
});

test("OpenCode protocol-unavailable refusal receives distinct explicit repair copy", async () => {
  const requestId = "57575757-5757-4757-8757-575757575757";
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/opencode_supervisor_protocol_unavailable",
      title: "OpenCode terminal supervisor protocol unavailable",
      status: 409,
      code: "opencode_supervisor_protocol_unavailable",
      request_id: requestId,
      retryable: true,
      detail: "This Machine's terminal supervisor cannot provide the OpenCode protocol.",
      action: "none",
    }), { status: 409, headers: { "content-type": "application/problem+json" } }),
  });
  await assert.rejects(
    transport.request({
      method: "POST",
      path: "/v1/sessions/33333333-3333-4333-8333-333333333333/agent-sessions",
      body: { agent: "opencode" },
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.opencode_supervisor_upgrade_required" &&
      error.details?.reason === "opencode_supervisor_protocol_unavailable" &&
      error.details?.request_id === requestId &&
      /cannot provide the OpenCode protocol/u.test(error.hint ?? ""),
  );
});

test("provider-neutral supervisor upgrade codes normalize only an OpenCode create", async () => {
  const reply = () => new Response(JSON.stringify({
    type: "https://api.getcuna.com/problems/supervisor_upgrade_required",
    title: "Terminal supervisor upgrade required",
    status: 409,
    code: "supervisor_upgrade_required",
    request_id: "57575757-5757-4757-8757-575757575757",
    retryable: false,
    detail: "This Machine needs terminal supervisor v2.",
    action: "none",
  }), { status: 409, headers: { "content-type": "application/problem+json" } });
  const openCodeTransport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => reply(),
  });
  await assert.rejects(
    openCodeTransport.request({
      method: "POST",
      path: "/v1/sessions/33333333-3333-4333-8333-333333333333/agent-sessions",
      body: { agent: "opencode" },
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.agent.opencode_supervisor_upgrade_required",
  );

  const claudeTransport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => reply(),
  });
  await assert.rejects(
    claudeTransport.request({
      method: "POST",
      path: "/v1/sessions/33333333-3333-4333-8333-333333333333/agent-sessions",
      body: { agent: "claude-code" },
    }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.conflict" &&
      /No OpenCode AgentSession was created/u.test(error.hint ?? "") === false,
  );
});

// Every origin the service has ever minted Problem documents under decodes. A
// one-sided pin here is silent: `problemMetadata` returns undefined on a miss,
// so `code`, `request_id` and `retryable` vanish from every server error and
// retry degrades with no signal.
test("HTTP errors preserve retryability only from a closed canonical Problem", async () => {
  assert.ok(API_ORIGINS.includes("https://api.getcuna.com"));
  assert.ok(API_ORIGINS.includes("https://api.runacode.io"));
  const requestId = "66666666-6666-4666-8666-666666666666";
  const makeTransport = (origin, status, retryable, overrides = {}) => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => new Response(JSON.stringify({
      type: `${origin}/problems/request_failed`,
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

  for (const origin of new Set([
    "https://api.getcuna.com", "https://api.runacode.io", ...API_ORIGINS,
  ])) {
    await assert.rejects(
      makeTransport(origin, 503, false).request({ method: "GET", path: "/v1/capabilities" }),
      (error) => error instanceof CunaError &&
        error.code === "cuna.network.service_unavailable" &&
        error.retryable === false &&
        error.details?.reason === "request_failed" &&
        error.details?.request_id === requestId,
      origin,
    );
    await assert.rejects(
      makeTransport(origin, 400, true).request({ method: "GET", path: "/v1/capabilities" }),
      (error) => error instanceof CunaError &&
        error.code === "cuna.remote.rejected" &&
        error.retryable === true,
      origin,
    );
    await assert.rejects(
      makeTransport(origin, 503, false, { provider: "forbidden" }).request({
        method: "GET",
        path: "/v1/capabilities",
      }),
      (error) => error instanceof CunaError &&
        error.retryable === true &&
        error.details?.request_id === "untrusted-header",
      origin,
    );
  }

  // A Problem minted under an origin the service never issues stays undecoded.
  await assert.rejects(
    makeTransport("https://api.evil.test", 503, false).request({ method: "GET", path: "/v1/capabilities" }),
    (error) => error instanceof CunaError &&
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
  const makeTransport = (status, overrides = {}, origin = "https://api.getcuna.com") => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => new Response(JSON.stringify({
      type: `${origin}/problems/workspace_sync_protocol_incompatible`,
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

  // Both minted Problem-URI origins decode into the same closed metadata.
  // Literal floor, so shrinking API_ORIGINS fails here instead of running
  // one case fewer. Production mints `api.runacode.io` today.
  assert.ok(API_ORIGINS.includes("https://api.getcuna.com"));
  assert.ok(API_ORIGINS.includes("https://api.runacode.io"));
  for (const origin of new Set([
    "https://api.getcuna.com", "https://api.runacode.io", ...API_ORIGINS,
  ])) {
    await assert.rejects(
      makeTransport(426, {}, origin).request({ method: "POST", path: "/v1/workspaces/w_1/sync-sessions" }),
      (error) => error instanceof CunaError &&
        error.code === "cuna.remote.rejected" &&
        error.retryable === false &&
        error.details?.reason === "workspace_sync_protocol_incompatible" &&
        error.details?.selected_protocol === 2 &&
        JSON.stringify(error.details?.capabilities) === JSON.stringify(capabilities) &&
        error.details?.request_id === requestId,
      origin,
    );
  }
  // An origin the service never mints stays undecoded.
  await assert.rejects(
    makeTransport(426, {}, "https://api.evil.test").request({ method: "POST", path: "/v1/workspaces/w_1/sync-sessions" }),
    (error) => error instanceof CunaError &&
      error.details?.selected_protocol === undefined &&
      error.details?.capabilities === undefined,
  );
  await assert.rejects(
    makeTransport(503).request({ method: "GET", path: "/v1/workspaces/w_1/sync-sessions/a_1/changes" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.network.service_unavailable" &&
      error.retryable === true &&
      error.details?.selected_protocol === null &&
      Array.isArray(error.details?.capabilities) &&
      error.details.capabilities.length === 0 &&
      error.details?.request_id === requestId,
  );

  // A legacy-model route (`sessions.start`) answers 503 with its own sentence;
  // the CLI must show that sentence, not a fixed "temporarily unavailable".
  // Measured 2026-09-02: nine identical generic answers hid "The machine
  // started, but its control connection could not be restored."
  const legacySentence = "The machine started, but its control connection could not be restored. Try the action again.";
  await assert.rejects(
    makeTransport(503, { error: legacySentence }).request({ method: "POST", path: "/v1/sessions/s_1/start" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.network.service_unavailable" &&
      error.retryable === true &&
      error.message === legacySentence &&
      error.details?.server_error === legacySentence,
  );

  for (const malformed of [
    { selected_protocol: null, capabilities },
    { selected_protocol: 2, capabilities: capabilities.slice(0, -1) },
    { selected_protocol: 2, capabilities: [capabilities[1], capabilities[0], ...capabilities.slice(2)] },
  ]) {
    await assert.rejects(
      makeTransport(503, malformed).request({ method: "GET", path: "/v1/workspaces/w_1/sync-sessions/a_1/changes" }),
      (error) => error instanceof CunaError &&
        error.code === "cuna.network.service_unavailable" &&
        error.retryable === true &&
        error.details?.request_id === "untrusted-header" &&
        error.details?.selected_protocol === undefined &&
        error.details?.capabilities === undefined,
    );
  }
});

test("invalid public IDs never reach transport (property-style adversarial corpus)", async () => {
  let calls = 0;
  const client = createCunaApiClient({ async request() { calls += 1; return {}; } });
  for (const candidate of ["", "../x", "a/b", "a?b", " a", "a b", "💥", "x".repeat(129)]) {
    await assert.rejects(client.getAgentSession(candidate), CunaError);
  }
  assert.equal(calls, 0);
});

// Measured against production on 2026-08-10: `GET /v1/capabilities` and
// `GET /v1/machines` answer `404` with `content-type: text/plain` and the body
// `404 Not Found`, while `GET /v1/me` answers `401` with
// `application/json`. Production serves 26 of the 57 operations this build
// knows, so the unparseable error body is the majority answer, not an edge
// case.
//
// The transport used to parse the body BEFORE reading the status, so every one
// of those answers surfaced as `cuna.remote.malformed_response` — the vocabulary
// of the layer that noticed the failure, not the layer that caused it. The
// status is authoritative and already in hand; it is now read first.
test("an error status survives a body the client cannot parse", async () => {
  const transport = (status, body, contentType = "text/plain; charset=UTF-8") => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: `cuna_sk_${"a".repeat(43)}`,
    fetch: async () => new Response(body, { status, headers: { "content-type": contentType } }),
  });

  // The exact production answer for an operation this deployment does not serve.
  await assert.rejects(
    transport(404, "404 Not Found").request({ method: "GET", path: "/v1/capabilities" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.operation_not_served" &&
      error.exitCode === 8 &&
      error.message === "The Cuna API at https://api.getcuna.com does not serve GET /v1/capabilities." &&
      typeof error.hint === "string" && error.hint.length > 0 &&
      error.details?.http_status === 404 &&
      error.details?.method === "GET" &&
      error.details?.path === "/v1/capabilities" &&
      error.details?.api_origin === "https://api.getcuna.com",
  );

  // The same fix, one central place, for every other unparseable error body.
  // A gateway HTML page must not become "malformed response" either.
  await assert.rejects(
    transport(503, "<html><body>502 Bad Gateway</body></html>", "text/html").request({
      method: "GET",
      path: "/v1/machines",
    }),
    (error) => error instanceof CunaError && error.code === "cuna.network.service_unavailable",
  );
  await assert.rejects(
    transport(401, "Unauthorized").request({ method: "GET", path: "/v1/machines" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.auth.rejected" &&
      // The hint must say where a replacement credential COMES FROM. The old
      // sentence named the variable and no source, which is a dead end for
      // anyone who has not already seen the console.
      typeof error.hint === "string" &&
      error.hint.includes("https://app.getcuna.com/api-keys") &&
      error.hint.includes("CUNA_API_KEY"),
  );
  await assert.rejects(
    transport(403, "Forbidden").request({ method: "GET", path: "/v1/machines" }),
    (error) => error instanceof CunaError && error.code === "cuna.policy.denied",
  );

  // A 404 the API itself minted still means "this resource is absent". The
  // discriminator is a JSON object body, which only the API's own error handler
  // produces: the request asks for exactly
  // `application/json, application/problem+json`.
  await assert.rejects(
    createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      apiKey: `cuna_sk_${"a".repeat(43)}`,
      fetch: async () => new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    }).request({ method: "GET", path: "/v1/machines/22222222-2222-4222-8222-222222222222" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.not_found" &&
      error.exitCode === 7,
  );

  // An empty-bodied 404 is not an API answer either — no route wrote it.
  await assert.rejects(
    transport(404, "").request({ method: "GET", path: "/v1/machines" }),
    (error) => error instanceof CunaError && error.code === "cuna.remote.operation_not_served",
  );

  // A SUCCESS body that is not JSON is still a malformed response. The fix
  // narrows that code to the one case it describes; it does not delete it.
  await assert.rejects(
    transport(200, "not json").request({ method: "GET", path: "/v1/machines" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      // It must say WHICH operation and WHAT rule failed, and it must not be
      // silent about what to do next.
      error.details?.operation === "GET /v1/machines" &&
      error.details?.predicate === "response_body_is_json" &&
      typeof error.hint === "string" && error.hint.length > 0,
  );
});

// `requireCapability` already converted a not-found capability-discovery route
// into `cuna.capability.discovery_unavailable`, and the branch was unreachable
// against the only deployment that exists: the plain-text 404 arrived as
// `cuna.remote.malformed_response`, which it does not catch.
test("a deployment without capability discovery is named as such before any mutation", async () => {
  let discoveries = 0;
  const client = createCunaApiClient(createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: `cuna_sk_${"a".repeat(43)}`,
    fetch: async () => {
      discoveries += 1;
      return new Response("404 Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      });
    },
  }));
  await assert.rejects(
    requireCapability({ client, scope: "account", capabilityId: "machines.create" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.capability.discovery_unavailable" &&
      error.exitCode === 8,
  );
  assert.equal(discoveries, 1);
});

// `sessions.start` is declared `"errorModel": "legacy"` in the contract, so it
// answers `{"error": "<sentence>"}` with no Problem document. Measured against
// production 2026-08-29: the web console printed the server's sentence while
// the CLI printed only `http_status: 409` and a fixed sentence of its own, so
// the one actionable fact never reached the person who had to act on it.
test("a legacy 409 envelope reaches the user as the server's own sentence", async () => {
  const legacy = (error) => createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({ error }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  const start = (transport) => transport.request({
    method: "POST",
    path: "/v1/sessions/33333333-3333-4333-8333-333333333333/start",
  });

  await assert.rejects(
    start(legacy("machine stop is still settling; refresh and try start again")),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.conflict" &&
      error.message === "machine stop is still settling; refresh and try start again",
    "the server's sentence must be the message, not a fixed one",
  );

  // Negative control one: prose that fails the terminal-safety guard must fall
  // back rather than propagate. Without this the guard could be deleted and
  // every assertion above would still pass.
  await assert.rejects(
    start(legacy("stop is settling\u001b[31m; refresh")),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.conflict" &&
      error.message ===
        "Cuna could not apply the operation because current state conflicts with it.",
    "a control character must disqualify the sentence, not reach the terminal",
  );

  // Negative control two: a body carrying no sentence at all still answers.
  await assert.rejects(
    start(legacy("")),
    (error) => error instanceof CunaError &&
      error.message ===
        "Cuna could not apply the operation because current state conflicts with it.",
    "an empty error string is not a sentence",
  );
});

/* -------------------------------------------------------------------------- */
/* PRD-PM-008 §E14-D8: connect-phase failures are retried once               */
/* -------------------------------------------------------------------------- */

// Measured 2026-09-02: `machines create` and `machines list` each failed once
// with `cuna.network.failed` after 17–18 s, TCP connect started and never
// completed (undici `UND_ERR_CONNECT_TIMEOUT`); the next call succeeded. These
// fakes reproduce the exact shape Node's fetch throws — `TypeError("fetch
// failed")` with the transport error as `cause` — as dumped from a live
// process on the same day.
const connectTimeout = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
});
const connectRefused = () => new TypeError("fetch failed", {
  cause: Object.assign(new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED", syscall: "connect" }),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED", syscall: "connect" }),
  ], ""), { code: "ECONNREFUSED" }),
});
const dnsFailure = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.getcuna.com"), { code: "EAI_AGAIN", syscall: "getaddrinfo" }),
});
const tlsFailure = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
});
const headersTimeout = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
});
const resetAfterWrite = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
});
const ok = () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("E14-D8 a connect-phase failure is retried once and the result is returned, for every method", async () => {
  for (const failure of [connectTimeout, connectRefused, dnsFailure, tlsFailure]) {
    for (const request of [
      { method: "GET", path: "/v1/sessions" },
      { method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" },
      { method: "POST", path: "/v1/sessions/33333333-3333-4333-8333-333333333333/start" },
      { method: "DELETE", path: "/v1/sessions/33333333-3333-4333-8333-333333333333" },
    ]) {
      const bodies = [];
      let calls = 0;
      const transport = createHttpTransport({
        baseUrl: "https://api.getcuna.com",
        apiKey: "cuna_sk_abcdefghijklmnop",
        fetch: async (_url, init) => {
          calls += 1;
          bodies.push(init.body);
          if (calls === 1) throw failure();
          return ok();
        },
      });
      const label = `${failure.name} ${request.method} ${request.path}`;
      assert.deepEqual(await transport.request(request), { ok: true }, label);
      assert.equal(calls, 2, label);
      // The retry re-sends the identical serialized intent.
      assert.equal(bodies[0], bodies[1], label);
    }
  }
});

test("E14-D8 two connect-phase failures are reported as never sent and retryable", async () => {
  let calls = 0;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => { calls += 1; throw connectTimeout(); },
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" }),
    (error) => {
      assert.ok(error instanceof CunaError);
      assert.equal(error.code, "cuna.network.failed");
      assert.equal(error.details?.phase, "connect");
      assert.equal(error.details?.remote_outcome, "not_sent");
      assert.equal(error.details?.attempts, 2);
      // Never sent, so a POST may be retried.
      assert.equal(error.retryable, true);
      assert.match(error.message, /never sent/u);
      assert.doesNotMatch(error.message, /was sent/u);
      return true;
    },
  );
  // Exactly one retry: not zero, not a loop.
  assert.equal(calls, 2);
});

test("E14-D8 a response-phase failure of a mutation is never retried and stays unobserved", async () => {
  for (const failure of [headersTimeout, resetAfterWrite]) {
    let calls = 0;
    const transport = createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      apiKey: "cuna_sk_abcdefghijklmnop",
      fetch: async () => { calls += 1; throw failure(); },
    });
    await assert.rejects(
      transport.request({ method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" }),
      (error) => {
        assert.ok(error instanceof CunaError);
        assert.equal(error.code, "cuna.network.failed", failure.name);
        assert.equal(error.details?.phase, "response", failure.name);
        assert.equal(error.details?.remote_outcome, "unobserved", failure.name);
        assert.equal(error.details?.attempts, 1, failure.name);
        assert.equal(error.retryable, false, failure.name);
        assert.match(error.message, /was sent/u);
        assert.doesNotMatch(error.message, /never sent/u);
        return true;
      },
    );
    assert.equal(calls, 1, failure.name);
  }
  // Negative control: a failure with no witness at all is not promoted to
  // `connect`. The fail-closed answer is the one the old code gave.
  let bareCalls = 0;
  const bare = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    fetch: async () => { bareCalls += 1; throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    bare.request({ method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" }),
    (error) => error instanceof CunaError &&
      error.details?.phase === "response" &&
      error.details?.remote_outcome === "unobserved" &&
      error.retryable === false,
  );
  assert.equal(bareCalls, 1);
});

test("E14-D8 the connect retry never exceeds the caller's budget", async () => {
  // Arm one: the first connect fails at once, the retry never answers. The
  // one budget bounds both attempts together, so the outcome is the budget's
  // own refusal, and the retry was not given a budget of its own.
  let calls = 0;
  const started = Date.now();
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 20,
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) throw connectTimeout();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/sessions" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.client.response_budget_elapsed" &&
      error.details?.budget_ms === 20,
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 2_000, "the retry must not extend the budget");

  // Arm two: the connect failure arrives after the budget has already fired.
  // There is no budget left, so there is no retry: one call, reported as the
  // budget rather than as a connect failure.
  let lateCalls = 0;
  const late = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 5,
    fetch: async (_url, init) => {
      lateCalls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(connectTimeout()), { once: true });
      });
    },
  });
  await assert.rejects(
    late.request({ method: "POST", path: "/v1/sessions", body: { name: "dev" }, idempotencyKey: "operation-1" }),
    (error) => error instanceof CunaError && error.code === "cuna.client.response_budget_elapsed",
  );
  assert.equal(lateCalls, 1);
});

test("E14-D8 caller cancellation during a connect stall is cancellation, not a retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 60_000,
    fetch: async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(connectTimeout()), { once: true });
        setTimeout(() => controller.abort(new Error("user pressed ctrl-c")), 1);
      });
    },
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/sessions", signal: controller.signal }),
    (error) => error instanceof CunaError && error.code === "cuna.network.cancelled",
  );
  assert.equal(calls, 1);
});
