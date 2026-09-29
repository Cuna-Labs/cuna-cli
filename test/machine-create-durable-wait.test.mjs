import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

/**
 * Installed 0.1.5, 2026-09-29T01:19:34Z: `cuna machines create --name
 * qa-c3-20260929 ... --yes` ended with `cuna.client.response_budget_elapsed`
 * on POST /v1/sessions after 90 s, while the Machine it asked for was created
 * at 01:19:38 and ran at 01:21:33. A create that outlives one request's budget
 * is not a failed create. These tests drive the real CLI and HTTP transport
 * against a fake Cuna whose create answers only after 120 s of its own clock.
 */
const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-29T01:19:34Z");
const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function fakeCuna({ settlesAfterMs, receipt = () => undefined, account = ACCOUNT_ID }) {
  const server = { clock: 0, posts: [], receiptReads: [], requestIds: new Set() };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const createRequest = (id, state, action) => ({ id, machine_id: MACHINE_ID, state, retryable: state !== "settled", action, updated_at: new Date(NOW + server.clock).toISOString() });
  server.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (method === "GET" && pathname === "/v1/me") {
      return json({ id: account, email: "owner@example.test", workspace: { assigned: true, id: "22222222-2222-4222-8222-222222222222", usage: { est_spend_usd: 1, est_spend_is_lower_bound: true, balance_status: "unavailable", balance_usd: null, balance_unavailable_reason: "no balance endpoint", note: "fixture" } } });
    }
    if (pathname === "/v1/capabilities") {
      return json({
        schema_version: "1.0", subject_scope: "account",
        observed_at: new Date(NOW - 1_000).toISOString(), expires_at: new Date(NOW + 30_000).toISOString(), etag: "etag-1",
        capabilities: [{ id: "machines.create", availability: "supported", interaction: "native", mutation_class: "financial", surfaces: ["cli"], required_permissions: ["machines:create"] }],
      });
    }
    if (method === "POST" && pathname === "/v1/sessions") {
      server.posts.push({ key: init.headers["Idempotency-Key"], requestId: init.headers["X-Cuna-Machine-Create-Request-Id"] });
      server.requestIds.add(init.headers["X-Cuna-Machine-Create-Request-Id"]);
      // Cuna provisions inside this request and does not answer in time; the
      // CLI's own budget, not Cuna, ends the wait for this one response.
      return await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
      });
    }
    const receiptPath = /^\/v1\/machine-creates\/([0-9a-f-]{36})$/u.exec(pathname);
    if (method === "GET" && receiptPath !== null) {
      const id = receiptPath[1];
      server.receiptReads.push({ id, at: server.clock });
      const scripted = receipt(server, id);
      if (scripted !== undefined) return scripted.status === undefined ? json(scripted) : json(scripted.body, scripted.status);
      if (!server.requestIds.has(id)) return json({ type: "about:blank", title: "Not Found", status: 404, code: "machine_create_not_found" }, 404);
      return json(settlesAfterMs !== undefined && server.clock >= settlesAfterMs
        ? createRequest(id, "settled", "none")
        : createRequest(id, "in_progress", "wait"));
    }
    if (method === "GET" && pathname === `/v1/sessions/${MACHINE_ID}`) {
      return json({ id: MACHINE_ID, name: "qa-c3-20260929", state: "running", agent: "opencode", vcpus: 2, memory_mib: 4096 });
    }
    return json({ type: "about:blank", title: "Unexpected", status: 500, code: "unexpected_request" }, 500);
  };
  server.poller = { now: () => server.clock, async sleep(milliseconds) { server.clock += milliseconds; } };
  return server;
}

async function create(server, extra = [], apiKey = API_KEY) {
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([
    "machines", "create", "--name", "qa-c3-20260929", "--agent", "opencode", "--vcpus", "2", "--memory-mib", "4096",
    "--yes", "--timeout-ms", "100", "--no-color", ...extra,
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: apiKey },
    now: () => NOW,
    fetch: server.fetch,
    convergencePoller: server.poller,
  });
  return { exit, stdout: streams.stdout(), stderr: streams.stderr() };
}

test("a create that Cuna answers only after 120 s ends in success, with progress, after one POST", async () => {
  const server = fakeCuna({ settlesAfterMs: 120_000 });
  const result = await create(server);
  assert.equal(result.exit, EXIT_CODES.success, result.stderr);
  assert.match(result.stdout, /Created machine qa-c3-20260929 \(33333333-3333-4333-8333-333333333333\) in state running\./u);
  assert.match(result.stderr, /Still waiting for machine qa-c3-20260929 to be created · \d+s of 300s/u, "the wait is said, with its deadline");
  assert.equal(server.posts.length, 1, "the create is never sent twice");
  assert.match(server.posts[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.ok(server.receiptReads.every((read) => read.id === server.posts[0].requestId), "only the request that was sent is read");
  assert.ok(server.clock >= 120_000 && server.clock < 300_000);
});

test("a create Cuna never confirms ends in a typed timeout that names how to check", async () => {
  const server = fakeCuna({});
  const result = await create(server, ["--json"]);
  assert.equal(result.exit, EXIT_CODES.network);
  const error = JSON.parse(result.stderr.trim().split("\n").at(-1)).error;
  assert.equal(error.code, "cuna.machine.create_unconfirmed");
  assert.match(error.hint, /cuna machines list/u);
  assert.equal(error.retryable, true);
  assert.equal(error.details.create_request_id, server.posts[0].requestId);
  assert.equal(error.details.receipt_state, "in_progress");
  assert.equal(error.details.deadline_ms, 300_000);
  assert.equal(server.posts.length, 1, "running out of time never re-sends the create");
  assert.ok(server.clock >= 300_000, "the CLI kept reading for the whole follow deadline");
});

test("the same --idempotency-key again reads the first create's receipt and sends nothing", async () => {
  const server = fakeCuna({ settlesAfterMs: 120_000 });
  const first = await create(server, ["--idempotency-key", "qa-c3-create-1", "--json"]);
  assert.equal(first.exit, EXIT_CODES.success, first.stderr);
  const requestId = server.posts[0].requestId;
  const again = await create(server, ["--idempotency-key", "qa-c3-create-1", "--json"]);
  assert.equal(again.exit, EXIT_CODES.success, again.stderr);
  assert.equal(server.posts.length, 1, "a known create is read, not re-sent");
  assert.equal(JSON.parse(again.stdout).data.create_request_id, requestId, "the key names the same durable request");
});

test("a receipt that says the create failed ends in a typed failure, not a wait", async () => {
  const server = fakeCuna({
    receipt: (current, id) => current.clock >= 4_000
      ? { id, machine_id: MACHINE_ID, state: "terminal_failed", retryable: false, action: "none", updated_at: new Date(NOW).toISOString() }
      : undefined,
  });
  const result = await create(server, ["--json"]);
  assert.equal(result.exit, EXIT_CODES.remote);
  assert.equal(JSON.parse(result.stderr.trim().split("\n").at(-1)).error.code, "cuna.machine.create_failed");
  assert.equal(server.posts.length, 1);
  assert.ok(server.clock < 300_000, "a settled failure does not wait out the deadline");
});

/** The request id this CLI derives: a UUID from the account scope and the key. */
function requestIdFrom(scope, key) {
  const bytes = createHash("sha256").update("cuna.machine-create-request.v1 ").update(scope).update(" ").update(key).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test("one account and one --idempotency-key name one create request across runs; another account never does", async () => {
  const ids = [];
  for (const account of [ACCOUNT_ID, ACCOUNT_ID, "99999999-9999-4999-8999-999999999999"]) {
    const server = fakeCuna({ settlesAfterMs: 0, account });
    const result = await create(server, ["--idempotency-key", "qa-c3-create-1", "--json"]);
    assert.equal(result.exit, EXIT_CODES.success, result.stderr);
    ids.push(server.posts[0].requestId);
  }
  assert.equal(ids[0], ids[1], "a new run with the same account and key reads the same request");
  assert.notEqual(ids[0], ids[2], "two accounts never name the same request");
  assert.equal(ids[0], requestIdFrom(`automation:${ACCOUNT_ID}`, "qa-c3-create-1"), "the id is the account and the key, nothing else");
});

test("no credential material enters the create request id", async () => {
  // CodeQL (PR #79, 2026-09-29): the id used to hash the raw API key. Two keys
  // of one account now name the same request, so the key is not an input,
  // and the id is not the plain SHA-256 derivation over the key.
  const ids = [];
  for (const apiKey of [API_KEY, "cuna_sk_zyxwvutsrqponmlk"]) {
    const server = fakeCuna({ settlesAfterMs: 0 });
    const result = await create(server, ["--idempotency-key", "qa-c3-create-1", "--json"], apiKey);
    assert.equal(result.exit, EXIT_CODES.success, result.stderr);
    ids.push(server.posts[0].requestId);
  }
  assert.equal(ids[0], ids[1]);
  const keyed = requestIdFrom(`automation:${createHash("sha256").update(API_KEY).digest("hex")}`, "qa-c3-create-1");
  assert.notEqual(ids[0], keyed, "the id is not derivable from a hash of the key");
});
