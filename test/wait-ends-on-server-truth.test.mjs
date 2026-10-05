import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES } from "../dist/index.js";
import { composeInlineProgressLine } from "../dist/cli/progress-line.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { launchRemoteWorkspaceSession } from "../dist/journey/remote-workspace.js";
import { AGENT_SESSION_READY_DEADLINE_MS, journeyWaitLine, readinessBackoffMs } from "../dist/journey/wait-policy.js";

/*
 * W1 and W2 of the 2026-09-29 wait-truth goal, measured LIVE on CLI 8df1553
 * against Edge v240 (infra 2e4e1a2), Machine cd0696a7, AgentSession a84513bb:
 *
 *   W1  the server settled readiness `reconciliation_required /
 *       deadline_unattested` at +141 s, and the CLI kept waiting until its own
 *       180 s deadline, then exited 5 `agent_session_ready_timeout`.
 *   W2  for all 180 s the only line was `Still waiting for the session process
 *       to start · Ns of 180s`, while the row said why.
 *
 * The boundary modelled here is what the journey does with the decoded answer
 * of `GET /v1/agent-sessions/{id}`: every test drives the real journey effects
 * with a fake client. It does not model the server's sweep; the readiness
 * values are the ones producer 2e4e1a2 publishes. The read itself, and its
 * decoding, are `test/agent-session-readiness-wire.test.mjs`.
 */

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const START = Date.parse("2026-09-29T22:13:00.000Z");
const DEADLINE_AT = "2026-09-29T22:15:00.000Z";
const SETTLED_AT = "2026-09-29T22:15:20.000Z";

function fakeClock(startAt = START) {
  let value = startAt;
  return { now: () => value, advance(milliseconds) { value += milliseconds; } };
}

/** The decoded AgentSession, as `getAgentSession` returns it. */
function session(overrides = {}) {
  return {
    id: SESSION_ID, machineId: MACHINE_ID, name: "opencode", agent: "opencode",
    cwd: "/workspace/projects/project", authMode: "interactive_login",
    desiredState: "running", requestState: "launched", processState: "unknown",
    rowVersion: 3, workspaceBindingId: BINDING_ID, workspaceGeneration: 7,
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    readiness: { outcome: "pending", deadlineAt: DEADLINE_AT },
    ...overrides,
  };
}

const UNATTESTED = Object.freeze({
  outcome: "reconciliation_required", reason: "deadline_unattested", deadlineAt: DEADLINE_AT, settledAt: SETTLED_AT,
});

function terminalCapability(availability = "supported", reasonCode) {
  return {
    schemaVersion: "1.0", subjectScope: "agent_session", subjectId: SESSION_ID,
    observedAt: new Date(START).toISOString(), expiresAt: new Date(START + 30_000).toISOString(), etag: "terminal",
    capabilities: [{
      id: "terminal_connections.create", availability, interaction: "native", mutationClass: "reversible",
      surfaces: ["cli"], requiredPermissions: ["terminal_connections:create"],
      ...(reasonCode === undefined ? {} : { reasonCode }),
    }],
  };
}

function effects(client, clock = fakeClock()) {
  const waits = [];
  const value = createApiAgentJourneyEffects({
    client,
    requestedAgent: "opencode",
    async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
    async synchronizeWorkspace() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async authorizeMachineCreate() { return false; },
    now: clock.now,
    async sleep(milliseconds) { clock.advance(milliseconds); },
    onWait: (wait) => waits.push(wait),
  });
  return { effects: value, waits, clock };
}

const ready = (h) => h.effects.ensureAgentSessionReady({ agentSessionId: SESSION_ID, signal: new AbortController().signal });

/* -------------------------------------------------------------------------- */
/* W1: a verdict the server already settled ends the wait                     */
/* -------------------------------------------------------------------------- */

test("W1: reconciliation_required ends the wait on the first read that carries it, with the server's code", async () => {
  const clock = fakeClock();
  const reads = [];
  // Pending for three reads, then settled: the shape of a84513bb.
  const h = effects({
    async getAgentSession(id, _signal, options) {
      reads.push({ at: clock.now(), options });
      return session({ requestState: "launch_pending", ...(reads.length >= 4 ? { readiness: UNATTESTED } : {}) });
    },
    async discoverCapabilities() { assert.fail("an unstarted process never reaches the terminal authority"); },
  }, clock);
  await assert.rejects(ready(h), (error) => {
    assert.equal(error.code, "cuna.journey.agent_session_readiness_reconciliation_required");
    assert.equal(error.exitCode, EXIT_CODES.remote);
    assert.equal(error.retryable, false);
    assert.equal(error.details.agent_session_id, SESSION_ID);
    assert.equal(error.details.readiness_outcome, "reconciliation_required");
    assert.equal(error.details.readiness_reason, "deadline_unattested");
    assert.equal(error.details.readiness_settled_at, SETTLED_AT);
    // The child may be alive: the sentence must not say it is gone, and the
    // next step reads before it ends anything.
    assert.match(error.message, /may still be running; nothing was ended/u);
    assert.match(error.hint, new RegExp(`cuna agent-sessions get ${SESSION_ID}`, "u"));
    assert.match(error.hint, new RegExp(`cuna agent-sessions terminate ${SESSION_ID} --yes`, "u"));
    return true;
  });
  assert.equal(reads.length, 4, "no read after the one that carried the verdict");
  // Within one poll interval of the settling read: nothing waited after it.
  assert.ok(clock.now() - reads.at(-1).at <= readinessBackoffMs(10));
  assert.ok(clock.now() - START < AGENT_SESSION_READY_DEADLINE_MS, "it did not ride out the CLI's own deadline");
  // The read asked for the verdict: without the opt-in the server omits it.
  assert.deepEqual(reads[0].options, { readiness: true, runtimeEvidence: true });
});

test("W1: a refused start ends the wait with the refusal's reason and its own next step", async () => {
  const h = effects({
    async getAgentSession() {
      return session({
        requestState: "launch_pending",
        readiness: { outcome: "refused", reason: "session_capacity_memory", deadlineAt: DEADLINE_AT, settledAt: SETTLED_AT },
      });
    },
  });
  await assert.rejects(ready(h), (error) => {
    assert.equal(error.code, "cuna.journey.agent_session_readiness_refused");
    assert.equal(error.exitCode, EXIT_CODES.remote);
    assert.equal(error.details.readiness_reason, "session_capacity_memory");
    assert.equal(error.message, "The Machine does not have enough free memory to start this agent.");
    assert.match(error.hint, /End an AgentSession you no longer need/u);
    return true;
  });
});

test("W1: a reason this build has not met still ends the wait, in generic words", async () => {
  const h = effects({
    async getAgentSession() {
      return session({ readiness: { outcome: "refused", reason: "a_future_reason", deadlineAt: DEADLINE_AT, settledAt: SETTLED_AT } });
    },
  });
  await assert.rejects(ready(h), (error) => {
    assert.equal(error.code, "cuna.journey.agent_session_readiness_refused");
    assert.equal(error.details.readiness_reason, "a_future_reason");
    assert.equal(error.message, "Cuna refused to start this session.");
    return true;
  });
});

test("W1 NEGATIVE CONTROL: pending and attested keep waiting; only a settled failure stops it", async () => {
  // Varies only the readiness outcome. If `pending` stopped the wait, every
  // start slower than one poll would fail; if an absent verdict did, a server
  // older than the opt-in would fail every start.
  for (const readiness of [{ outcome: "pending", deadlineAt: DEADLINE_AT }, { outcome: "attested", deadlineAt: DEADLINE_AT, settledAt: SETTLED_AT }, undefined]) {
    let reads = 0;
    const h = effects({
      async getAgentSession() {
        reads += 1;
        const base = session({ processState: reads < 3 ? "starting" : "running" });
        if (readiness === undefined) delete base.readiness; else base.readiness = readiness;
        return base;
      },
      async discoverCapabilities() { return terminalCapability(); },
    });
    assert.deepEqual(await ready(h), { id: SESSION_ID, machineId: MACHINE_ID }, JSON.stringify(readiness));
    assert.equal(reads, 3);
  }
});

test("W1: a session the server gave up on still attaches when its terminal authority says so", async () => {
  // A late attestation promotes reconciliation_required to attested, so a
  // running process with a granted terminal is attachable and must not be
  // refused for a verdict the server is about to revise.
  const h = effects({
    async getAgentSession() { return session({ processState: "running", readiness: UNATTESTED }); },
    async discoverCapabilities() { return terminalCapability(); },
  });
  assert.deepEqual(await ready(h), { id: SESSION_ID, machineId: MACHINE_ID });
});

test("W1: the server's verdict outranks a terminal authority that is still refusing", async () => {
  let capabilityReads = 0;
  const h = effects({
    async getAgentSession() { return session({ processState: "running", readiness: UNATTESTED }); },
    async discoverCapabilities() { capabilityReads += 1; return terminalCapability("unknown", "supervisor_registry_unavailable"); },
  });
  await assert.rejects(ready(h), (error) => error.code === "cuna.journey.agent_session_readiness_reconciliation_required");
  assert.equal(capabilityReads, 1);
});

/* The remote-only launch path polls the same route and must end the same way. */

const directories = [];
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function remoteFixture(sessionRead) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "cuna-wait-truth-"));
  directories.push(stateDirectory);
  let clock = START;
  const workspace = {
    machineId: "machine", workspaceId: "account-workspace", executionWorkspaceId: "execution",
    remoteRoot: "/workspace/workspaces/execution", workspaceGeneration: 1, publicationStatus: "ready",
  };
  const base = {
    id: "session", machineId: "machine", agent: "opencode", cwd: workspace.remoteRoot,
    authMode: "interactive_login", requestState: "launch_pending", processState: "unknown",
  };
  const waits = [];
  const reads = [];
  const client = {
    async discoverCapabilities(scope, id) {
      return {
        schemaVersion: "1.0", subjectScope: scope, subjectId: id,
        observedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(), etag: "test",
        capabilities: [["machines.default_workspace.read", "read_only"], ["agent_sessions.workspace.create", "native"],
          ["agent_sessions.workspace.read", "read_only"]].map(([capabilityId, interaction]) => ({
          id: capabilityId, interaction, availability: "supported", mutationClass: "none", surfaces: ["cli"], requiredPermissions: [],
        })),
      };
    },
    async getMachineDefaultWorkspace() { return workspace; },
    async createProviderSessionV2() { return { agentSession: base }; },
    async getAgentSession(_id, _signal, options) { reads.push({ at: clock, options }); return { ...base, ...sessionRead(reads.length) }; },
  };
  return {
    reads, waits, now: () => clock,
    input: {
      client, machineId: "machine", workspaceId: "account-workspace", agent: "opencode",
      providerLaunchState: { stateDirectory, ownerId: "owner" },
      preset: { kind: "provider_preset", agent: "opencode", label: "OpenCode Zen", profile_id: "profile", profile_revision: 1 },
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; }, onWait: (wait) => waits.push(wait),
    },
  };
}

test("W1: the remote-only launch ends on the server's verdict too", async () => {
  const f = remoteFixture((read) => (read >= 3 ? { readiness: UNATTESTED } : { readiness: { outcome: "pending", deadlineAt: DEADLINE_AT } }));
  await assert.rejects(launchRemoteWorkspaceSession(f.input), (error) => {
    assert.equal(error.code, "cuna.journey.agent_session_readiness_reconciliation_required");
    assert.equal(error.details.readiness_reason, "deadline_unattested");
    return true;
  });
  assert.equal(f.reads.length, 3);
  assert.deepEqual(f.reads[0].options, { readiness: true, runtimeEvidence: true });
});

/* -------------------------------------------------------------------------- */
/* W2: the wait names what the server says is holding it up                   */
/* -------------------------------------------------------------------------- */

for (const [name, overrides, cause] of [
  ["an unclaimed launch", { requestState: "launch_pending" }, "no supervisor has claimed the launch"],
  ["a claimed launch with no report", { requestState: "runtime_claimed" }, "launch claimed, no process report yet"],
  ["a supervisor report and its age", {
    requestState: "launched", processState: "starting",
    runtimeEvidence: { source: "supervisor_ack", observedAt: "2026-09-29T22:12:18.000Z", ageSeconds: 42, processProof: "unproven" },
  }, "last supervisor report 42s ago"],
]) {
  test(`W2: the wait line names ${name}`, async () => {
    let reads = 0;
    const h = effects({
      async getAgentSession() { reads += 1; return session(reads === 1 ? overrides : { processState: "running" }); },
      async discoverCapabilities() { return terminalCapability(); },
    });
    await ready(h);
    assert.equal(h.waits.length, 1);
    assert.equal(h.waits[0].waitingFor, "the session process to start");
    assert.equal(h.waits[0].cause, cause);
    // And on screen, before the countdown, so a narrow terminal keeps it.
    assert.equal(journeyWaitLine(h.waits[0]), `Still waiting for the session process to start · ${cause} · 0s of 180s`);
  });
}

test("W2 NEGATIVE CONTROL: with nothing positive to say, no cause is invented", async () => {
  // Launched, no evidence: the server said nothing about why, and an absent
  // `runtime_evidence` may only mean an older server that ignored the opt-in.
  let reads = 0;
  const h = effects({
    async getAgentSession() { reads += 1; return session({ requestState: "launched", processState: reads === 1 ? "starting" : "running" }); },
    async discoverCapabilities() { return terminalCapability(); },
  });
  await ready(h);
  assert.equal(h.waits[0].cause, undefined);
  assert.equal(journeyWaitLine(h.waits[0]), "Still waiting for the session process to start · 0s of 180s");
});

test("W2: the painted progress row keeps the cause", () => {
  const line = composeInlineProgressLine({
    label: "Starting OpenCode",
    waiting: { waitingFor: "the session process to start", cause: "no supervisor has claimed the launch", elapsedMs: 45_900, deadlineMs: 180_000 },
    labelElapsedMs: 45_900, totalElapsedMs: 67_000,
  });
  assert.equal(line.headline, "Still waiting for the session process to start · no supervisor has claimed the launch · 45s of 180s");
});

test("W2: the CLI's own timeout records the last cause it showed", async () => {
  const h = effects({ async getAgentSession() { return session({ requestState: "launch_pending" }); } });
  await assert.rejects(ready(h), (error) => {
    assert.equal(error.code, "cuna.journey.agent_session_ready_timeout");
    assert.equal(error.details.wait_cause, "no supervisor has claimed the launch");
    return true;
  });
});

test("W2: the remote-only launch names the cause too", async () => {
  const f = remoteFixture((read) => (read === 1 ? {} : { processState: "running" }));
  assert.equal(await launchRemoteWorkspaceSession(f.input), "session");
  assert.equal(f.waits.at(-1).cause, "no supervisor has claimed the launch");
});
