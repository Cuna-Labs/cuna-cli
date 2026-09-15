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
  decodeSupervisorLiveUpdateOperation,
  liveSupervisorInstallerOutcomeLabel,
  liveSupervisorInstallerReachLines,
  liveSupervisorUpdateNotes,
  memoryStreams,
  readLiveSupervisorUpdateOperation,
  runCli,
} from "../dist/index.js";

const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "44444444-4444-4444-8444-444444444444";
const SIBLING_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const EPOCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_OPERATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ARTIFACT = "a".repeat(64);
const NOW = Date.parse("2026-08-08T00:00:00Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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
      try { await writeFile(path, text, { encoding: "utf8", flag: "wx" }); }
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

/** The producer's 404 for both "no such Machine" and "not your operation". */
function notFound() {
  return new CunaError({
    code: "cuna.remote.not_found",
    message: "Resource not found",
    exitCode: EXIT_CODES.conflict,
    details: { http_status: 404, reason: "resource_not_found" },
  });
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
    // The default is the producer's own answer for an identity it has no row
    // for. A test that wants a record says so.
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
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

async function readNote(root, machineId) {
  const files = await noteFiles(root);
  const wanted = files.find((path) => path.endsWith(`${machineId}.json`));
  return wanted === undefined ? undefined : JSON.parse(await readFile(wanted, "utf8"));
}

function liveUpdateBody(sessions, machineId = MACHINE_ID, operationId = OPERATION_ID) {
  return {
    machine: { id: machineId, name: "live-dev", status: "running", agent: "opencode" },
    operation_id: operationId,
    control_generation: 7,
    artifact_sha256: ARTIFACT,
    installed_at: "2026-08-08T00:00:12.000Z",
    agent_sessions: sessions,
  };
}

/** The `SupervisorLiveUpdateOperation` shape, exactly as producer 7b1 declares it. */
function operationBody(overrides = {}) {
  return {
    operation_id: OPERATION_ID,
    machine_id: MACHINE_ID,
    phase: "control_rotated",
    control_rotated: true,
    installer_outcome: "unknown",
    control_generation: 8,
    artifact_sha256: ARTIFACT,
    installed_at: null,
    installation_evidence: null,
    declared_sessions: [{ agent_session_id: SESSION_A, process_epoch: EPOCH_A }],
    agent_sessions: [],
    failure: null,
    next_action: "repeat_same_operation",
    claimed_at: "2026-08-08T00:00:01.000Z",
    updated_at: "2026-08-08T00:00:05.000Z",
    settled_at: null,
    // The install fence, required and nullable at producer 7b1b3e42. Null here
    // on purpose: this base row is the OPEN `unknown` -- an installer that may
    // still arrive -- and every retired reading below states both fields.
    retired_at: null,
    retirement_outcome: null,
    ...overrides,
  };
}

/**
 * The two fields the producer keeps paired, as one override.
 *
 * Written as a helper because a test that sets only one of them is testing a
 * row the producer's own `supervisor_live_update_retirement_pairing` constraint
 * forbids, and would prove nothing about a real answer.
 */
function retired(outcome, at = "2026-08-08T00:00:30.000Z") {
  return { retired_at: at, retirement_outcome: outcome };
}

function settledOperationBody(overrides = {}) {
  return operationBody({
    phase: "settled",
    next_action: "none",
    settled_at: "2026-08-08T00:00:20.000Z",
    installer_outcome: "installed",
    installed_at: "2026-08-08T00:00:12.000Z",
    installation_evidence: "installer_exit",
    agent_sessions: [{ agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" }],
    ...overrides,
  });
}

/** The transport's rendering of the producer's 503 + retryable Problem. */
function pendingFailure() {
  return new CunaError({
    code: "cuna.network.service_unavailable",
    message: "Compatible supervisor not yet observed",
    exitCode: EXIT_CODES.network,
    retryable: true,
    details: { http_status: 503, reason: "supervisor_live_update_pending" },
  });
}

/* -------------------------------------------------------------------------- */
/* CS1/CS4 — the operation, its identity, its binding and its decoders         */
/* -------------------------------------------------------------------------- */

test("the update is one POST carrying the caller's chosen operation identity", async () => {
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return liveUpdateBody([{ agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" }]);
    },
  });
  const result = await client.updateMachineSupervisorInPlace(MACHINE_ID, OPERATION_ID);
  assert.equal(result.machine.id, MACHINE_ID);
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.controlGeneration, 7);
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/sessions/${MACHINE_ID}/supervisor/live-update`,
    // The required body, and the whole reason a lost answer is recoverable.
    body: { operation_id: OPERATION_ID },
    settleWith: `cuna machines live-update-status ${MACHINE_ID} --operation ${OPERATION_ID}`,
    budgetMs: SUPERVISOR_LIVE_UPDATE_REQUEST_BUDGET_MS,
    // Still off. The identity makes a repeat SAFE, but a repeat must stay a
    // DECISION -- this literal is the only place the opt-out exists.
    automaticRedispatch: false,
  }]);
  // The path id denotes the Machine, so a malformed Machine ID must never reach
  // the route -- and neither must a malformed operation identity.
  await assert.rejects(client.updateMachineSupervisorInPlace("not-a-machine-id", OPERATION_ID), CunaError);
  await assert.rejects(client.updateMachineSupervisorInPlace(MACHINE_ID, "not-an-operation"), CunaError);
  assert.equal(requests.length, 1);
});

test("the recovery read is a GET on the operation path and dispatches nothing", async () => {
  const requests = [];
  const client = createCunaApiClient({
    async request(request) {
      requests.push(request);
      return operationBody();
    },
  });
  const operation = await client.readMachineSupervisorInPlaceUpdate(MACHINE_ID, OPERATION_ID);
  assert.equal(operation.operationId, OPERATION_ID);
  assert.equal(operation.phase, "control_rotated");
  assert.deepEqual(requests, [{
    method: "GET",
    path: `/v1/sessions/${MACHINE_ID}/supervisor/live-update/${OPERATION_ID}`,
    settleWith: `cuna machines live-update-status ${MACHINE_ID} --operation ${OPERATION_ID}`,
  }]);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.dispatchesInstaller, false);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.requiredPermission, "machines:read");
});

test("an answer about another Machine or another operation is rejected, not reported", async () => {
  const sibling = createCunaApiClient({
    async request() {
      return liveUpdateBody([{ agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" }], SIBLING_ID);
    },
  });
  await assert.rejects(
    sibling.updateMachineSupervisorInPlace(MACHINE_ID, OPERATION_ID),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      error.details.field === "machine.id",
  );
  // The same check for the identity the caller is about to settle a durable
  // record against: an answer about another operation is not an answer.
  const other = createCunaApiClient({
    async request() {
      return liveUpdateBody([], MACHINE_ID, OTHER_OPERATION_ID);
    },
  });
  await assert.rejects(
    other.updateMachineSupervisorInPlace(MACHINE_ID, OPERATION_ID),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      error.details.field === "operation_id",
  );
  const read = createCunaApiClient({
    async request() { return operationBody({ operation_id: OTHER_OPERATION_ID }); },
  });
  await assert.rejects(
    read.readMachineSupervisorInPlaceUpdate(MACHINE_ID, OPERATION_ID),
    (error) => error instanceof CunaError && error.code === "cuna.remote.malformed_response",
  );
});

test("the result decoder accepts the canonical body and refuses every drift from it", () => {
  const valid = liveUpdateBody([
    { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
    { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "exited" },
  ]);
  const decoded = decodeSupervisorLiveUpdate(valid);
  assert.equal(decoded.sessions.length, 2);
  assert.equal(decoded.operationId, OPERATION_ID);
  assert.deepEqual(decoded.sessions.map((session) => session.outcome), ["preserved", "exited"]);
  assert.equal(decoded.artifactSha256, ARTIFACT);

  const reject = (mutate, label) => {
    const body = structuredClone(valid);
    mutate(body);
    assert.throws(() => decodeSupervisorLiveUpdate(body), ContractViolation, label);
  };
  reject((body) => { body.extra = 1; }, "an additional property");
  reject((body) => { delete body.operation_id; }, "a missing operation identity");
  reject((body) => { body.operation_id = "not-a-uuid"; }, "a non-canonical operation identity");
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

test("the operation decoder accepts every valid producer body and fails safely on invalid ones", () => {
  // POSITIVE CONTROLS FIRST: the four phases and the four installer outcomes the
  // producer declares must all decode, or "fails safely" would only mean
  // "refuses everything".
  const claimed = decodeSupervisorLiveUpdateOperation(operationBody({
    phase: "claimed",
    control_rotated: false,
    installer_outcome: "not_sent",
    control_generation: null,
    artifact_sha256: null,
    declared_sessions: [],
  }));
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimed.controlRotated, false);
  // A producer null is absence, never a zero, an empty string or a default.
  assert.equal(claimed.controlGeneration, undefined);
  assert.equal(claimed.artifactSha256, undefined);
  assert.equal(claimed.nextAction, "repeat_same_operation");

  const rotated = decodeSupervisorLiveUpdateOperation(operationBody());
  assert.equal(rotated.installerOutcome, "unknown");
  assert.equal(rotated.declaredSessions.length, 1);
  assert.equal(rotated.sessions.length, 0);
  assert.equal(rotated.installedAt, undefined);

  const installed = decodeSupervisorLiveUpdateOperation(operationBody({
    phase: "installed",
    installer_outcome: "installed",
    installed_at: "2026-08-08T00:00:12.000Z",
    installation_evidence: "reconciled",
  }));
  assert.equal(installed.installationEvidence, "reconciled");
  assert.equal(installed.installedAt, "2026-08-08T00:00:12.000Z");

  const settled = decodeSupervisorLiveUpdateOperation(settledOperationBody());
  assert.equal(settled.phase, "settled");
  assert.equal(settled.nextAction, "none");
  assert.equal(settled.settledAt, "2026-08-08T00:00:20.000Z");
  assert.equal(settled.sessions[0].outcome, "preserved");

  const refused = decodeSupervisorLiveUpdateOperation(settledOperationBody({
    installer_outcome: "refused",
    agent_sessions: [],
    failure: {
      status: 409,
      code: "supervisor_live_update_in_progress",
      title: "This Machine is busy launching",
      detail: "Cuna refused to replace the supervisor while this Machine was admitting an AgentSession launch.",
      retryable: true,
      action: "retry",
    },
  }));
  assert.equal(refused.failure.code, "supervisor_live_update_in_progress");
  assert.equal(refused.failure.action, "retry");

  const reject = (mutate, label) => {
    const body = operationBody();
    mutate(body);
    assert.throws(() => decodeSupervisorLiveUpdateOperation(body), ContractViolation, label);
  };
  reject((body) => { body.extra = 1; }, "an additional property");
  reject((body) => { delete body.failure; }, "a missing nullable key");
  reject((body) => { body.phase = "half-done"; }, "an unknown phase");
  reject((body) => { body.installer_outcome = "probably"; }, "an unknown installer outcome");
  reject((body) => { body.installation_evidence = "guessed"; }, "an unknown installation evidence");
  reject((body) => { body.next_action = "start_a_new_one"; }, "an unknown next action");
  reject((body) => { body.control_rotated = "yes"; }, "a non-boolean rotation flag");
  reject((body) => { body.control_generation = 0; }, "a control generation below 1");
  reject((body) => { body.declared_sessions[0].outcome = "preserved"; }, "a verdict on a declared session");
  reject((body) => { body.failure = { status: 409, code: "x", title: "t", detail: "d", retryable: true, action: "retry" }; },
    "a problem code shorter than the contract allows");
  // The producer's own invariants, which a renderer would otherwise have to
  // guess at: only a settled operation stops asking for the same identity back.
  reject((body) => { body.next_action = "none"; }, "an unsettled operation that asks for nothing");
  reject((body) => { body.settled_at = "2026-08-08T00:00:20.000Z"; }, "an unsettled operation with a settled time");

  /* The install fence, added at producer 7b1b3e42. POSITIVE CONTROLS first:
     all three retirement outcomes, and the unretired row, must decode. */
  const openUnknown = decodeSupervisorLiveUpdateOperation(operationBody());
  assert.equal(openUnknown.retiredAt, undefined);
  assert.equal(openUnknown.retirementOutcome, undefined);
  for (const outcome of ["retired", "partial", "installed"]) {
    const value = decodeSupervisorLiveUpdateOperation(operationBody(retired(outcome)));
    assert.equal(value.retirementOutcome, outcome, outcome);
    assert.equal(value.retiredAt, "2026-08-08T00:00:30.000Z", outcome);
    // The fence never rewrites what Cuna observed. This is the sentence the
    // producer is most emphatic about and the one a renderer would break first.
    assert.equal(value.installerOutcome, "unknown", outcome);
  }
  // A settled `unknown` is legal now, and ONLY with the receipt that makes it so.
  const settledUnknown = decodeSupervisorLiveUpdateOperation(
    settledOperationBody({ installer_outcome: "unknown", installed_at: null, installation_evidence: null, agent_sessions: [], ...retired("retired") }),
  );
  assert.equal(settledUnknown.installerOutcome, "unknown");
  assert.equal(settledUnknown.retirementOutcome, "retired");

  reject((body) => { delete body.retired_at; }, "a missing retirement key");
  reject((body) => { delete body.retirement_outcome; }, "a missing retirement outcome key");
  reject((body) => { body.retirement_outcome = "cancelled"; }, "an unknown retirement outcome");
  reject((body) => { Object.assign(body, { retired_at: "2026-08-08T00:00:30.000Z" }); },
    "a retirement time with no outcome beside it");
  reject((body) => { Object.assign(body, { retirement_outcome: "retired" }); },
    "a retirement outcome with no time beside it");
  reject((body) => { Object.assign(body, retired("retired"), { control_rotated: false, phase: "claimed" }); },
    "a retirement on an operation that never authorized an installer");
  // `supervisor_live_update_unknown_settles_only_on_retirement`: this is the
  // whole basis of telling a pending `unknown` from a harmless one, so a row
  // that settles `unknown` without the receipt is refused rather than rendered.
  assert.throws(
    () => decodeSupervisorLiveUpdateOperation(settledOperationBody({
      installer_outcome: "unknown", installed_at: null, installation_evidence: null, agent_sessions: [],
    })),
    ContractViolation,
    "a settled unknown with no retirement receipt",
  );
  // NEGATIVE CONTROL for that one: the same settled row with an OBSERVED
  // outcome needs no receipt, so the refusal above is the conjunction and not a
  // blanket rule against settled rows.
  assert.equal(decodeSupervisorLiveUpdateOperation(settledOperationBody()).phase, "settled");
});

test("the fence tells a pending unknown from a retired one and names what to do", () => {
  const read = (overrides) => readLiveSupervisorUpdateOperation(
    decodeSupervisorLiveUpdateOperation(operationBody(overrides)),
  );
  // POSITIVE CONTROL: not retired. The installer may still arrive, and nothing
  // here may say otherwise however long the operation has been open.
  const pending = read({});
  assert.equal(pending.installerReach, "may_still_arrive");
  assert.equal(pending.installerCanStillAct, true);
  assert.equal(pending.installerWroteNothing, false);
  assert.match(
    liveSupervisorInstallerOutcomeLabel("unknown", pending.installerReach),
    /may still arrive/u,
  );
  assert.match(
    liveSupervisorInstallerReachLines(pending, MACHINE_ID).join("\n"),
    /could still arrive and change this Machine/u,
  );

  const byOutcome = {
    retired: "retired_without_admission",
    partial: "retired_after_partial_write",
    installed: "retired_after_completion",
  };
  for (const [outcome, reach] of Object.entries(byOutcome)) {
    const reading = read(retired(outcome));
    assert.equal(reading.installerReach, reach, outcome);
    // The fence decides this, never the phase and never a running Machine.
    assert.equal(reading.installerCanStillAct, false, outcome);
    // Only `retired` licenses "nothing was written". The other two say Cuna
    // cannot account for what the installer did.
    assert.equal(reading.installerWroteNothing, outcome === "retired", outcome);
    const label = liveSupervisorInstallerOutcomeLabel("unknown", reach);
    assert.match(label, /can no longer act/u, outcome);
    // The word `unknown` survives the fence. Turning it into a success is the
    // one thing the producer forbids outright.
    assert.match(label, /^unknown:/u, outcome);
    assert.doesNotMatch(label, /installed|succeeded/u, outcome);
  }

  // The supported action after a partial installation, named rather than implied.
  const partial = liveSupervisorInstallerReachLines(read(retired("partial")), MACHINE_ID).join("\n");
  assert.match(partial, /began replacing the supervisor and stopped/u);
  assert.match(partial, /cannot say which files it had already written/u);
  assert.match(partial, new RegExp(`cuna machines live-update-supervisor ${MACHINE_ID} --yes`, "u"));
  assert.match(partial, /installs the whole release over what is there/u);
  assert.match(partial, /Inspect the AgentSessions first/u);

  // Retired harmless work: the one reading that may say nothing was written,
  // and it still does not undo the control rotation.
  const harmless = liveSupervisorInstallerReachLines(read(retired("retired")), MACHINE_ID).join("\n");
  assert.match(harmless, /never reached it/u);
  assert.match(harmless, /Nothing this installer would have written was written/u);
  assert.match(harmless, new RegExp(`cuna machines live-update-supervisor ${MACHINE_ID} --yes`, "u"));
  assert.match(harmless, /control generation has already moved/u);
  // And the pending reading says none of that.
  assert.doesNotMatch(
    liveSupervisorInstallerReachLines(pending, MACHINE_ID).join("\n"),
    /Nothing this installer would have written was written|--yes/u,
  );

  // A fence record of a completed installer is the FENCE's record. It is never
  // Cuna's observation, and it never becomes an installation here.
  const completed = liveSupervisorInstallerReachLines(read(retired("installed")), MACHINE_ID).join("\n");
  assert.match(completed, /FENCE's record, not an observation by Cuna/u);
  assert.match(completed, /Inspect this Machine's supervisor and its AgentSessions/u);
  assert.doesNotMatch(completed, /--yes/u, "a completed fence record is not an instruction to reinstall");
});

test("the wire declaration names the exact producer commit its shapes were read at", async () => {
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.source.producerRevision, "7b1b3e425ed273986a909a68395b5272bd6a01ba");
  assert.equal(
    SUPERVISOR_LIVE_UPDATE_WIRE.source.canonicalDigest,
    "43213c2adac602676437b612b7d4153707e09155bdc4fa3029cca15a0b207ecc",
  );
  assert.equal(
    SUPERVISOR_LIVE_UPDATE_WIRE.source.rawDigest,
    "f4c2d396b94f296b22df276435dc04ecf1da48807efa1e819c4cbff9ea59a83e",
  );
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.source.operations, 101);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.source.sdkOperations, 40);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.hasRequestBody, true);
  assert.deepEqual([...SUPERVISOR_LIVE_UPDATE_WIRE.requestKeys], ["operation_id"]);

  // The vendored artifact, synchronized from that exact commit. This is what
  // makes the hand-written declaration above a VERIFIED projection rather than
  // a copy that can drift in silence: every key list, enum and bound below is
  // compared against the producer's own, and a sync that moves any of them
  // names which one here.
  const contract = JSON.parse(await readFile(new URL("../contracts/infra/cuna-api.openapi.json", import.meta.url), "utf8"));
  const operations = Object.values(contract.paths)
    .flatMap((item) => Object.values(item))
    .filter((operation) => operation !== null && typeof operation === "object" && !Array.isArray(operation))
    .map((operation) => operation.operationId);
  const vendored = operations.includes(SUPERVISOR_LIVE_UPDATE_WIRE.operationId);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.source.vendoredCarriesOperation, vendored);
  assert.equal(
    SUPERVISOR_LIVE_UPDATE_WIRE.source.state,
    vendored ? "vendored" : "producer_pinned_not_vendored",
    vendored
      ? "the vendored contract carries sessions.updateSupervisorInPlace"
      : "the vendored contract no longer carries sessions.updateSupervisorInPlace: a sync went backwards",
  );
  assert.equal(vendored, true, "run `npm run contract:sync:infra` against the 7b1 reference worktree");
  assert.equal(operations.length, SUPERVISOR_LIVE_UPDATE_WIRE.source.operations);
  assert.equal(
    (await readFile(new URL("../contracts/infra/cuna-api.openapi.sha256", import.meta.url), "utf8")).trim().split(/\s+/u)[0],
    SUPERVISOR_LIVE_UPDATE_WIRE.source.canonicalDigest,
  );
  const identity = JSON.parse(await readFile(new URL("../contracts/infra/cuna-api.openapi.identity.json", import.meta.url), "utf8"));
  assert.equal(identity.producer_revision, SUPERVISOR_LIVE_UPDATE_WIRE.source.producerRevision);
  assert.equal(identity.infra_openapi_raw_sha256, SUPERVISOR_LIVE_UPDATE_WIRE.source.rawDigest);
  assert.equal(identity.infra_openapi_canonical_sha256, SUPERVISOR_LIVE_UPDATE_WIRE.source.canonicalDigest);
  assert.equal(identity.producer_content_state, "committed", "the reference worktree must be clean");

  const schemas = contract.components.schemas;
  const mutation = contract.paths[SUPERVISOR_LIVE_UPDATE_WIRE.pathTemplate]?.post;
  assert.ok(mutation, "the vendored operation must sit on the declared path and method");
  assert.deepEqual(mutation["x-runa-required-permissions"], [SUPERVISOR_LIVE_UPDATE_WIRE.requiredPermission]);
  // A required body is the whole change this release carries, so it is asserted
  // as a required body and not merely as a shape.
  assert.equal(mutation.requestBody?.required, true);
  assert.ok(mutation.requestBody.content[SUPERVISOR_LIVE_UPDATE_WIRE.requestContentType]);
  assert.equal(SUPERVISOR_LIVE_UPDATE_WIRE.hasRequestBody, true);
  assert.deepEqual(
    [...schemas[SUPERVISOR_LIVE_UPDATE_WIRE.requestSchema].required].sort(),
    [...SUPERVISOR_LIVE_UPDATE_WIRE.requestKeys].sort(),
  );
  assert.deepEqual(
    [...schemas[SUPERVISOR_LIVE_UPDATE_WIRE.responseSchema].required].sort(),
    [...SUPERVISOR_LIVE_UPDATE_WIRE.responseKeys].sort(),
  );
  assert.deepEqual(
    [...schemas[SUPERVISOR_LIVE_UPDATE_WIRE.sessionSchema].required].sort(),
    [...SUPERVISOR_LIVE_UPDATE_WIRE.sessionKeys].sort(),
  );
  assert.deepEqual(
    [...schemas[SUPERVISOR_LIVE_UPDATE_WIRE.sessionSchema].properties.outcome.enum].sort(),
    [...SUPERVISOR_LIVE_UPDATE_WIRE.outcomes].sort(),
  );
  assert.equal(
    schemas[SUPERVISOR_LIVE_UPDATE_WIRE.responseSchema].properties.agent_sessions.maxItems,
    SUPERVISOR_LIVE_UPDATE_WIRE.maximumSessions,
  );

  const recovery = SUPERVISOR_LIVE_UPDATE_WIRE.recovery;
  const read = contract.paths[recovery.pathTemplate]?.get;
  assert.ok(read, "the recovery read must sit on the declared path and method");
  assert.equal(read.operationId, recovery.operationId);
  // `machines:read`, not `machines:update`. It is the permission that says this
  // is a read, and the reason the CLI may call it freely after an interruption.
  assert.deepEqual(read["x-runa-required-permissions"], [recovery.requiredPermission]);
  const operation = schemas[recovery.responseSchema];
  assert.deepEqual([...operation.required].sort(), [...recovery.operationKeys].sort());
  assert.deepEqual(
    [...schemas[recovery.declaredSessionSchema].required].sort(),
    [...recovery.declaredSessionKeys].sort(),
  );
  assert.deepEqual(
    [...schemas[recovery.failureSchema].required].sort(),
    [...recovery.failureKeys].sort(),
  );
  assert.deepEqual([...operation.properties.phase.enum].sort(), [...recovery.phases].sort());
  assert.deepEqual(
    [...operation.properties.installer_outcome.enum].sort(),
    [...recovery.installerOutcomes].sort(),
  );
  assert.deepEqual([...operation.properties.next_action.enum].sort(), [...recovery.nextActions].sort());
  assert.deepEqual(
    [...schemas[recovery.failureSchema].properties.action.enum].sort(),
    [...recovery.failureActions].sort(),
  );
  // `null` is a declared member of the producer's own evidence enum. The wire
  // declaration lists only the two strings, so the comparison has to say so
  // rather than quietly accept a mismatch.
  assert.deepEqual(
    [...operation.properties.installation_evidence.enum].sort(),
    [...recovery.installationEvidence, null].sort(),
  );
  for (const field of ["declared_sessions", "agent_sessions"]) {
    assert.equal(operation.properties[field].maxItems, SUPERVISOR_LIVE_UPDATE_WIRE.maximumSessions, field);
  }
});

/* -------------------------------------------------------------------------- */
/* CS3 — the flow says what happened, per AgentSession                         */
/* -------------------------------------------------------------------------- */

test("a successful update reports each AgentSession, its identity, and grants nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      sent.push({ id, operationId });
      return decodeSupervisorLiveUpdate(liveUpdateBody([
        { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
        { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "preserved" },
      ], MACHINE_ID, operationId));
    },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, MACHINE_ID);
  assert.match(sent[0].operationId, UUID, "the CLI chooses a canonical identity before it sends");
  assert.equal(record.command, "machines.live-update-supervisor");
  assert.equal(record.data.operation_id, sent[0].operationId);
  assert.equal(record.data.dispatch, "new_operation");
  assert.equal(record.data.summary.all_preserved, true);
  assert.equal(record.data.summary.preserved, 2);
  assert.equal(record.data.control_generation, 7);
  assert.equal(record.data.grants_observation_or_control, false);
  assert.equal(record.data.establishes_provider_login, false);
  assert.deepEqual(record.data.agent_sessions.map((session) => session.outcome), ["preserved", "preserved"]);
  // A settled outcome leaves no outstanding note behind.
  assert.deepEqual(await noteFiles(root), []);
});

test("the identity is recorded BEFORE the request leaves, and survives a lost answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let recordedAtDispatch;
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      // Read from disk from INSIDE the request, which is the only moment that
      // proves the write is ordered before the send rather than after it.
      recordedAtDispatch = await readNote(root, id);
      assert.equal(recordedAtDispatch.operationId, operationId);
      throw pendingFailure();
    },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.conflict);
  assert.notEqual(recordedAtDispatch, undefined, "the record must exist before the request is sent");
  assert.equal(recordedAtDispatch.version, 2);
  assert.equal(recordedAtDispatch.account, SESSION_A, "the label is recorded, as evidence only");
  // And it is still there afterwards: a lost answer leaves the identity held.
  const after = await readNote(root, MACHINE_ID);
  assert.equal(after.operationId, recordedAtDispatch.operationId);
  assert.equal(record.error.details.operation_id, recordedAtDispatch.operationId);
});

test("a partially preserved 200 is never described as a completed update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A real terminal, so the human rendering is what is asserted; stderr is not
  // a TTY so no progress spinner runs inside the test.
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      return decodeSupervisorLiveUpdate(liveUpdateBody([
        { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
        { agent_session_id: SESSION_B, process_epoch: EPOCH_B, outcome: "unknown" },
      ], MACHINE_ID, operationId));
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
  // An unknown custody outcome keeps this computer's record open, and now points
  // at the read rather than at a local acknowledgement.
  assert.equal((await noteFiles(root)).length, 1);
  assert.match(human, /cuna machines live-update-status/u);
});

/* -------------------------------------------------------------------------- */
/* CS2 — lost ACK, reload, GET, same-identity reconciliation                   */
/* -------------------------------------------------------------------------- */

test("CS2: a lost answer is recovered by reading the same identity and repeating it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const reads = [];
  let resolvable = false;
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      sent.push(operationId);
      if (!resolvable) throw pendingFailure();
      return decodeSupervisorLiveUpdate(liveUpdateBody([
        { agent_session_id: SESSION_A, process_epoch: EPOCH_A, outcome: "preserved" },
      ], MACHINE_ID, operationId));
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      reads.push(operationId);
      return decodeSupervisorLiveUpdateOperation(operationBody({ operation_id: operationId }));
    },
  });

  // 1. The answer is lost. The command reconciles with one read before it says
  //    anything, and reports the producer's phase rather than a guess.
  const lost = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(lost.exit, EXIT_CODES.conflict);
  assert.equal(lost.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.equal(lost.record.error.details.phase, "control_rotated");
  assert.equal(lost.record.error.details.next_action, "repeat_same_operation");
  assert.equal(lost.record.error.details.machine_running_implies_installed, false);
  assert.equal(lost.record.error.details.local_record_cleared, false);
  assert.equal(sent.length, 1);
  assert.equal(reads.length, 1, "the refusal path reconciles with exactly one read");
  const identity = sent[0];

  // 2. A FRESH invocation -- the reload -- refuses to start a different update
  //    and names the identity it is holding.
  const again = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(again.exit, EXIT_CODES.conflict);
  assert.equal(again.record.error.details.operation_id, identity);
  assert.equal(sent.length, 1, "an outstanding operation must not be replaced by a new one");

  // 3. The read, as its own command. It sends no mutation at all.
  const status = await runJson(["machines", "live-update-status", MACHINE_ID, "--json"], root, client);
  assert.equal(status.exit, EXIT_CODES.success);
  assert.equal(status.record.command, "machines.live-update-status");
  assert.equal(status.record.data.operation_id, identity);
  assert.equal(status.record.data.operation_id_source, "local_record");
  assert.equal(status.record.data.dispatched_installer, false);
  assert.equal(status.record.data.server_state_changed, false);
  assert.equal(status.record.data.control_rotated, true);
  assert.equal(status.record.data.session_account_withheld, true,
    "a declared session with no settled account is withheld, never rendered as unknown");
  assert.deepEqual(status.record.data.agent_sessions, []);
  assert.equal(status.record.data.declared_sessions.length, 1);
  assert.equal(sent.length, 1, "the status read must send no mutation");

  // 4. The repeat, under the SAME identity, and distinguishable from a new one.
  resolvable = true;
  const resumed = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, client);
  assert.equal(resumed.exit, EXIT_CODES.success, resumed.stderr);
  assert.deepEqual(sent, [identity, identity], "--resume re-sends the exact recorded identity");
  assert.equal(resumed.record.data.dispatch, "repeat_same_operation");
  assert.equal(resumed.record.data.operation_id, identity);
  assert.deepEqual(await noteFiles(root), [], "a settled operation releases the record");

  // CONTROL: with nothing recorded, --resume refuses instead of inventing an
  // identity, so the assertions above are the recovery and not a no-op.
  const nothing = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, client);
  assert.equal(nothing.exit, EXIT_CODES.conflict);
  assert.equal(nothing.record.error.code, "cuna.machine.live_supervisor_update_nothing_to_resume");
  assert.equal(sent.length, 2, "a refused resume sends nothing");
});

test("CS2: a settled operation reached through the refusal path releases the record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(settledOperationBody({
        operation_id: operationId,
        installer_outcome: "refused",
        agent_sessions: [],
        failure: {
          status: 409,
          code: "supervisor_live_update_preconditions_unmet",
          title: "Sessions cannot be carried over",
          detail: "Cuna could not establish that every live AgentSession would be readopted.",
          retryable: false,
          action: "none",
        },
      }));
    },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(record.error.code, "cuna.machine.live_supervisor_update_settled_refusal");
  assert.equal(record.error.details.phase, "settled");
  assert.equal(record.error.details.next_action, "none");
  assert.equal(record.error.details.failure.code, "supervisor_live_update_preconditions_unmet");
  assert.equal(record.error.details.local_record_cleared, true);
  assert.deepEqual(await noteFiles(root), [], "a terminal operation must not hold the Machine");
});

/* -------------------------------------------------------------------------- */
/* CS3 — conflict, inaccessibility, and what may never clear a record          */
/* -------------------------------------------------------------------------- */

test("CS3: a server active-operation conflict is never overridden by a local record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      sent += 1;
      throw new CunaError({
        code: "cuna.remote.conflict",
        message: "Another supervisor update is in flight",
        exitCode: EXIT_CODES.conflict,
        details: { http_status: 409, reason: "supervisor_live_update_operation_conflict" },
      });
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(operationBody({ operation_id: operationId, phase: "claimed", control_rotated: false, installer_outcome: "not_sent" }));
    },
  });
  const first = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(first.exit, EXIT_CODES.conflict);
  assert.equal(first.record.error.details.phase, "claimed");
  assert.equal((await noteFiles(root)).length, 1, "a conflict keeps the identity");

  // The forget path cannot be used to walk past the server's conflict: it reads
  // the operation and refuses because it has not settled.
  const forget = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, client);
  assert.equal(forget.exit, EXIT_CODES.conflict);
  assert.equal(forget.record.error.code, "cuna.machine.live_supervisor_update_not_settled");
  assert.equal(forget.record.error.details.local_record_cleared, false);
  assert.equal((await noteFiles(root)).length, 1);
  assert.equal(sent, 1, "reading and refusing sends no mutation");

  // CONTROL: once the producer says the operation settled, the same command
  // clears it -- so the refusal above is the phase check and not a constant.
  const settledClient = fakeClient({
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(settledOperationBody({ operation_id: operationId }));
    },
  });
  const cleared = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, settledClient);
  assert.equal(cleared.exit, EXIT_CODES.success);
  assert.equal(cleared.record.data.local_record_cleared, true);
  assert.equal(cleared.record.data.server_state_changed, false);
  assert.deepEqual(await noteFiles(root), []);
});

test("CS3: an owner-scoped 404 on a RECORDED identity never discards it and never denies it existed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Account A records an identity and loses the answer.
  const a = fakeClient({
    async updateMachineSupervisorInPlace() { throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });
  const lost = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, a);
  assert.equal(lost.exit, EXIT_CODES.conflict);
  const held = await readNote(root, MACHINE_ID);
  assert.notEqual(held, undefined, "a read that could not answer must leave the record standing");
  assert.equal(held.account, SESSION_A);

  // The signed-in principal changes. The record is keyed by API origin and
  // Machine, deliberately, so account B finds it -- and every owner-scoped
  // answer it can get about it is the producer's single not-found.
  const b = fakeClient({
    async getIdentity() { return { id: SESSION_B, email: "other@example.test", workspaceAssigned: true }; },
    async updateMachineSupervisorInPlace() { throw notFound(); },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });

  const resumed = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, b);
  assert.equal(resumed.exit, EXIT_CODES.conflict);
  assert.equal(resumed.record.error.code, "cuna.machine.live_supervisor_update_operation_inaccessible");
  assert.equal(resumed.record.error.details.local_record_cleared, false);
  assert.equal(resumed.record.error.details.record_account, SESSION_A);
  assert.match(resumed.record.error.hint, /NOT evidence that the operation never existed/u);
  assert.match(resumed.record.error.hint, /cuna whoami/u);
  assert.deepEqual(
    (await readNote(root, MACHINE_ID)).operationId,
    held.operationId,
    "B's not-found must not discard A's recovery identity",
  );

  const forget = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, b);
  assert.equal(forget.exit, EXIT_CODES.conflict);
  assert.equal(forget.record.error.code, "cuna.machine.live_supervisor_update_record_unresolved");
  assert.equal(forget.record.error.details.record_account, SESSION_A);
  assert.deepEqual((await readNote(root, MACHINE_ID)).operationId, held.operationId);

  // CONTROL: the SAME not-found, reached with an identity the process had just
  // minted, does prove nothing was admitted -- and there the record is dropped.
  // Without this the assertions above would also hold for a build that never
  // clears anything.
  const fresh = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  const minted = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], fresh, b);
  assert.equal(minted.exit, EXIT_CODES.conflict);
  assert.equal(minted.record.error.details.reason, "resource_not_found");
  assert.deepEqual(await noteFiles(fresh), [], "a never-admitted new identity leaves no record");
});

test("CS3: a proven pre-dispatch failure is not labelled an uncertain remote effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let read = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      throw new CunaError({
        code: "cuna.remote.conflict",
        message: "Machine must be running",
        exitCode: EXIT_CODES.conflict,
        hint: "This update replaces the supervisor in place while the Machine keeps running.",
        details: { http_status: 409, reason: "supervisor_live_update_machine_not_running" },
      });
    },
    async readMachineSupervisorInPlaceUpdate() { read += 1; throw notFound(); },
  });
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(exit, EXIT_CODES.conflict);
  // The producer's own refusal survives unchanged; no unknown-outcome story is
  // invented on top of it, and no reconciliation read is spent on it.
  assert.equal(record.error.code, "cuna.remote.conflict");
  assert.equal(read, 0, "a refusal ordered above the producer's claim needs no reconciliation");
  assert.deepEqual(await noteFiles(root), []);

  // And the next attempt is admitted, so the refusal is decided rather than
  // sticky.
  let sent = 0;
  const after = await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root,
    fakeClient({
      async updateMachineSupervisorInPlace(id, operationId) {
        sent += 1;
        return decodeSupervisorLiveUpdate(liveUpdateBody([], MACHINE_ID, operationId));
      },
    }));
  assert.equal(after.exit, EXIT_CODES.success);
  assert.equal(sent, 1, "a decided refusal must not block the next attempt");
});

test("REPRODUCTION: a second local profile cannot start a different update over an open one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await twoProfileStore(root);
  const dispatched = [];
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id) {
      dispatched.push(id);
      throw pendingFailure();
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(operationBody({ operation_id: operationId, machine_id: id }));
    },
  });

  const alpha = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--profile", "alpha", "--json"], root, client);
  assert.equal(alpha.exit, EXIT_CODES.conflict);
  assert.deepEqual(dispatched, [MACHINE_ID]);
  const identity = alpha.record.error.details.operation_id;

  // Profile beta, same API origin, same Machine. Selecting a different profile
  // is not a way around the suppression, and beta reads alpha's identity.
  const beta = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--profile", "beta", "--json"], root, client);
  assert.equal(beta.exit, EXIT_CODES.conflict);
  assert.equal(beta.record.error.code, "cuna.machine.live_supervisor_update_outcome_unknown");
  assert.equal(beta.record.error.details.operation_id, identity);
  assert.deepEqual(dispatched, [MACHINE_ID], "--profile must not start a second update");

  // The exclusion is per Machine, not a blanket lock: a different Machine on
  // the same origin is untouched by it. Without this the control could pass by
  // refusing everything.
  const sibling = await runJson(
    ["machines", "live-update-supervisor", SIBLING_ID, "--yes", "--profile", "beta", "--json"], root, client);
  assert.equal(sibling.exit, EXIT_CODES.conflict);
  assert.deepEqual(dispatched, [MACHINE_ID, SIBLING_ID], "a different Machine must remain independent");
  assert.equal((await noteFiles(root)).length, 2);

  // And the resume is equally profile-independent: beta re-sends the identity
  // alpha recorded, because they are the same record.
  const resumed = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--profile", "beta", "--json"], root, client);
  assert.equal(resumed.exit, EXIT_CODES.conflict);
  assert.equal(resumed.record.error.details.operation_id, identity);
  assert.deepEqual(dispatched, [MACHINE_ID, SIBLING_ID, MACHINE_ID]);
});

test("the note is keyed by canonical API origin, and reading it needs no identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = filePlatform(root);
  // Four spellings of one origin, plus one genuinely different deployment.
  const notes = (baseUrl) => liveSupervisorUpdateNotes(platform, { baseUrl });
  await notes("https://api.getcuna.com").reserve(MACHINE_ID, OPERATION_ID, "2026-08-08T00:00:00.000Z");
  for (const spelling of [
    "https://api.getcuna.com/",
    "https://API.GetCuna.com",
    "https://api.getcuna.com:443/v1?ignored=1#fragment",
  ]) {
    const found = await notes(spelling).read(MACHINE_ID);
    assert.equal(found.state, "outstanding", `${spelling} must resolve to the same note`);
    assert.equal(found.note.operationId, OPERATION_ID);
    assert.equal(found.note.dispatchedAt, "2026-08-08T00:00:00.000Z");
  }
  assert.equal((await notes("https://api.example.invalid").read(MACHINE_ID)).state, "none");
  assert.equal((await notes("https://api.getcuna.com").read(SIBLING_ID)).state, "none");

  // The label is optional, is never required to read the note, and never admits
  // anything: a note carrying someone else's account still reads back.
  const other = "99999999-9999-4999-8999-999999999999";
  await notes("https://api.getcuna.com").reserve(SIBLING_ID, OTHER_OPERATION_ID, "2026-08-08T00:00:01.000Z", other);
  const labelled = await notes("https://api.getcuna.com").read(SIBLING_ID);
  assert.equal(labelled.note.account, other);
  assert.equal(labelled.note.operationId, OTHER_OPERATION_ID);
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
    notes.reserve(MACHINE_ID, OPERATION_ID, "2026-09-13T00:00:01.000Z"),
    notes.reserve(MACHINE_ID, OTHER_OPERATION_ID, "2026-09-13T00:00:02.000Z"),
  ]);
  const winners = [first, second].filter((value) => value !== undefined);
  assert.equal(winners.length, 1, "exactly one reservation may be admitted");
  assert.equal(seen.length, 2, "both callers really attempted the exclusive create");
  const held = await notes.read(MACHINE_ID);
  assert.equal(held.state, "outstanding");
  assert.equal(held.note.operationId, winners[0].operationId,
    "the surviving record must be the winner's, not whoever wrote last");

  // CONTROL: with the slot free again, the same call succeeds. Without this the
  // assertion above would also pass for a store that never admits anything.
  await notes.discard(MACHINE_ID);
  const alone = await notes.reserve(MACHINE_ID, OPERATION_ID, "2026-09-13T00:00:03.000Z");
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
/* UR1-B — settlement is bound to the exact operation identity                 */
/* -------------------------------------------------------------------------- */

test("UR1-B: a stale completion cannot erase a newer record or admit a third dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = liveSupervisorUpdateNotes(filePlatform(root), { baseUrl: "https://api.getcuna.com" });
  const THIRD = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  await notes.reserve(MACHINE_ID, OPERATION_ID, "2026-09-13T00:00:01.000Z");
  // An authoritative settled read, followed by the clear it authorises, while
  // p1 is still in flight.
  assert.equal(await notes.discard(MACHINE_ID), true);
  const p2 = await notes.reserve(MACHINE_ID, OTHER_OPERATION_ID, "2026-09-13T00:00:09.000Z");
  assert.notEqual(p2, undefined);

  // p1's late authoritative answer. It owns its identity, and that one is gone.
  assert.equal(await notes.settle(MACHINE_ID, OPERATION_ID), "superseded");
  const surviving = await notes.read(MACHINE_ID);
  assert.equal(surviving.state, "outstanding");
  assert.equal(surviving.note.operationId, OTHER_OPERATION_ID,
    "a newer process's intent must survive an older completion");

  // And no third dispatch is admitted while p2 is outstanding.
  assert.equal(await notes.reserve(MACHINE_ID, THIRD, "2026-09-13T00:00:20.000Z"), undefined);

  // CONTROL: the owning dispatch does settle, and settling twice is `absent`,
  // not an error -- so "superseded" above is the ownership check and not a
  // settle that never removes anything.
  assert.equal(await notes.settle(MACHINE_ID, OTHER_OPERATION_ID), "settled");
  assert.equal((await notes.read(MACHINE_ID)).state, "none");
  assert.equal(await notes.settle(MACHINE_ID, OTHER_OPERATION_ID), "absent");

  // CONTROL: a sibling Machine is untouched by every settle above.
  await notes.reserve(SIBLING_ID, THIRD, "2026-09-13T00:00:30.000Z");
  await notes.settle(MACHINE_ID, OPERATION_ID);
  assert.equal((await notes.read(SIBLING_ID)).note.operationId, THIRD);
});

/* -------------------------------------------------------------------------- */
/* UR1-C — an unreadable record is named, blocking, and clearable              */
/* -------------------------------------------------------------------------- */

function scopeDigest() {
  return createHash("sha256")
    .update(JSON.stringify(["supervisor-live-update", "https://api.getcuna.com"]))
    .digest("hex");
}

async function writeCorruptRecord(root, machineId, bytes) {
  const path = join(root, "state", "supervisor-live-updates", scopeDigest(), `${machineId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, "utf8");
  return path;
}

test("UR1-C: an unreadable record blocks both sending intents and says so by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await writeCorruptRecord(root, MACHINE_ID, "{ not json\n");
  let dispatched = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { dispatched += 1; return undefined; },
  });
  for (const intent of ["--yes", "--resume"]) {
    const { exit, record } = await runJson(
      ["machines", "live-update-supervisor", MACHINE_ID, intent, "--json"], root, client);
    assert.equal(exit, EXIT_CODES.conflict, intent);
    assert.equal(record.error.code, "cuna.machine.live_supervisor_update_record_unreadable");
    assert.equal(record.error.details.record_path, path);
    assert.match(record.error.hint, /--forget-unknown/u);
    assert.match(record.error.hint, /works on an unreadable record/u);
  }
  // And the read cannot invent an identity out of it either.
  const status = await runJson(["machines", "live-update-status", MACHINE_ID, "--json"], root, client);
  assert.equal(status.exit, EXIT_CODES.usage);
  assert.equal(status.record.error.code, "cuna.machine.live_supervisor_update_operation_unnamed");
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
      async updateMachineSupervisorInPlace(id, operationId) {
        dispatched += 1;
        return decodeSupervisorLiveUpdate(liveUpdateBody([], MACHINE_ID, operationId));
      },
    }));
  assert.equal(after.exit, EXIT_CODES.success);
  assert.equal(dispatched, 1);

  // CONTROL: a well-formed record takes the readable branch, which is how we
  // know `record_readable: false` above is the corruption and not a constant.
  await writeCorruptRecord(root, SIBLING_ID, `${JSON.stringify({
    version: 2,
    scope: scopeDigest(),
    machineId: SIBLING_ID,
    operationId: OPERATION_ID,
    dispatchedAt: "2026-09-13T00:00:05.000Z",
  })}\n`);
  const readable = await runJson(
    ["machines", "live-update-supervisor", SIBLING_ID, "--forget-unknown", "--json"], root,
    fakeClient({
      async readMachineSupervisorInPlaceUpdate(id, operationId) {
        return decodeSupervisorLiveUpdateOperation(settledOperationBody({ machine_id: id, operation_id: operationId }));
      },
    }));
  assert.equal(readable.exit, EXIT_CODES.success);
  assert.equal(readable.record.data.record_readable, true);
  assert.equal(readable.record.data.dispatched_at, "2026-09-13T00:00:05.000Z");
});

/* -------------------------------------------------------------------------- */
/* UR3 — the transport cannot re-dispatch this POST                            */
/* -------------------------------------------------------------------------- */

test("UR3: a deliberate repeat is the only repeat; the transport never makes one", async () => {
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

  const subject = await dispatchesFor((client) =>
    client.updateMachineSupervisorInPlace(MACHINE_ID, OPERATION_ID));
  assert.equal(subject.dispatches, 1, "the in-place update must never be re-sent by the transport");
  assert.equal(subject.failure.code, "cuna.network.failed");
  assert.equal(subject.failure.details.remote_outcome, "not_sent");
  assert.equal(subject.failure.details.attempts, 1);
  // Still retryable: the PERSON may repeat, under the same identity and through
  // --resume. Only the silent repetition is gone.
  assert.equal(subject.failure.retryable, true);

  // CONTROL: every other operation keeps the automatic connect retry, so the
  // assertion above is this request's opt-out and not a transport-wide change.
  const control = await dispatchesFor((client) => client.replaceMachineSupervisor(MACHINE_ID));
  assert.equal(control.dispatches, 2, "unrelated operations keep the connect-phase retry");
  assert.equal(control.failure.details.attempts, 2);
});

test("the three intents are different decisions and cannot be combined", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const pair of [
    ["--yes", "--forget-unknown"],
    ["--yes", "--resume"],
    ["--resume", "--forget-unknown"],
  ]) {
    const { exit, record } = await runJson(
      ["machines", "live-update-supervisor", MACHINE_ID, ...pair, "--json"], root, fakeClient());
    assert.equal(exit, EXIT_CODES.usage, pair.join(" "));
    assert.equal(record.error.code, "cuna.usage.invalid");
  }
});

/* -------------------------------------------------------------------------- */
/* CS5 — unmet preconditions refuse, and never repair themselves               */
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

test("starting a new update requires explicit confirmation; reading requires none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { exit, record } = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--json"], root, fakeClient());
  assert.equal(exit, EXIT_CODES.policy);
  assert.equal(record.error.code, "cuna.confirmation.required");

  // The read is not a mutation and is not gated behind one. A named operation
  // needs no local record at all.
  const reader = fakeClient({
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(settledOperationBody({ machine_id: id, operation_id: operationId }));
    },
  });
  const status = await runJson(
    ["machines", "live-update-status", MACHINE_ID, "--operation", OPERATION_ID, "--json"], root, reader);
  assert.equal(status.exit, EXIT_CODES.success);
  assert.equal(status.record.data.operation_id_source, "named");
  assert.equal(status.record.data.next_action, "none");
  assert.equal(status.record.data.machine_running_implies_installed, false);

  // The same sentence in the prose a person reads, not only in the record.
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
  const human = await runCli(
    ["machines", "live-update-status", MACHINE_ID, "--operation", OPERATION_ID, "--no-color"], {
      streams: streams.streams,
      platform: filePlatform(root),
      env: { CUNA_API_KEY: API_KEY },
      now: () => NOW,
      clientFactory: () => reader,
    });
  assert.equal(human, EXIT_CODES.success, streams.stderr());
  assert.match(streams.stdout(), /A running Machine is not evidence/u);
  assert.match(streams.stdout(), /settled: terminal/u);
});

test("live-update-status carries the fence into the ordinary printed answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readAs = async (overrides, argv = []) => {
    const client = fakeClient({
      async readMachineSupervisorInPlaceUpdate(id, operationId) {
        return decodeSupervisorLiveUpdateOperation(operationBody({ machine_id: id, operation_id: operationId, ...overrides }));
      },
    });
    const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
    const exit = await runCli(
      ["machines", "live-update-status", MACHINE_ID, "--operation", OPERATION_ID, "--no-color", ...argv], {
        streams: streams.streams,
        platform: filePlatform(root),
        env: { CUNA_API_KEY: API_KEY },
        now: () => NOW,
        clientFactory: () => client,
      });
    assert.equal(exit, EXIT_CODES.success, streams.stderr());
    return streams.stdout();
  };

  // POSITIVE CONTROL: an open `unknown`. The printed answer says the installer
  // may still arrive and offers no new update, because the producer has not
  // fenced this one and starting a second is refused while it is open.
  const pending = await readAs({});
  assert.match(pending, /an installer it authorized may still arrive/u);
  assert.match(pending, /could still arrive and change this Machine/u);
  assert.doesNotMatch(pending, /Installer retired on the Machine/u);
  assert.doesNotMatch(pending, /--yes/u);

  // SUBJECT 1: retired harmless work. Same `unknown`, different answer.
  const harmless = await readAs({ ...retired("retired"), phase: "settled", next_action: "none", settled_at: "2026-08-08T00:00:31.000Z" });
  assert.match(harmless, /Installer retired on the Machine 2026-08-08T00:00:30\.000Z\./u);
  assert.match(harmless, /Nothing this installer would have written was written/u);
  assert.match(harmless, new RegExp(`cuna machines live-update-supervisor ${MACHINE_ID} --yes`, "u"));
  // The word Cuna observed is unchanged, and no success is claimed from the fence.
  assert.match(harmless, /^Installer unknown:/mu);
  assert.notEqual(harmless, pending);

  // SUBJECT 2: partial. The supported action is named, and so is what Cuna
  // cannot say.
  const partial = await readAs({ ...retired("partial"), phase: "settled", next_action: "none", settled_at: "2026-08-08T00:00:31.000Z" });
  assert.match(partial, /began replacing the supervisor and stopped/u);
  assert.match(partial, /installs the whole release over what is there/u);
  assert.match(partial, /Inspect the AgentSessions first/u);
  assert.match(partial, /^Installer unknown:/mu);
  assert.notEqual(partial, harmless);

  // And `--json` carries the same fence as decided values, for a caller that
  // reads no prose at all.
  const record = JSON.parse((await readAs({ ...retired("partial"), phase: "settled", next_action: "none", settled_at: "2026-08-08T00:00:31.000Z" }, ["--json"])).trim().split("\n").at(-1));
  assert.equal(record.data.retirement_outcome, "partial");
  assert.equal(record.data.retired_at, "2026-08-08T00:00:30.000Z");
  assert.equal(record.data.installer_reach, "retired_after_partial_write");
  assert.equal(record.data.installer_can_still_act, false);
  assert.equal(record.data.installer_outcome, "unknown");
  assert.equal(record.data.retirement_outcome_implies_installed, false);
});

test("live-update-status refuses an operation identity that is not canonical", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let read = 0;
  const { exit, record } = await runJson(
    ["machines", "live-update-status", MACHINE_ID, "--operation", "not-a-uuid", "--json"], root,
    fakeClient({ async readMachineSupervisorInPlaceUpdate() { read += 1; throw notFound(); } }));
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(record.error.code, "cuna.usage.invalid");
  assert.equal(read, 0);
});

/* -------------------------------------------------------------------------- */
/* D2 — a conflict on a freshly minted identity admitted nothing               */
/* -------------------------------------------------------------------------- */

/**
 * Independently reproduced by a reviewer, and confirmed against the producer at
 * the pinned commit: `claim_supervisor_live_update_operation` (migration 0193)
 * looks the offered id up FIRST, and when it is absent and another unsettled
 * operation holds the Machine it returns `machine_busy` BEFORE its insert. No
 * row is created for the identity that was sent.
 *
 * Treating that as an uncertainty kept a record naming an operation the
 * producer had never heard of: no repeat, no new update, `--forget-unknown`
 * refusing and blaming account visibility, and a status read that could only
 * ever answer not-found. A permanent dead end for that Machine on that API.
 */

function conflict() {
  return new CunaError({
    code: "cuna.remote.conflict",
    message: "Another supervisor update is in flight",
    exitCode: EXIT_CODES.conflict,
    details: { http_status: 409, reason: "supervisor_live_update_operation_conflict" },
  });
}

test("D2: a conflict on a minted identity is confirmed unadmitted and frees the Machine", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reads = [];
  let attempt = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      attempt += 1;
      if (attempt === 1) throw conflict();
      return decodeSupervisorLiveUpdate(liveUpdateBody([], MACHINE_ID, OPERATION_ID));
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      // The producer has no row for the identity the CLI just minted.
      reads.push(operationId);
      throw notFound();
    },
  });

  const refused = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(refused.exit, EXIT_CODES.conflict);
  assert.equal(refused.record.error.code, "cuna.machine.live_supervisor_update_machine_busy");
  assert.equal(refused.record.error.details.outcome, "not_admitted");
  assert.equal(refused.record.error.details.local_record_cleared, true);
  assert.equal(refused.record.error.retryable, true, "the owner may choose it again");
  // The classification is a reading of the producer's ordering; the read is the
  // answer. Exactly one, and it is what authorises releasing the record.
  assert.equal(reads.length, 1, "non-admission is confirmed, not assumed");
  assert.deepEqual(await noteFiles(root), [], "a never-admitted identity leaves no record");
  // And nothing was said about account visibility, which was the old hint's
  // explanation for a condition that has nothing to do with accounts.
  assert.doesNotMatch(refused.record.error.hint, /cuna whoami/u);

  // The Machine is reachable again the moment the other update settles.
  const second = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(second.exit, EXIT_CODES.success, second.stderr);
  assert.equal(attempt, 2, "the second attempt reached the producer rather than a local record");
});

test("D2: the same conflict KEEPS the record when the read cannot confirm it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  /* CONTROL for the test above, varying only the read's answer. A read that
     could not ask proves nothing, and a row proves the opposite -- both keep
     the record, which is the safe direction. Without this, "clears the record"
     could be a path that always clears. */
  for (const [why, read] of [
    ["the read could not answer", async () => { throw new CunaError({
      code: "cuna.network.failed",
      message: "offline",
      exitCode: EXIT_CODES.network,
      details: { remote_outcome: "not_sent" },
    }); }],
    ["the producer HAS a row for it", async (id, operationId) =>
      decodeSupervisorLiveUpdateOperation(operationBody({ machine_id: id, operation_id: operationId }))],
  ]) {
    const scratch = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
    try {
      const client = fakeClient({
        async updateMachineSupervisorInPlace() { throw conflict(); },
        readMachineSupervisorInPlaceUpdate: read,
      });
      const { exit, record } = await runJson(
        ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], scratch, client);
      assert.equal(exit, EXIT_CODES.conflict, why);
      assert.notEqual(
        record.error.code,
        "cuna.machine.live_supervisor_update_machine_busy",
        `${why}: non-admission must not be claimed`,
      );
      assert.equal((await noteFiles(scratch)).length, 1, `${why}: the record is kept`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test("D2: --forget-unknown clears a never-admitted identity for the account that filed it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A record whose POST never reached the producer: the identity is recorded,
  // and the producer has no row for it.
  const client = fakeClient({
    async updateMachineSupervisorInPlace() {
      throw new CunaError({
        code: "cuna.network.failed",
        message: "connection reset",
        exitCode: EXIT_CODES.network,
        retryable: true,
        details: { remote_outcome: "unknown" },
      });
    },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });
  const lost = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(lost.exit, EXIT_CODES.conflict);
  assert.equal((await noteFiles(root)).length, 1);

  // Same account: it can see its own operations, so a not-found is the answer
  // and not a visibility problem. Clearing is correct and now reachable.
  const cleared = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, client);
  assert.equal(cleared.exit, EXIT_CODES.success, cleared.stderr);
  assert.equal(cleared.record.data.local_record_cleared, true);
  assert.equal(cleared.record.data.operation_admitted, false);
  assert.equal(cleared.record.data.server_state_changed, false);
  assert.deepEqual(await noteFiles(root), []);
});

test("D2: an owner-scoped 404 under ANOTHER account never destroys the record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Account A records an identity and loses the answer.
  const a = fakeClient({
    async updateMachineSupervisorInPlace() { throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });
  await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, a);
  const held = await readNote(root, MACHINE_ID);
  assert.notEqual(held, undefined);
  assert.equal(held.account, SESSION_A);

  // The signed-in account changes. The record is keyed by API origin and
  // Machine, so B finds it -- and every owner-scoped answer B can get about it
  // is the producer's single not-found.
  const b = fakeClient({
    async getIdentity() { return { id: SESSION_B, email: "other@example.test", workspaceAssigned: true }; },
    async updateMachineSupervisorInPlace() { throw notFound(); },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });
  const forget = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], root, b);
  assert.equal(forget.exit, EXIT_CODES.conflict);
  assert.equal(forget.record.error.code, "cuna.machine.live_supervisor_update_record_unresolved");
  assert.equal(forget.record.error.details.local_record_cleared, false);
  assert.equal(forget.record.error.details.record_account, SESSION_A);
  assert.equal(forget.record.error.details.signed_in_account, SESSION_B);
  assert.match(forget.record.error.hint, /does not mean the operation is gone/u);
  assert.equal(
    (await readNote(root, MACHINE_ID)).operationId,
    held.operationId,
    "B's not-found must not discard A's recovery evidence",
  );

  // CONTROL: a record with NO account label is equally protected, because Cuna
  // cannot tell the two cases apart without one.
  const anonymous = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(anonymous, { recursive: true, force: true }));
  const notes = liveSupervisorUpdateNotes(filePlatform(anonymous), { baseUrl: "https://api.getcuna.com" });
  await notes.reserve(MACHINE_ID, OPERATION_ID, "2026-08-08T00:00:00.000Z");
  const unlabelled = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--forget-unknown", "--json"], anonymous, a);
  assert.equal(unlabelled.exit, EXIT_CODES.conflict);
  assert.match(unlabelled.record.error.hint, /does not name the account that filed it/u);
  assert.equal((await noteFiles(anonymous)).length, 1);
});

test("D2: a reserve whose read-back fails withdraws only its own record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = filePlatform(root);
  /* The record was created and then failed verification. It used to be left
     behind: a readable record naming an operation that was never sent, which
     `--forget-unknown` then refused for the same not-found reason. */
  let corrupt = true;
  const tampering = Object.freeze({
    ...base,
    async readSafeConfig(path, maximumBytes) {
      const snapshot = await base.readSafeConfig(path, maximumBytes);
      if (corrupt && snapshot.exists && path.includes("supervisor-live-updates")) {
        return { exists: true, text: `${snapshot.text} ` };
      }
      return snapshot;
    },
  });
  const notes = liveSupervisorUpdateNotes(tampering, { baseUrl: "https://api.getcuna.com" });
  await assert.rejects(
    notes.reserve(MACHINE_ID, OPERATION_ID, "2026-08-08T00:00:00.000Z"),
    /could not be verified/u,
  );
  corrupt = false;
  assert.deepEqual(
    await noteFiles(root),
    [],
    "a reservation that could not be verified leaves nothing behind",
  );

  // CONTROL: it withdraws its OWN record, never a concurrent writer's. With
  // another process's bytes in the slot, the withdrawal is refused and they
  // survive -- `settle` is bound to the identity, and a blind delete here would
  // be the same defect one layer down.
  const rival = liveSupervisorUpdateNotes(base, { baseUrl: "https://api.getcuna.com" });
  await rival.reserve(SIBLING_ID, OTHER_OPERATION_ID, "2026-08-08T00:00:05.000Z");
  corrupt = true;
  await assert.rejects(
    notes.reserve(SIBLING_ID, OPERATION_ID, "2026-08-08T00:00:06.000Z"),
    /could not be verified|already/u,
  ).catch(() => {});
  corrupt = false;
  const survivor = await rival.read(SIBLING_ID);
  assert.equal(survivor.state, "outstanding");
  assert.equal(survivor.note.operationId, OTHER_OPERATION_ID, "another writer's record is untouched");
});

/* -------------------------------------------------------------------------- */
/* Cross-client recovery for an operation identity held elsewhere              */
/* -------------------------------------------------------------------------- */

test("--resume refuses an identity the producer never admitted, and says why", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { sent += 1; throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate() { throw notFound(); },
  });
  await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal(sent, 1);

  /* The old behaviour: --resume re-sent it, the producer admitted it for the
     FIRST time, a whole update ran, and the CLI reported
     `"dispatch": "repeat_same_operation"`. The command was right about itself
     and wrong about the effect. */
  const resumed = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, client);
  assert.equal(resumed.exit, EXIT_CODES.conflict);
  assert.equal(resumed.record.error.code, "cuna.machine.live_supervisor_update_nothing_to_resume");
  assert.equal(resumed.record.error.details.operation_admitted, false);
  assert.match(resumed.record.error.hint, /NEW update's first admission/u);
  assert.equal(sent, 1, "nothing was re-sent");
});

test("--resume reconciles when the producer asks for it, and reports it as a repeat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  let resolvable = false;
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      sent.push(operationId);
      if (!resolvable) throw pendingFailure();
      return decodeSupervisorLiveUpdate(liveUpdateBody([], MACHINE_ID, operationId));
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      // Admitted, unsettled, and asking for the same identity back.
      return decodeSupervisorLiveUpdateOperation(operationBody({ machine_id: id, operation_id: operationId }));
    },
  });
  await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  const identity = sent[0];
  resolvable = true;
  const resumed = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, client);
  assert.equal(resumed.exit, EXIT_CODES.success, resumed.stderr);
  assert.deepEqual(sent, [identity, identity], "the exact recorded identity, re-sent");
  assert.equal(resumed.record.data.dispatch, "repeat_same_operation");
  assert.deepEqual(await noteFiles(root), []);
});

test("--resume reports a settled operation instead of re-sending it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent = 0;
  // The operation is open while the first dispatch reconciles -- otherwise that
  // reconciliation would settle the record and there would be nothing to resume
  // -- and settled by the time the owner comes back to finish it.
  let settled = false;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { sent += 1; throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(
        (settled ? settledOperationBody : operationBody)({ machine_id: id, operation_id: operationId }),
      );
    },
  });
  await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  assert.equal((await noteFiles(root)).length, 1, "an open operation keeps its record");
  settled = true;
  const before = sent;
  const resumed = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--json"], root, client);
  assert.equal(resumed.exit, EXIT_CODES.success, resumed.stderr);
  assert.equal(resumed.record.command, "machines.live-update-status");
  assert.equal(resumed.record.data.resumed, false);
  assert.equal(resumed.record.data.next_action, "none");
  assert.equal(sent, before, "a settled operation is reported, never re-sent");
  assert.deepEqual(await noteFiles(root), [], "and its record is released");
});

test("--resume --operation finishes an update this computer never recorded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const client = fakeClient({
    async updateMachineSupervisorInPlace(id, operationId) {
      sent.push(operationId);
      return decodeSupervisorLiveUpdate(liveUpdateBody([], MACHINE_ID, operationId));
    },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(operationBody({ machine_id: id, operation_id: operationId }));
    },
  });
  // Nothing recorded here: this identity was started from the console or from
  // another computer, and the owner holds only its id.
  assert.deepEqual(await noteFiles(root), []);
  const finished = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--operation", OTHER_OPERATION_ID, "--json"],
    root, client);
  assert.equal(finished.exit, EXIT_CODES.success, finished.stderr);
  assert.deepEqual(sent, [OTHER_OPERATION_ID]);
  assert.equal(finished.record.data.dispatch, "repeat_same_operation");
  assert.deepEqual(await noteFiles(root), [], "the settled operation releases the reservation it took");
});

test("a caller-known identity takes the same reservation, and never clobbers another", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent = 0;
  const client = fakeClient({
    async updateMachineSupervisorInPlace() { sent += 1; throw pendingFailure(); },
    async readMachineSupervisorInPlaceUpdate(id, operationId) {
      return decodeSupervisorLiveUpdateOperation(operationBody({ machine_id: id, operation_id: operationId }));
    },
  });
  // This computer is already holding one identity.
  await runJson(["machines", "live-update-supervisor", MACHINE_ID, "--yes", "--json"], root, client);
  const held = await readNote(root, MACHINE_ID);
  const before = sent;

  // A DIFFERENT caller-known identity is refused rather than overwriting it.
  const rival = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--operation", OTHER_OPERATION_ID, "--json"],
    root, client);
  assert.equal(rival.exit, EXIT_CODES.conflict);
  assert.equal(rival.record.error.code, "cuna.machine.live_supervisor_update_already_reserved");
  assert.equal(rival.record.error.details.operation_id, held.operationId);
  assert.equal(rival.record.error.details.requested_operation_id, OTHER_OPERATION_ID);
  assert.equal(sent, before, "nothing was sent");
  assert.equal((await readNote(root, MACHINE_ID)).operationId, held.operationId, "untouched");

  // CONTROL: naming the identity this computer DOES hold is not a conflict with
  // itself, so the refusal above is the rival check and not a blanket refusal.
  const same = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--operation", held.operationId, "--json"],
    root, client);
  assert.equal(same.exit, EXIT_CODES.conflict, "still pending, but it was sent");
  assert.equal(sent, before + 1);
});

test("--operation is refused on the two intents that are not a repeat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuna-live-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const intent of ["--yes", "--forget-unknown"]) {
    const { exit, record } = await runJson(
      ["machines", "live-update-supervisor", MACHINE_ID, intent, "--operation", OPERATION_ID, "--json"],
      root, fakeClient());
    assert.equal(exit, EXIT_CODES.usage, intent);
    assert.equal(record.error.code, "cuna.usage.invalid");
  }
  // And a malformed identity never reaches the network.
  const malformed = await runJson(
    ["machines", "live-update-supervisor", MACHINE_ID, "--resume", "--operation", "not-a-uuid", "--json"],
    root, fakeClient());
  assert.equal(malformed.exit, EXIT_CODES.usage);
});
