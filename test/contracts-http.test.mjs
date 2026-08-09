import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createRunaApiClient,
  decodeAgentSessionItem,
  decodeCapabilitySnapshot,
  decodeMachinePage,
  decideCapability,
  RunaError,
} from "../dist/index.js";

const future = "2099-01-01T00:00:00.000Z";
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
    schema_version: "1",
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

function agentSession(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machine_id: "22222222-2222-4222-8222-222222222222",
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
    row_version: 4,
  }));
  assert.equal(decoded.name, "primary");
  assert.equal(decoded.requestState, "launched");
  assert.equal(decoded.processState, "running");
  assert.equal(decoded.rowVersion, 4);
  assert.equal(Object.hasOwn(decoded, "state"), false);
  assert.throws(() => decodeAgentSessionItem(agentSession({ process_state: "healthy" })));
  assert.throws(() => decodeAgentSessionItem(agentSession({ row_version: -1 })));
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
  }, "operation-1"), RunaError);
  await assert.rejects(client.createAgentSession(machineId, {
    agent: "claude-code",
    cwd: "/workspace",
    authMode: "credential_binding",
  }, "operation-2"), RunaError);
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
    }, "operation-sibling"),
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

test("legacy array machine responses are decoded into a safe public page", () => {
  const page = decodeMachinePage([{ id: "m_1", name: "dev", status: "running", memory_mib: 512, vcpus: 1, url: "https://internal.invalid" }]);
  assert.deepEqual(page, { items: [{ id: "m_1", name: "dev", state: "running", vcpus: 1, memoryMiB: 512 }] });
  assert.equal(JSON.stringify(page).includes("internal.invalid"), false);
});

test("HTTP transport binds origin, authorization, idempotency, and public path", async () => {
  let observed;
  const transport = createHttpTransport({
    baseUrl: "https://api.runacode.io",
    apiKey: "runa_sk_abcdefghijklmnop",
    fetch: async (url, init) => {
      observed = { url: url.toString(), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await transport.request({ method: "POST", path: "/v1/sessions", body: { name: "x" }, idempotencyKey: "op_1" });
  assert.equal(observed.url, "https://api.runacode.io/v1/sessions");
  assert.equal(observed.init.headers.Authorization, "Bearer runa_sk_abcdefghijklmnop");
  assert.equal(observed.init.headers["Idempotency-Key"], "op_1");
});

test("pre-aborted HTTP requests perform no fetch effect", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancel-before-dispatch"));
  const transport = createHttpTransport({
    baseUrl: "https://api.runacode.io",
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

test("HTTP errors expose only stable safe metadata", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.runacode.io",
    apiKey: "runa_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify({ code: "policy_denied", message: "raw secret runa_sk_bad" }), {
      status: 403,
      headers: { "x-request-id": "req_safe" },
    }),
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/v1/sessions/m_1/stop" }),
    (error) => error instanceof RunaError && error.code === "runa.policy.denied" && JSON.stringify(error.details).includes("runa_sk_bad") === false,
  );
});

test("invalid public IDs never reach transport (property-style adversarial corpus)", async () => {
  let calls = 0;
  const client = createRunaApiClient({ async request() { calls += 1; return {}; } });
  for (const candidate of ["", "../x", "a/b", "a?b", " a", "a b", "💥", "x".repeat(129)]) {
    await assert.rejects(client.getAgentSession(candidate), RunaError);
  }
  assert.equal(calls, 0);
});
