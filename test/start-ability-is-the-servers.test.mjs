// PRD cuna-truthful-machine-surfaces R1.2 (BL-1), CLI side.
//
// Measured on the 0.1.7 drop c0dc53b, 2026-10-02T23:45:26Z (biotech-lab,
// Machine cd0696a7, stopped): `machines list` printed it
// `provider_availability.actionable: true` and `Claude ready`, and 8 s later
// `machines start` was refused. `actionable` is this CLI's verdict on the
// declared provider (`src/machines/provider-availability.ts`), computed from
// `machine.agent` alone: it never knew whether the Machine could start. The
// Edge now names start-ability per action (`machines.start|stop|pause|resume`)
// beside the grouped `machines.lifecycle`; an older Edge names none.
//
// Every request here goes through the real HTTP transport and API client.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "cd0696a7-fd94-4095-b3ed-05283de80469";
const RUNNING_ID = "11111111-1111-4111-8111-111111111111";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function entry(id, availability = "supported", reasonCode) {
  return {
    id, availability, interaction: "native", mutation_class: "reversible", surfaces: ["cli"],
    required_permissions: ["machines:update"], ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
  };
}

function snapshot(capabilities) {
  const now = Date.now();
  return json(200, {
    schema_version: "1.0", subject_scope: "machine", subject_id: MACHINE_ID,
    observed_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 30_000).toISOString(),
    etag: "r1-2", capabilities,
  });
}

const BEFORE = { start: "stopped", resume: "paused", stop: "running", pause: "running" };
const AFTER = { start: "running", resume: "running", stop: "stopped", pause: "paused" };

/** One Machine whose capability read answers `capabilities`; records every request. */
function api(capabilities, { action = "start", transition } = {}) {
  const requests = [];
  let state = BEFORE[action];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${pathname}`);
    if (method === "GET" && pathname === "/v1/capabilities") return snapshot(capabilities);
    if (method === "GET" && pathname === `/v1/sessions/${MACHINE_ID}`) {
      return json(200, { id: MACHINE_ID, name: "biotech-lab", status: state, agent: "claude-code" });
    }
    if (method === "POST" && pathname === `/v1/sessions/${MACHINE_ID}/${action}`) {
      if (transition !== undefined) return transition();
      state = AFTER[action];
      return json(200, { id: MACHINE_ID, name: "biotech-lab", status: state, agent: "claude-code" });
    }
    if (method === "POST" && pathname === `/v1/sessions/${MACHINE_ID}/supervisor/replace`) {
      state = "running";
      return json(200, { id: MACHINE_ID, name: "biotech-lab", status: state, agent: "claude-code" });
    }
    throw new Error(`unexpected request ${method} ${pathname}`);
  };
  return { fetch, requests, posts: () => requests.filter((request) => request.startsWith("POST")) };
}

async function run(argv, server, { structured = true } = {}) {
  const streams = memoryStreams({ stdoutIsTTY: !structured, stderrIsTTY: false });
  const exit = await runCli([...argv, ...(structured ? ["--json"] : [])], {
    streams: streams.streams, platform: PLATFORM, env: { CUNA_API_KEY: API_KEY }, fetch: server.fetch,
  });
  const stdout = streams.stdout();
  const stderr = streams.stderr();
  const last = (text) => text.trim() === "" ? undefined : JSON.parse(text.trim().split("\n").at(-1));
  return { exit, stdout, stderr, result: structured ? last(stdout) : undefined, error: structured ? last(stderr)?.error : undefined };
}

test("machines list does not call a Machine that is not running actionable, and says why", async () => {
  const fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/sessions") {
      return json(200, { items: [
        { id: MACHINE_ID, name: "biotech-lab", status: "stopped", agent: "claude-code" },
        { id: RUNNING_ID, name: "live", status: "running", agent: "claude-code" },
      ] });
    }
    throw new Error(`unexpected request ${pathname}`);
  };
  const structured = await run(["machines", "list"], { fetch });
  assert.equal(structured.exit, 0, structured.stderr);
  const [stopped, running] = structured.result.data.items;
  assert.equal(stopped.provider_availability.actionable, false, "the declared provider is not a verdict on starting");
  assert.equal(stopped.provider_availability.reason_code, "machine_not_running");
  assert.equal(stopped.provider_availability.usability, "declared-installed", "the declaration itself is unchanged");
  // Control: the verdict is unchanged where it was always true.
  assert.equal(running.provider_availability.actionable, true);
  assert.equal(running.provider_availability.reason_code, undefined);

  const human = await run(["machines", "list"], { fetch }, { structured: false });
  assert.deepEqual(human.stdout.trimEnd().split("\n"), [
    `${MACHINE_ID}\tbiotech-lab\tstopped\tClaude`,
    `${RUNNING_ID}\tlive\trunning\tClaude ready`,
  ]);
});

test("a lifecycle action the server would refuse is refused before it is sent, in the server's words", async () => {
  for (const action of ["start", "stop", "pause", "resume"]) {
    for (const [availability, reason] of [["temporarily_unavailable", "control_credential_expired"], ["unsupported", "machine_transition_invalid"]]) {
      const label = `${action} ${reason}`;
      const server = api([entry("machines.lifecycle"), entry(`machines.${action}`, availability, reason)], { action });
      const { exit, error, result } = await run(["machines", action, MACHINE_ID, "--yes"], server);
      assert.notEqual(exit, 0, `${label}: ${JSON.stringify(result)}`);
      assert.deepEqual(server.posts(), [], `${label}: nothing was sent`);
      assert.equal(error.details.capability_id, `machines.${action}`, label);
      assert.equal(error.details.reason, reason, label);
      assert.ok(error.message.includes(reason) && error.message.includes(MACHINE_ID), `${label}: ${error.message}`);
      assert.equal(error.hint, undefined, `${label}: no step the server did not name`);
    }
  }
});

test("control: an Edge that names no per-action capability leaves the decision to machines.lifecycle", async () => {
  const server = api([entry("machines.lifecycle")]);
  const { exit, result, stderr } = await run(["machines", "start", MACHINE_ID, "--yes"], server);
  assert.equal(exit, 0, stderr);
  assert.equal(result.data.state, "running");
  assert.deepEqual(server.posts(), [`POST /v1/sessions/${MACHINE_ID}/start`]);
  // And the grouped authority still refuses on its own.
  const refused = api([entry("machines.lifecycle", "unsupported", "machine_lifecycle_forbidden")]);
  const { error } = await run(["machines", "start", MACHINE_ID, "--yes"], refused);
  assert.equal(error.details.capability_id, "machines.lifecycle");
  assert.deepEqual(refused.posts(), []);
});

test("a per-action id that cannot say leaves the decision to machines.lifecycle", async () => {
  // `unknown` is the Edge saying it could not read the Machine's control or
  // state; that is not a reason to refuse what the grouped authority admits.
  const server = api([entry("machines.lifecycle"), entry("machines.start", "unknown", "machine_lifecycle_authority_unavailable")]);
  const { exit, stderr } = await run(["machines", "start", MACHINE_ID, "--yes"], server);
  assert.equal(exit, 0, stderr);
  assert.deepEqual(server.posts(), [`POST /v1/sessions/${MACHINE_ID}/start`]);
});

test("a start the provider refused last time is shown and still sent: only the provider sees a top-up", async () => {
  const capabilities = [entry("machines.lifecycle"), entry("machines.start", "temporarily_unavailable", "provider_request_rejected")];
  const human = api(capabilities);
  const shown = await run(["machines", "start", MACHINE_ID, "--yes"], human, { structured: false });
  assert.equal(shown.exit, 0, shown.stderr);
  assert.deepEqual(human.posts(), [`POST /v1/sessions/${MACHINE_ID}/start`]);
  assert.match(shown.stderr, /provider_request_rejected/u, "the reason is shown before the start");
  assert.match(shown.stdout, /Machine biotech-lab is running\./u);

  // JSON: stderr carries error records only, so the note is not written there.
  const structured = api(capabilities);
  const quiet = await run(["machines", "start", MACHINE_ID, "--yes"], structured);
  assert.equal(quiet.exit, 0, quiet.stderr);
  assert.equal(quiet.stderr, "");
  assert.deepEqual(structured.posts(), [`POST /v1/sessions/${MACHINE_ID}/start`]);

  // And when the provider refuses again, its own words are the answer.
  const again = api(capabilities, {
    transition: () => new Response(JSON.stringify({
      type: "https://api.getcuna.com/problems/provider_request_rejected", title: "Workspace provider rejected the request",
      status: 502, code: "provider_request_rejected", detail: "The workspace provider refused to start this Machine: billing restricted (balance_exhausted).",
      retryable: false, action: "none", request_id: "69660297-1c5b-4691-9452-ee07ab7e1c0c",
    }), { status: 502, headers: { "content-type": "application/problem+json" } }),
  });
  const { error } = await run(["machines", "start", MACHINE_ID, "--yes"], again);
  assert.equal(error.details.reason, "provider_request_rejected");
  assert.match(error.hint, /balance_exhausted/u);
});

test("a start refusal never blocks the supervisor update or a stop", async () => {
  // The update is the remedy a refused start points at; gating it on start
  // would lock the person out of the fix.
  const refusedStart = entry("machines.start", "temporarily_unavailable", "supervisor_upgrade_required");
  const update = api([entry("machines.lifecycle"), refusedStart]);
  const updated = await run(["machines", "update-supervisor", MACHINE_ID, "--yes"], update);
  assert.equal(updated.exit, 0, updated.stderr);
  assert.deepEqual(update.posts(), [`POST /v1/sessions/${MACHINE_ID}/supervisor/replace`]);

  const stop = api([entry("machines.lifecycle"), refusedStart, entry("machines.stop")], { action: "stop" });
  const stopped = await run(["machines", "stop", MACHINE_ID, "--yes"], stop);
  assert.equal(stopped.exit, 0, stopped.stderr);
  assert.deepEqual(stop.posts(), [`POST /v1/sessions/${MACHINE_ID}/stop`]);
});

/** The journey's own effects, over a client that answers `discoverCapabilities` as given. */
function journeyEffects(discoverCapabilities) {
  const transitions = [];
  const effects = createApiAgentJourneyEffects({
    client: {
      discoverCapabilities,
      async transitionMachine(id, action) { transitions.push(action); return { id, name: "biotech-lab", state: "running", agent: "claude-code" }; },
      async getMachine(id) { return { id, name: "biotech-lab", state: "running", agent: "claude-code" }; },
    },
    requestedAgent: "claude-code",
    async inspectWorkspace() { return { canonicalLocalRoot: "/work" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    async sleep() {},
  });
  return { effects, transitions };
}

function decoded(capabilities) {
  return async (scope, resourceId) => {
    const now = Date.now();
    return {
      schemaVersion: "1.0", subjectScope: scope, subjectId: resourceId,
      observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), etag: "r1-2",
      capabilities: capabilities.map(({ id, availability, reason_code }) => ({
        id, availability, interaction: "native", mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: [],
        ...(reason_code === undefined ? {} : { reasonCode: reason_code }),
      })),
    };
  };
}

test("the journey asks machines.start before it starts the Machine it chose", async () => {
  // The journey picks a stopped Machine because its declared provider fits,
  // which says nothing about whether it can start.
  const { effects, transitions } = journeyEffects(decoded([
    entry("machines.lifecycle"), entry("machines.start", "temporarily_unavailable", "control_credential_expired"),
  ]));
  await assert.rejects(
    effects.ensureMachineReady({ machineId: MACHINE_ID, observedState: "stopped", signal: new AbortController().signal }),
    (error) => error.details?.reason === "control_credential_expired" && error.details?.capability_id === "machines.start" &&
      error.message.includes("control_credential_expired"),
  );
  assert.deepEqual(transitions, [], "nothing was sent");
});

test("control: the journey starts as before when the Edge names no start-ability or cannot be read", async () => {
  for (const [label, discover] of [
    ["absent", decoded([entry("machines.lifecycle")])],
    ["send-through", decoded([entry("machines.lifecycle"), entry("machines.start", "temporarily_unavailable", "provider_request_rejected")])],
    ["read failed", async () => { throw new Error("capability read failed"); }],
  ]) {
    const { effects, transitions } = journeyEffects(discover);
    const ready = await effects.ensureMachineReady({ machineId: MACHINE_ID, observedState: "stopped", signal: new AbortController().signal });
    assert.equal(ready.state, "running", label);
    assert.deepEqual(transitions, ["start"], label);
  }
});

test("control: a Machine the journey finds running is not asked about starting", async () => {
  let reads = 0;
  const { effects, transitions } = journeyEffects(async () => { reads += 1; throw new Error("must not read"); });
  await effects.ensureMachineReady({ machineId: MACHINE_ID, observedState: "running", signal: new AbortController().signal });
  assert.equal(reads, 0);
  assert.deepEqual(transitions, []);
});

test("exit code and retryable follow the server's availability word", async () => {
  const server = api([entry("machines.lifecycle"), entry("machines.start", "temporarily_unavailable", "control_credential_expired")]);
  const { exit, error } = await run(["machines", "start", MACHINE_ID, "--yes"], server);
  assert.equal(error.code, "cuna.capability.temporarily_unavailable");
  assert.equal(exit, EXIT_CODES.network);
  assert.equal(error.retryable, true);
});
