import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ContractViolation,
  CunaError,
  EXIT_CODES,
  SUPERVISOR_LIVE_UPDATE_REQUEST_BUDGET_MS,
  SUPERVISOR_LIVE_UPDATE_WIRE,
  createCunaApiClient,
  createHttpTransport,
  decodeSupervisorLiveUpdate,
  liveSupervisorUpdateNotes,
  memoryStreams,
  runCli,
} from "../dist/index.js";

const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "44444444-4444-4444-8444-444444444444";
const SIBLING_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const EPOCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARTIFACT = "a".repeat(64);
const NOW = Date.parse("2026-08-08T00:00:00Z");

/**
 * A real filesystem, because the durable note is deleted with `unlink` and
 * inspected with `lstat` -- an in-memory adapter would make the settle path
 * untestable in exactly the direction that matters.
 */
function filePlatform(root) {
  return {
    kind: "linux",
    paths: {
      configDirectory: join(root, "cfg"),
      stateDirectory: join(root, "state"),
      runtimeDirectory: join(root, "run"),
    },
    async readSafeConfig(path, maximumBytes) {
      let text;
      try { text = await readFile(path, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return { exists: false }; throw error; }
      if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("oversized");
      return { exists: true, text };
    },
    async writeSafeConfig(path, text, maximumBytes) {
      if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("oversized");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    // The real adapter's exclusive-create semantics: the kernel decides, and
    // `false` means the name was already taken. `wx` is `O_WRONLY|O_CREAT|O_EXCL`.
    async createExclusiveConfig(path, text, maximumBytes) {
      if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("oversized");
      await mkdir(dirname(path), { recursive: true });
      try { await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
      return true;
    },
  };
}

function snapshot(subjectId) {
  return {
    schemaVersion: "1.0",
    subjectScope: "machine",
    subjectId,
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:30.000Z",
    etag: "fixture",
    capabilities: [{
      id: "machines.lifecycle",
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["machines:update"],
    }],
  };
}

function fakeClient(overrides = {}) {
  return {
    async getIdentity() {
      return { id: SESSION_A, email: "owner@example.test", workspaceAssigned: true, workspaceId: SESSION_B };
    },
    async discoverCapabilities(scope, resourceId) { return snapshot(resourceId); },
    async getMachine(id) { return { id, name: "live-dev", state: "running", agent: "opencode" }; },
    async replaceMachineSupervisor() { throw new Error("the in-place update must never fall back to stopped replacement"); },
    async transitionMachine() { throw new Error("the in-place update must never move machine lifecycle"); },
    async deleteMachine() { throw new Error("unexpected delete"); },
    async listAgentSessions() { return { items: [] }; },
    async updateMachineSupervisorInPlace() { throw new Error("unexpected in-place update"); },
    ...overrides,
  };
}

async function runJson(argv, root, client) {
  const streams = memoryStreams();
  const exit = await runCli(argv, {
    streams: streams.streams,
    platform: filePlatform(root),
    env: { CUNA_API_KEY: API_KEY },
    now: () => NOW,
    clientFactory: () => client,
  });
  const stdout = streams.stdout().trim();
  const stderr = streams.stderr().trim();
  const line = (stdout === "" ? stderr : stdout).split("\n").at(-1);
  return { exit, record: JSON.parse(line), stdout, stderr };
}

/**
 * One configuration file listing two profiles, both resolving to the same
 * default API origin. `resolveConfig` refuses a profile the file does not list
 * for every command except `login`, so the two names have to exist before
 * `--profile` can select them.
 */
async function twoProfileStore(root) {
  const file = join(root, "cfg", "config.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    schema_version: 1,
    profiles: { alpha: {}, beta: {} },
  }), "utf8");
}

async function noteFiles(root) {
  const directory = join(root, "state", "supervisor-live-updates");
  const found = [];
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(directory);
  return found;
}

function liveUpdateBody(sessions, machineId = MACHINE_ID) {
  return {
    machine: { id: machineId, name: "live-dev", status: "running", agent: "opencode" },
    control_generation: 7,
    artifact_sha256: ARTIFACT,
    installed_at: "2026-08-08T00:00:12.000Z",
    agent_sessions: sessions,
  };
}

/* -------------------------------------------------------------------------- */
/* CL1/CL2 — the operation, its binding, and its decoder                       */
/* -------------------------------------------------------------------------- */

test("the in-place update is one explicit POST on the Machine path with no body", async () => {
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return liveUpdateBody([{ agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" }]);
    },
  });
  const result = await client.updateMachineSupervisorInPlace(MACHINE_ID);
  assert.equal(result.machine.id, MACHINE_ID);
  assert.equal(result.controlGeneration, 7);
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/sessions/${MACHINE_ID}/supervisor/live-update`,
    settleWith: `cuna agent-sessions list --machine ${MACHINE_ID}`,
    budgetMs: SUPERVISOR_LIVE_UPDATE_REQUEST_BUDGET_MS,
    // No body and no idempotency key, so the transport may never send it twice
    // on its own. Asserted here because this literal is the only place the
    // opt-out exists for this operation.
    automaticRedispatch: false,
  }]);
  // The path id denotes the Machine, so a malformed Machine ID must never reach
  // the route.
  await assert.rejects(client.updateMachineSupervisorInPlace("not-a-machine-id"), CunaError);
  assert.equal(requests.length, 1);
});

test("a response bound to a sibling Machine is rejected, not reported", async () => {
  const client = createCunaApiClient({
    async request() {
      return liveUpdateBody([{ agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" }], SIBLING_ID);
    },
  });
  await assert.rejects(
    client.updateMachineSupervisorInPlace(MACHINE_ID),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      error.details.field === "machine.id",
  );
});

test("the decoder accepts the canonical result and refuses every drift from it", () => {
  const valid = liveUpdateBody([
    { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
    { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "exited" },
  ]);
  const decoded = decodeSupervisorLiveUpdate(valid);
  assert.equal(decoded.sessions.length, 2);
  assert.deepEqual(decoded.sessions.map((session) => session.outcome), ["preserved", "exited"]);
  assert.equal(decoded.artifactSha256, ARTIFACT);

  const reject = (mutate, label) => {
    const body = structuredClone(valid);
    mutate(body);
    assert.throws(() => decodeSupervisorLiveUpdate(body), ContractViolation, label);
  };
  reject((body) => { body.extra = 1; }, "an additional property");
  reject((body) => { delete body.control_generation; }, "a missing required key");
  reject((body) => { body.control_generation = 0; }, "a control generation below 1");
  reject((body) => { body.artifact_sha256 = "not-a-digest"; }, "a non-sha256 artifact");
  reject((body) => { body.installed_at = "whenever"; }, "an unparsable timestamp");
  reject((body) => { body.agent_sessions[0].outcome = "probably-fine"; }, "an unknown outcome word");
  reject((body) => { body.agent_sessions[1].agent_session_id = SESSION_A; }, "one session accounted for twice");
  reject((body) => { body.agent_sessions = Array.from({ length: 65 }, (_value, index) => ({
    agent_session_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    process_epoch: EPOCH_A,
    outcome: "preserved",
  })); }, "more sessions than the contract bounds");
});

test("the wire declaration records that its shape is not yet the vendored contract", async () => {
  // The prerequisite, as a check rather than a sentence in a document: the
  // vendored producer artifact does not carry this operation, which is exactly
  // why the decoder is hand-written. When a contract sync lands, this fails and
  // the projection decision has to be made again on purpose.
  const contract = JSON.parse(await readFile(new URL("../contracts/infra/cuna-api.openapi.json", import.meta.url), "utf8"));
  const operations = Object.values(contract.paths)
    .flatMap((item) => Object.values(item))
    .filter((operation) => operation !== null && typeof operation === "object" && !Array.isArray(operation))
    .map((operation) => operation.operationId);
  const vendored = operations.includes(SUPERVISOR_LIVE_UPDATE_WIRE.operationId);
  assert.equal(
    SUPERVISOR_LIVE_UPDATE_WIRE.source.state,
    vendored ? "vendored" : "producer_reference_not_vendored",
    vendored
      ? "the vendored contract now carries sessions.updateSupervisorInPlace: derive the schema from it and update SUPERVISOR_LIVE_UPDATE_WIRE.source"
      : "the vendored contract does not carry sessions.updateSupervisorInPlace",
  );
  if (vendored) {
    const path = contract.paths[SUPERVISOR_LIVE_UPDATE_WIRE.pathTemplate];
    assert.ok(path?.post, "the vendored operation must sit on the declared path and method");
    const schema = contract.components.schemas[SUPERVISOR_LIVE_UPDATE_WIRE.responseSchema];
    assert.deepEqual([...schema.required].sort(), [...SUPERVISOR_LIVE_UPDATE_WIRE.responseKeys].sort());
    assert.deepEqual(
      [...contract.components.schemas[SUPERVISOR_LIVE_UPDATE_WIRE.sessionSchema].properties.outcome.enum].sort(),
      [...SUPERVISOR_LIVE_UPDATE_WIRE.outcomes].sort(),
    );
  }
});

/* -------------------------------------------------------------------------- */
/* CL3 — the flow says what happened, per AgentSession                         */
/* -------------------------------------------------------------------------- */

test("a successful update reports each AgentSession and grants nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dispatched = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id) {
      dispatched += 1;
      assert.equal(id, MACHINE_ID);
      return decodeSupervisorLiveUpdate(liveUpdateBody([
        { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
        { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "preserved" },
      ]));
    },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(dispatched, 1);
  assert.equal(record.command, "machines.live-update-supervisor");
  assert.equal(record.data.summary.all_preserved, true);
  assert.equal(record.data.summary.preserved, 2);
  assert.equal(record.data.control_generation, 7);
  assert.equal(record.data.grants_observation_or_control, false);
  assert.equal(record.data.establishes_provider_login, false);
  assert.deepEqual(record.data.agent_sessions.map((session) => session.outcome), ["preserved", "preserved"]);
  // A settled outcome leaves no outstanding note behind.
  assert.deepEqual(await noteFiles(root), []);
});

test("a partially preserved 200 is never described as a completed update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A real terminal, so the human rendering is what is asserted; stderr is not
  // a TTY so no progress spinner runs inside the test.
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      return decodeSupervisorLiveUpdate(liveUpdateBody([
        { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
        { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "unknown" },
      ]));
    },
  });
  const exit = await runCli(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--no-color"], {
    streams: streams.streams,
    platform: filePlatform(root),
    env: { CUNA_API_KEY: API_KEY },
    now: () => NOW,
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  const human = streams.stdout();
  assert.match(human, /this update is not complete/u);
  assert.match(human, /unknown: Cuna could not re-read it/u);
  assert.doesNotMatch(human, /all \d+ AgentSessions were preserved/u);
  // An unknown custody outcome keeps this computer's record open.
  assert.equal((await noteFiles(root)).length, 1);
});

/* -------------------------------------------------------------------------- */
/* CL4 — an unknown outcome is never resolved by repeating the mutation        */
/* -------------------------------------------------------------------------- */

test("a pending outcome is reported as unknown and suppresses the next mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dispatched = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      dispatched += 1;
      // Exactly what the transport mints for the producer's 503 + retryable
      // Problem: a retryable network condition. The command must not read that
      // flag as permission to repeat THIS mutation.
      throw new CunaError({
        code: "cuna.network.service_unavailable",
        message: "Compatible supervisor not yet observed",
        exitCode: EXIT_CODES.network,
        retryable: true,
        details: { http_status: 503, reason: "supervisor_live_update_pending" },
      });
    },
  });

  const first = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(first.exit, EXIT_CODES.conflict);
  assert.equal(first.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.equal(first.record.error.retryable, false);
  assert.match(first.record.error.hint, /cuna agent-sessions list --machine/u);
  assert.match(first.record.error.hint, /will not repeat the update/u);
  assert.equal(dispatched, 1);
  assert.equal((await noteFiles(root)).length, 1);

  // The whole requirement: a FRESH invocation refuses instead of dispatching.
  const second = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(second.exit, EXIT_CODES.conflict);
  assert.equal(second.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.equal(dispatched, 1, "an outstanding unknown outcome must not be dispatched again");

  // Only an explicit, separate acknowledgement clears it, and it claims nothing.
  const cleared = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, client);
  assert.equal(cleared.exit, EXIT_CODES.success);
  assert.equal(cleared.record.data.local_record_cleared, true);
  assert.equal(cleared.record.data.server_state_changed, false);
  assert.equal(dispatched, 1, "clearing the local record must send nothing");
  assert.deepEqual(await noteFiles(root), []);

  const third = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(third.exit, EXIT_CODES.conflict);
  assert.equal(dispatched, 2, "after an explicit acknowledgement a new attempt is admitted");
});

test("REPRODUCTION: a second local profile cannot repeat the update the first left unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await twoProfileStore(root);
  const dispatched = [];
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id) {
      dispatched.push(id);
      throw new CunaError({
        code: "cuna.network.service_unavailable",
        message: "Supervisor update outcome unknown",
        exitCode: EXIT_CODES.network,
        retryable: true,
        details: { http_status: 503, reason: "supervisor_live_update_pending" },
      });
    },
  });

  // Profile alpha dispatches and never learns the outcome.
  const alpha = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--profile", "alpha", "--json"], root, client);
  assert.equal(alpha.exit, EXIT_CODES.conflict);
  assert.equal(alpha.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.deepEqual(dispatched, [MACHINE_ID]);

  // Profile beta, same API origin, same Machine. Selecting a different profile
  // is not a way around the suppression.
  const beta = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--profile", "beta", "--json"], root, client);
  assert.equal(beta.exit, EXIT_CODES.conflict);
  assert.equal(beta.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.equal(beta.record.error.details.dispatched_at, alpha.record.error.details.dispatched_at);
  assert.deepEqual(dispatched, [MACHINE_ID], "--profile must not clear another profile's unknown outcome");

  // The exclusion is per Machine, not a blanket lock: a different Machine on
  // the same origin is untouched by it. Without this the control could pass by
  // refusing everything.
  const sibling = await runJson(
    ["machines", "live-update-supervisor", SIBLING_ID, "--yes", "--profile", "beta", "--json"], root, client);
  assert.equal(sibling.exit, EXIT_CODES.conflict);
  assert.equal(sibling.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.deepEqual(dispatched, [MACHINE_ID, SIBLING_ID], "a different Machine must remain independent");
  assert.equal((await noteFiles(root)).length, 2);

  // And the acknowledgement is equally profile-independent: beta clears the
  // record alpha created, because they are the same record.
  const cleared = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--profile", "beta", "--json"], root, client);
  assert.equal(cleared.exit, EXIT_CODES.success);
  assert.equal(cleared.record.data.local_record_cleared, true);
  assert.equal(cleared.record.data.dispatched_at, alpha.record.error.details.dispatched_at);
  assert.equal(cleared.record.data.scope, "api_origin_and_machine");
  assert.equal((await noteFiles(root)).length, 1, "only the acknowledged Machine's record is dropped");

  const again = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--profile", "alpha", "--json"], root, client);
  assert.equal(again.exit, EXIT_CODES.conflict);
  assert.deepEqual(dispatched, [MACHINE_ID, SIBLING_ID, MACHINE_ID]);
});

test("the note is keyed by canonical API origin, and reading it needs no identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = filePlatform(root);
  // Four spellings of one origin, plus one genuinely different deployment.
  const notes = (baseUrl) => liveSupervisorUpdateNotes(platform, { baseUrl });
  await notes("https://api.getcuna.com").reserve(MACHINE_ID, "2026-08-08T00:00:00.000Z");
  for (const spelling of [
    "https://api.getcuna.com/",
    "https://API.GetCuna.com",
    "https://api.getcuna.com:443/v1?ignored=1#fragment",
  ]) {
    const found = await notes(spelling).read(MACHINE_ID);
    assert.equal(found.state, "outstanding", `${spelling} must resolve to the same note`);
    assert.equal(found.note.dispatchedAt, "2026-08-08T00:00:00.000Z");
  }
  assert.equal((await notes("https://api.example.invalid").read(MACHINE_ID)).state, "none");
  assert.equal((await notes("https://api.getcuna.com").read(SIBLING_ID)).state, "none");

  // The label is optional, is never required to read the note, and never admits
  // anything: a note carrying someone else's account still reads back.
  const other = "99999999-9999-4999-8999-999999999999";
  await notes("https://api.getcuna.com").reserve(SIBLING_ID, "2026-08-08T00:00:01.000Z", other);
  const labelled = await notes("https://api.getcuna.com").read(SIBLING_ID);
  assert.equal(labelled.note.account, other);
  assert.equal(labelled.note.dispatchedAt, "2026-08-08T00:00:01.000Z");
});

/* -------------------------------------------------------------------------- */
/* UR1-A — the reservation is exclusive at the OS level                        */
/* -------------------------------------------------------------------------- */

test("UR1-A: two interleaved reservations produce exactly one winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = filePlatform(root);

  // The reviewer's interleaving, forced here in one process against the real
  // primitive: BOTH callers observe the slot free, and only then does either
  // write. Under check-then-act both won; the exclusive create admits one.
  const seen = [];
  const observing = Object.freeze({
    ...base,
    async createExclusiveConfig(path, text, maximumBytes) {
      seen.push(path);
      return base.createExclusiveConfig(path, text, maximumBytes);
    },
  });
  const notes = liveSupervisorUpdateNotes(observing, { baseUrl: "https://api.getcuna.com" });
  const preA = await notes.read(MACHINE_ID);
  const preB = await notes.read(MACHINE_ID);
  assert.equal(preA.state, "none");
  assert.equal(preB.state, "none", "both callers must see the slot free before either writes");

  const [first, second] = await Promise.all([
    notes.reserve(MACHINE_ID, "2026-09-13T00:00:01.000Z"),
    notes.reserve(MACHINE_ID, "2026-09-13T00:00:02.000Z"),
  ]);
  const winners = [first, second].filter((value) => value !== undefined);
  assert.equal(winners.length, 1, "exactly one reservation may be admitted");
  assert.equal(seen.length, 2, "both callers really attempted the exclusive create");
  const held = await notes.read(MACHINE_ID);
  assert.equal(held.state, "outstanding");
  assert.equal(held.note.dispatchedAt, winners[0].dispatchedAt,
    "the surviving record must be the winner's, not whoever wrote last");

  // CONTROL: with the slot free again, the same call succeeds. Without this the
  // assertion above would also pass for a store that never admits anything.
  await notes.discard(MACHINE_ID);
  const alone = await notes.reserve(MACHINE_ID, "2026-09-13T00:00:03.000Z");
  assert.notEqual(alone, undefined, "an uncontended reservation must still be admitted");
});

test("UR1-A: a host without exclusive reservation refuses instead of dispatching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dispatched = 0;
  const full = filePlatform(root);
  const withoutExclusion = {
    kind: full.kind,
    paths: full.paths,
    readSafeConfig: (...args) => full.readSafeConfig(...args),
    writeSafeConfig: (...args) => full.writeSafeConfig(...args),
  };
  const streams = memoryStreams();
  const exit = await runCli(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform: withoutExclusion,
    env: { CUNA_API_KEY: API_KEY },
    now: () => NOW,
    clientFactory: () => fakeClient({
      async updateMachineSupervisorInPlace() { dispatched += 1; return undefined; },
    }),
  });
  assert.equal(exit, EXIT_CODES.internal);
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(record.error.code, "cuna.machine.live_supervisor_update_unrecordable");
  assert.equal(record.error.details.reason, "no_exclusive_reservation");
  assert.equal(dispatched, 0, "a host that cannot reserve must not dispatch");
});

/* -------------------------------------------------------------------------- */
/* UR1-B — settlement is bound to the exact dispatch                           */
/* -------------------------------------------------------------------------- */

test("UR1-B: a stale completion cannot erase a newer record or admit a third dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = liveSupervisorUpdateNotes(filePlatform(root), { baseUrl: "https://api.getcuna.com" });
  const T1 = "2026-09-13T00:00:01.000Z";
  const T2 = "2026-09-13T00:00:09.000Z";

  await notes.reserve(MACHINE_ID, T1);
  // The owner's explicit acknowledgement while p1 is still in flight.
  assert.equal(await notes.discard(MACHINE_ID), true);
  const p2 = await notes.reserve(MACHINE_ID, T2);
  assert.notEqual(p2, undefined);

  // p1's late authoritative answer. It owns T1, and T1 is gone.
  assert.equal(await notes.settle(MACHINE_ID, T1), "superseded");
  const surviving = await notes.read(MACHINE_ID);
  assert.equal(surviving.state, "outstanding");
  assert.equal(surviving.note.dispatchedAt, T2, "a newer process's intent must survive an older completion");

  // And no third dispatch is admitted while p2 is outstanding.
  assert.equal(await notes.reserve(MACHINE_ID, "2026-09-13T00:00:20.000Z"), undefined);

  // CONTROL: the owning dispatch does settle, and settling twice is `absent`,
  // not an error -- so "superseded" above is the ownership check and not a
  // settle that never removes anything.
  assert.equal(await notes.settle(MACHINE_ID, T2), "settled");
  assert.equal((await notes.read(MACHINE_ID)).state, "none");
  assert.equal(await notes.settle(MACHINE_ID, T2), "absent");

  // CONTROL: a sibling Machine is untouched by every settle above.
  await notes.reserve(SIBLING_ID, "2026-09-13T00:00:30.000Z");
  await notes.settle(MACHINE_ID, T1);
  assert.equal((await notes.read(SIBLING_ID)).note.dispatchedAt, "2026-09-13T00:00:30.000Z");
});

/* -------------------------------------------------------------------------- */
/* UR1-C — an unreadable record is named, blocking, and clearable              */
/* -------------------------------------------------------------------------- */

async function writeCorruptRecord(root, machineId, bytes) {
  const digest = createHash("sha256")
    .update(JSON.stringify(["supervisor-live-update", "https://api.getcuna.com"]))
    .digest("hex");
  const path = join(root, "state", "supervisor-live-updates", digest, `${machineId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, "utf8");
  return path;
}

test("UR1-C: an unreadable record blocks the mutation and says so by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await writeCorruptRecord(root, MACHINE_ID, "{ not json\n");
  let dispatched = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { dispatched += 1; return undefined; },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(record.error.code, "cuna.machine.live_supervisor_update_record_unreadable");
  assert.equal(record.error.details.record_path, path);
  assert.match(record.error.hint, /--forget-unknown/u);
  assert.match(record.error.hint, /works on an unreadable record/u);
  assert.equal(dispatched, 0);
});

test("UR1-C: --forget-unknown clears an unreadable record and claims no cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCorruptRecord(root, MACHINE_ID, "{ not json\n");
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, fakeClient());
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(record.data.local_record_cleared, true);
  assert.equal(record.data.record_readable, false);
  assert.equal(record.data.server_state_changed, false);
  assert.equal(record.data.dispatched_at, undefined, "an unreadable record cannot name a dispatch time");
  assert.deepEqual(await noteFiles(root), []);

  // The dispatch path is reachable again afterwards. Without this the repair
  // could be "refuse forever", which is not recovery.
  let dispatched = 0;
  const after = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root,
    fakeClient({
      async updateMachineSupervisorInPlace() {
        dispatched += 1;
        return decodeSupervisorLiveUpdate(liveUpdateBody([]));
      },
    }));
  assert.equal(after.exit, EXIT_CODES.success);
  assert.equal(dispatched, 1);

  // CONTROL: a well-formed record takes the readable branch, which is how we
  // know `record_readable: false` above is the corruption and not a constant.
  await writeCorruptRecord(root, SIBLING_ID, `${JSON.stringify({
    version: 1,
    scope: createHash("sha256").update(JSON.stringify(["supervisor-live-update", "https://api.getcuna.com"])).digest("hex"),
    machineId: SIBLING_ID,
    dispatchedAt: "2026-09-13T00:00:05.000Z",
  })}\n`);
  const readable = await runJson(
    ["machines", "live-update-supervisor", SIBLING_ID, "--forget-unknown", "--json"], root, fakeClient());
  assert.equal(readable.record.data.record_readable, true);
  assert.equal(readable.record.data.dispatched_at, "2026-09-13T00:00:05.000Z");
});

/* -------------------------------------------------------------------------- */
/* UR3 — the transport cannot re-dispatch this POST                            */
/* -------------------------------------------------------------------------- */

test("UR3: a connect-phase failure sends this operation exactly once", async () => {
  const connectFailure = () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED", syscall: "connect",
    });
    return error;
  };
  const dispatchesFor = async (call) => {
    let dispatches = 0;
    const transport = createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      apiKey: API_KEY,
      fetch: async () => { dispatches += 1; throw connectFailure(); },
    });
    const client = createCunaApiClient(transport);
    let failure;
    try { await call(client); } catch (error) { failure = error; }
    return { dispatches, failure };
  };

  const subject = await dispatchesFor((client) => client.updateMachineSupervisorInPlace(MACHINE_ID));
  assert.equal(subject.dispatches, 1, "the in-place update must never be re-sent by the transport");
  assert.equal(subject.failure.code, "cuna.network.failed");
  assert.equal(subject.failure.details.remote_outcome, "not_sent");
  assert.equal(subject.failure.details.attempts, 1);
  // Still retryable: the PERSON may retry, and their retry passes the command's
  // duplicate-suppression gate. Only the silent one is gone.
  assert.equal(subject.failure.retryable, true);

  // CONTROL: every other operation keeps the automatic connect retry, so the
  // assertion above is this request's opt-out and not a transport-wide change.
  const control = await dispatchesFor((client) => client.replaceMachineSupervisor(MACHINE_ID));
  assert.equal(control.dispatches, 2, "unrelated operations keep the connect-phase retry");
  assert.equal(control.failure.details.attempts, 2);
});

test("--yes and --forget-unknown are different decisions and cannot be combined", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--forget-unknown", "--json"],
    root, fakeClient());
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(record.error.code, "cuna.usage.invalid");
});

test("a refusal the producer makes before any change leaves no record behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dispatched = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      dispatched += 1;
      throw new CunaError({
        code: "cuna.remote.conflict",
        message: "Supervisor update not required",
        exitCode: EXIT_CODES.conflict,
        hint: "This Machine already runs every artifact in the current supervisor release.",
        details: { http_status: 409, reason: "supervisor_live_update_not_required" },
      });
    },
  });
  const first = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(first.exit, EXIT_CODES.conflict);
  // The producer's own refusal survives unchanged; no unknown-outcome story is
  // invented on top of it.
  assert.equal(first.record.error.code, "cuna.remote.conflict");
  assert.deepEqual(await noteFiles(root), []);

  const second = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(second.exit, EXIT_CODES.conflict);
  assert.equal(dispatched, 2, "a decided refusal must not block the next attempt");
});

/* -------------------------------------------------------------------------- */
/* CL5 — unmet preconditions refuse, and never repair themselves               */
/* -------------------------------------------------------------------------- */

test("a stopped Machine is refused and never started, replaced or stopped-updated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dispatched = 0;
  const client = fakeClient({
    async getMachine(id) { return { id, name: "parked", state: "stopped", agent: "opencode" }; },
    async updateMachineSupervisorInPlace() { dispatched += 1; return undefined; },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(record.error.code, "cuna.machine.live_supervisor_update_requires_running");
  assert.match(record.error.hint, /machines update-supervisor/u);
  assert.equal(dispatched, 0);
  assert.deepEqual(await noteFiles(root), []);
});

test("the mutation requires explicit confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--json"], root, fakeClient());
  assert.equal(exit, EXIT_CODES.policy);
  assert.equal(record.error.code, "cuna.confirmation.required");
});
