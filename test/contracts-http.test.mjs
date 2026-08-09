import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createRunaApiClient,
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
