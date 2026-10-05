// PRD cuna-truthful-machine-surfaces R1.4 (BL-1): when `cuna machines start` is
// refused, the person reads the server's reason and next step, and no step the
// server did not name.
//
// Measured on the 0.1.7 drop c0dc53b, 2026-10-02T23:45:34Z (biotech-lab,
// Machine cd0696a7): the 409 `supervisor_upgrade_required` reached the user with
// the Edge's own title and detail. That stays. What did not hold: a refusal the
// server answers through the capability read -- which the Edge's R1.1 makes the
// first place a start is refused -- reached the user as "Cuna cannot currently
// authorize the machines.lifecycle capability." with the server's reason only in
// `details`, and a next step ("Run `cuna capabilities`") the server never named.
// The same invented step appeared on a Problem that named a reason but no step.
//
// Every request here goes through the real HTTP transport and API client.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "cd0696a7-fd94-4095-b3ed-05283de80469";
const REQUEST_ID = "69660297-1c5b-4691-9452-ee07ab7e1c0c";

function json(status, body, type = "application/json") {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
}

function problem(status, code, title, detail, retryable = false) {
  return json(status, {
    type: `https://api.getcuna.com/problems/${code}`,
    title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    retryable,
    action: retryable ? "retry" : "none",
    request_id: REQUEST_ID,
  }, "application/problem+json");
}

function lifecycleCapability(availability, reasonCode) {
  const now = Date.now();
  return json(200, {
    schema_version: "1.0",
    subject_scope: "machine",
    subject_id: MACHINE_ID,
    observed_at: new Date(now - 100).toISOString(),
    expires_at: new Date(now + 30_000).toISOString(),
    etag: "r1-4",
    capabilities: [{
      id: "machines.lifecycle",
      availability,
      interaction: "native",
      mutation_class: "reversible",
      surfaces: ["cli"],
      required_permissions: ["machines:update"],
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
    }],
  });
}

/**
 * A stopped Machine whose capability read and start answer as given. Records
 * every request so a test can say whether a start was ever sent.
 */
function api({ capability = () => lifecycleCapability("supported"), start }) {
  const requests = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${pathname}`);
    if (method === "GET" && pathname === "/v1/capabilities") return capability();
    if (method === "GET" && pathname === `/v1/sessions/${MACHINE_ID}`) {
      return json(200, { id: MACHINE_ID, name: "biotech-lab", status: "stopped", agent: "claude-code" });
    }
    if (method === "POST" && pathname === `/v1/sessions/${MACHINE_ID}/start`) return start();
    throw new Error(`unexpected request ${method} ${pathname}`);
  };
  return { fetch, requests };
}

async function startMachine(server, { json: structured = true } = {}) {
  // Human mode needs a terminal on stdout; stderr stays a plain stream so no
  // progress row is drawn into the text under test.
  const streams = memoryStreams({ stdoutIsTTY: !structured, stderrIsTTY: false });
  const exit = await runCli(["machines", "start", MACHINE_ID, "--yes", ...(structured ? ["--json"] : [])], {
    streams: streams.streams,
    platform: PLATFORM,
    env: { CUNA_API_KEY: API_KEY },
    fetch: server.fetch,
  });
  const stderr = streams.stderr();
  const record = structured ? JSON.parse(stderr.trim().split("\n").at(-1)) : undefined;
  return { exit, stderr, record, error: record?.error };
}

/** A `Next:` line, or a hint, that tells the person to run something. */
const SUGGESTS_A_COMMAND = /`cuna |Run `|Re-read|Retry a read|report it/u;

test("a start the capability read refuses names the server's reason in the message, and nothing it did not name", async () => {
  // The Edge answers start-ability on the capability read (R1.1); the CLI asks
  // it before sending a start. Reason codes are the server's, verbatim.
  for (const [availability, reason] of [
    ["temporarily_unavailable", "control_credential_expired"],
    ["unsupported", "provider_billing_restricted"],
  ]) {
    const server = api({
      capability: () => lifecycleCapability(availability, reason),
      start: () => { throw new Error("a refused start must not be sent"); },
    });
    const { exit, error } = await startMachine(server);
    assert.notEqual(exit, EXIT_CODES.success, reason);
    assert.deepEqual(server.requests.filter((request) => request.startsWith("POST")), [], `${reason}: nothing was sent`);
    assert.equal(error.details.reason, reason, reason);
    assert.equal(error.details.capability_id, "machines.lifecycle", reason);
    assert.ok(error.message.includes(reason), `${reason}: the reason is in the sentence the person reads: ${error.message}`);
    assert.ok(error.message.includes(MACHINE_ID), `${reason}: the message names the Machine: ${error.message}`);
    assert.equal(error.hint, undefined, `${reason}: the server named no next step, so none is printed: ${error.hint}`);

    const human = await startMachine(api({
      capability: () => lifecycleCapability(availability, reason),
      start: () => { throw new Error("a refused start must not be sent"); },
    }), { json: false });
    assert.ok(human.stderr.includes(reason), `${reason}: ${human.stderr}`);
    assert.doesNotMatch(human.stderr, /^Next:/mu, `${reason}: ${human.stderr}`);
    assert.doesNotMatch(human.stderr, SUGGESTS_A_COMMAND, `${reason}: ${human.stderr}`);
  }
});

test("control: a capability fault this CLI derived itself keeps its own diagnosis", async () => {
  // Not a server reason: the snapshot had already expired when it arrived, so
  // the verdict is this CLI's and so is the step. Varies only who named the
  // reason.
  const server = api({
    capability: () => json(200, {
      schema_version: "1.0", subject_scope: "machine", subject_id: MACHINE_ID,
      observed_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() - 30_000).toISOString(),
      etag: "r1-4",
      capabilities: [{
        id: "machines.lifecycle", availability: "supported", interaction: "native",
        mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:update"],
      }],
    }),
    start: () => { throw new Error("must not be sent"); },
  });
  const { error } = await startMachine(server);
  assert.equal(error.code, "cuna.capability.unknown");
  assert.equal(error.details.reason, "expired");
  assert.equal(error.message, "Cuna cannot currently authorize the machines.lifecycle capability.");
  assert.match(error.hint, /cuna capabilities/u);
  assert.deepEqual(server.requests.filter((request) => request.startsWith("POST")), []);
});

test("the Edge's own start refusal reaches the person word for word (BL-1 as observed)", async () => {
  // The exact answer of 2026-10-02T23:45:34Z, Edge sessions.ts start branch.
  const title = "Supervisor update required";
  const detail = "This Machine's supervisor did not accept control for start. Run `machines update-supervisor` on this stopped Machine, then start it again.";
  const { exit, record, error } = await startMachine(api({ start: () => problem(409, "supervisor_upgrade_required", title, detail) }));
  assert.equal(exit, EXIT_CODES.conflict);
  // BL-4 on the same answer: the envelope said "machines".
  assert.equal(record.command, "machines.start");
  assert.equal(error.message, title);
  assert.equal(error.hint, detail);
  assert.equal(error.details.reason, "supervisor_upgrade_required");
  assert.equal(error.details.request_id, REQUEST_ID);
  assert.equal(error.retryable, false);

  const human = await startMachine(api({ start: () => problem(409, "supervisor_upgrade_required", title, detail) }), { json: false });
  assert.match(human.stderr, /^Error \[cuna\.remote\.conflict\]: Supervisor update required$/mu);
  assert.ok(human.stderr.includes(`Next: ${detail}`), human.stderr);
  assert.equal(human.stderr.match(/^Next:/gmu)?.length, 1, human.stderr);
});

test("a provider billing refusal on start is printed as the server words it (AC2)", async () => {
  const title = "Workspace provider rejected the request";
  const detail = "The workspace provider refused to start this Machine: billing restricted (balance_exhausted). Add credit, then start it again.";
  const { error } = await startMachine(api({ start: () => problem(502, "provider_request_rejected", title, detail) }));
  assert.equal(error.code, "cuna.remote.rejected");
  assert.equal(error.message, title);
  assert.equal(error.hint, detail);
  assert.equal(error.details.reason, "provider_request_rejected");
});

test("a start refusal that names a reason but no next step gets no invented step", async () => {
  // `detail` is optional in the Problem contract. With it absent the server
  // has named the reason (title, code) and no step; the CLI used to fill the
  // gap with advice of its own.
  for (const [status, code, title, retryable] of [
    [409, "machine_transition_invalid", "Transition not allowed from the current state", false],
    [409, "machine_state_conflict", "Machine changed", true],
    [502, "provider_request_rejected", "Workspace provider rejected the request", false],
    [503, "provider_unavailable", "Workspace provider unavailable", true],
    [500, "machine_state_commit_failed", "Machine state could not be committed", false],
  ]) {
    const { exit, error } = await startMachine(api({ start: () => problem(status, code, title, undefined, retryable) }));
    assert.notEqual(exit, EXIT_CODES.success, code);
    assert.equal(error.message, title, code);
    assert.equal(error.details.reason, code, code);
    assert.equal(error.retryable, retryable, `${code}: the server's own retryable`);
    assert.equal(error.hint, undefined, `${code}: ${error.hint}`);
  }
});

test("cuna capabilities prints the reason the server gives for a refused action (AC1)", async () => {
  // The Edge names start-ability per action (`machines.start`) beside the
  // grouped `machines.lifecycle`. The human table printed id, availability and
  // interaction only, so the reason reached JSON readers alone.
  const now = Date.now();
  const fetch = async () => json(200, {
    schema_version: "1.0", subject_scope: "machine", subject_id: MACHINE_ID,
    observed_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 30_000).toISOString(), etag: "ac1",
    capabilities: [
      { id: "machines.lifecycle", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:update"] },
      { id: "machines.start", availability: "temporarily_unavailable", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:update"], reason_code: "control_credential_expired" },
    ],
  });
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
  const exit = await runCli(["capabilities", "--scope", "machine", "--resource-id", MACHINE_ID], {
    streams: streams.streams, platform: PLATFORM, env: { CUNA_API_KEY: API_KEY }, fetch,
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  const lines = streams.stdout().trimEnd().split("\n");
  assert.deepEqual(lines, [
    "machines.lifecycle\tsupported\tnative",
    "machines.start\ttemporarily_unavailable\tnative\tcontrol_credential_expired",
  ]);
});

test("control: a start answered by something that is not the API keeps the CLI's transport guidance", async () => {
  // No server reason at all (a proxy's HTML 502): there are no server words to
  // print, so the CLI's statement about an unknown outcome is the truth.
  const { error } = await startMachine(api({
    start: () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
  }));
  assert.equal(error.code, "cuna.network.service_unavailable");
  assert.match(error.hint, /do not assume a write was applied/u);
});
