import assert from "node:assert/strict";
import test from "node:test";

import { createCunaApiClient, createHttpTransport, decodeAgentSessionItem } from "../dist/index.js";

/*
 * The read the wait-truth repair depends on (2026-09-29): the CLI must ASK
 * `GET /v1/agent-sessions/{id}` for the server's startup verdict, because the
 * server returns `readiness_*` and `runtime_evidence` only on
 * `include_readiness=true` / `include_runtime_evidence=true`, and it must
 * DECODE them, because the decoder refuses a key it does not know.
 *
 * Values and shapes are producer infra 2e4e1a2 (Edge v240):
 * `contracts/runa-api.openapi.json` `components.schemas.AgentSession`,
 * migration 0233's check constraint, and `edge/src/api.ts`'s query schema.
 * The vendored contract (7b1b3e42) predates all three, which is why this file
 * cites the producer rather than `contracts/infra`. Boundary modelled: the real
 * HTTP client and decoder over a fake `fetch`.
 */

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEADLINE_AT = "2026-09-29T22:15:00.000Z";
const SETTLED_AT = "2026-09-29T22:15:20.000Z";


function wireSession(overrides = {}) {
  return {
    id: SESSION_ID, machine_id: MACHINE_ID, name: "opencode", agent: "opencode",
    cwd: "/workspace/workspaces/55555555-5555-4555-8555-555555555555", auth_mode: "interactive_login",
    desired_state: "running", request_state: "launched", process_state: "unknown", process_observation: "unknown",
    row_version: 4, created_at: "2026-09-29T22:13:00.000Z", updated_at: "2026-09-29T22:15:20.000Z",
    ...overrides,
  };
}

function clientAnswering(respond) {
  const urls = [];
  const client = createCunaApiClient(createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      const [status, body] = respond(urls.length, urls.at(-1));
      return new Response(JSON.stringify(body), {
        status, headers: { "content-type": status < 400 ? "application/json" : "application/problem+json" },
      });
    },
  }));
  return { client, urls };
}

test("wire: the readiness read asks for both opt-ins and decodes the producer's answer", async () => {
  const { client, urls } = clientAnswering(() => [200, wireSession({
    readiness_deadline_at: "2026-09-29T22:15:00.000Z",
    readiness_outcome: "reconciliation_required",
    readiness_reason: "deadline_unattested",
    readiness_settled_at: "2026-09-29T22:15:20.000Z",
    runtime_evidence: { source: "supervisor_ack", observed_at: "2026-09-29T21:36:05.000Z", age_seconds: 2355, process_proof: "no_process_epoch" },
  })]);
  const decoded = await client.getAgentSession(SESSION_ID, undefined, { readiness: true, runtimeEvidence: true });
  assert.equal(urls[0].pathname, `/v1/agent-sessions/${SESSION_ID}`);
  assert.equal(urls[0].searchParams.get("include_readiness"), "true");
  assert.equal(urls[0].searchParams.get("include_runtime_evidence"), "true");
  assert.deepEqual(decoded.readiness, {
    outcome: "reconciliation_required", reason: "deadline_unattested",
    deadlineAt: "2026-09-29T22:15:00.000Z", settledAt: "2026-09-29T22:15:20.000Z",
  });
  assert.deepEqual(decoded.runtimeEvidence, {
    source: "supervisor_ack", observedAt: "2026-09-29T21:36:05.000Z", ageSeconds: 2355, processProof: "no_process_epoch",
  });
});

test("wire: a plain read asks for nothing, so existing callers see the prior response", async () => {
  const { client, urls } = clientAnswering(() => [200, wireSession()]);
  await client.getAgentSession(SESSION_ID);
  assert.equal(urls[0].search, "");
});

test("wire: an Edge that refuses the opt-in is asked again without it, once per process", async () => {
  // Edges from 528a797 to e5aefe8 parse this query strictly and know only
  // include_readiness; they answer 422 invalid_agent_session_request.
  const { client, urls } = clientAnswering((count, url) => (url.search === ""
    ? [200, wireSession()]
    : [422, { type: "https://api.getcuna.com/problems/invalid_agent_session_request", title: "Invalid AgentSession request",
      status: 422, code: "invalid_agent_session_request", detail: "Use a canonical AgentSession ID.", retryable: false, action: "none" }]));
  const first = await client.getAgentSession(SESSION_ID, undefined, { readiness: true, runtimeEvidence: true });
  const second = await client.getAgentSession(SESSION_ID, undefined, { readiness: true, runtimeEvidence: true });
  assert.equal(first.readiness, undefined);
  assert.equal(second.id, SESSION_ID);
  assert.deepEqual(urls.map((url) => url.search !== ""), [true, false, false]);
});

test("wire NEGATIVE CONTROL: any other refusal of the read is still a refusal", async () => {
  const { client, urls } = clientAnswering(() => [404, {
    type: "https://api.getcuna.com/problems/agent_session_not_found", title: "AgentSession not found", status: 404,
    code: "agent_session_not_found", detail: "Check the identifier.", retryable: false, action: "none",
  }]);
  await assert.rejects(client.getAgentSession(SESSION_ID, undefined, { readiness: true }), (error) => error.code === "cuna.remote.not_found");
  assert.equal(urls.length, 1);
});

test("decoder: readiness fields decode only in the shapes migration 0233 allows", () => {
  const settled = { readiness_deadline_at: DEADLINE_AT, readiness_outcome: "refused", readiness_reason: "session_capacity_memory", readiness_settled_at: SETTLED_AT };
  assert.equal(decodeAgentSessionItem(wireSession(settled)).readiness.reason, "session_capacity_memory");
  assert.deepEqual(decodeAgentSessionItem(wireSession({ readiness_deadline_at: DEADLINE_AT, readiness_outcome: "pending" })).readiness,
    { outcome: "pending", deadlineAt: DEADLINE_AT });
  for (const [label, fields] of [
    ["a refusal without its reason", { ...settled, readiness_reason: undefined }],
    ["a pending verdict with a reason", { readiness_deadline_at: DEADLINE_AT, readiness_outcome: "pending", readiness_reason: "deadline_unattested" }],
    ["a pending verdict with a settlement time", { readiness_deadline_at: DEADLINE_AT, readiness_outcome: "pending", readiness_settled_at: SETTLED_AT }],
    ["an attestation without a settlement time", { readiness_deadline_at: DEADLINE_AT, readiness_outcome: "attested" }],
    ["an outcome without its deadline", { readiness_outcome: "pending" }],
    ["an unknown outcome", { ...settled, readiness_outcome: "maybe" }],
  ]) {
    assert.throws(() => decodeAgentSessionItem(wireSession(fields)), /./u, label);
  }
});

test("decoder: a memory refusal's terminal reason decodes instead of failing the read", () => {
  const decoded = decodeAgentSessionItem(wireSession({ process_state: "failed", terminal_reason: "session_capacity_memory" }));
  assert.equal(decoded.terminalReason, "session_capacity_memory");
});
