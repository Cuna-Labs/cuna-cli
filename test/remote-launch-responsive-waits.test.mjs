import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { launchRemoteWorkspaceSession } from "../dist/journey/remote-workspace.js";
import { settledAgentSessionDisposition } from "../dist/journey/session-disposition.js";
import { observationBudgetElapsed, REMOTE_CONVERGENCE_BUDGET_MS } from "../dist/core/observation-budget.js";

/**
 * The remote-only launch path, held to the same three promises the local-path
 * journey now keeps (`test/journey-responsive-waits.test.mjs`): one slow read
 * of an idempotent route does not end the launch, every wait says what it is
 * waiting for, and the row is named as created or reused the moment it exists.
 *
 * It polls `GET /v1/agent-sessions/<id>` for the same reason and with the same
 * budget as the loop that produced the measured 83 s abort
 * (`prds/cuna-cli-latency-before-20260922.md` § 2, run `cold1`), so it is the
 * other place the defect could survive.
 */

const directories = [];
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function budgetElapsed(path) {
  return observationBudgetElapsed({
    kind: "response",
    operation: `GET ${path}`,
    budgetMs: 15_000,
    details: { method: "GET", path },
  });
}

function fixture() {
  const stateDirectory = mkdtempSync(join(tmpdir(), "cuna-remote-wait-"));
  directories.push(stateDirectory);
  // The clock advances only inside the fake sleep and where a test says a read
  // burned its budget, so every elapsed figure reported is one this test set.
  let clock = Date.parse("2026-09-22T02:33:22.723Z");
  const workspace = {
    machineId: "machine", workspaceId: "account-workspace", executionWorkspaceId: "execution",
    remoteRoot: "/workspace/workspaces/execution", workspaceGeneration: 1, publicationStatus: "ready",
  };
  const session = {
    id: "session", machineId: "machine", agent: "opencode", cwd: workspace.remoteRoot,
    authMode: "interactive_login", requestState: "launch_pending", processState: "running",
  };
  const waits = [];
  const settled = [];
  const operations = [];
  const client = {
    async discoverCapabilities(scope, id) {
      return {
        schemaVersion: "1.0", subjectScope: scope, subjectId: id,
        observedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(),
        etag: "test",
        capabilities: [
          ["machines.default_workspace.read", "read_only"],
          ["agent_sessions.workspace.create", "native"],
          ["agent_sessions.workspace.read", "read_only"],
        ].map(([capabilityId, interaction]) => ({
          id: capabilityId, interaction, availability: "supported",
          mutationClass: "none", surfaces: ["cli"], requiredPermissions: [],
        })),
      };
    },
    async getMachineDefaultWorkspace() { return workspace; },
    async createProviderSessionV2(_machineId, request) { operations.push(request.operation_id); return { agentSession: session }; },
    async getAgentSession() { return session; },
  };
  const input = {
    client, machineId: "machine", workspaceId: "account-workspace", agent: "opencode",
    providerLaunchState: { stateDirectory, ownerId: "owner" },
    preset: { kind: "provider_preset", agent: "opencode", label: "OpenCode Zen", profile_id: "profile", profile_revision: 1 },
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    onWait: (wait) => waits.push(wait),
    onAgentSession: (event) => settled.push(event),
  };
  return { input, client, workspace, session, waits, settled, operations, advance: (ms) => { clock += ms; } };
}

test("a slow remote session read is re-issued and the launch still attaches", async () => {
  const f = fixture();
  let reads = 0;
  f.client.getAgentSession = async (id) => {
    if (reads++ === 0) { f.advance(15_000); throw budgetElapsed(`/v1/agent-sessions/${id}`); }
    return f.session;
  };
  assert.equal(await launchRemoteWorkspaceSession(f.input), "session");
  assert.equal(reads, 2, "the same idempotent read is asked again");
  assert.deepEqual(f.waits.map((wait) => wait.waitingFor), ["Cuna to answer the remote session read"]);
  assert.equal(f.waits[0].deadlineMs, REMOTE_CONVERGENCE_BUDGET_MS);
  assert.equal(f.waits[0].elapsedMs, 15_000);
});

test("NEGATIVE CONTROL: the same slow read ends the launch once its deadline has elapsed", async () => {
  // The old behaviour, reproduced by removing the only thing that changed:
  // launch time left. `cold1` exited 5 here with exactly this refusal.
  const f = fixture();
  let reads = 0;
  f.client.getAgentSession = async (id) => {
    reads += 1;
    f.advance(REMOTE_CONVERGENCE_BUDGET_MS + 1_000);
    throw budgetElapsed(`/v1/agent-sessions/${id}`);
  };
  await assert.rejects(launchRemoteWorkspaceSession(f.input), (error) => {
    assert.equal(error.code, "cuna.client.response_budget_elapsed");
    assert.equal(error.details.remote_outcome, "unobserved");
    assert.equal(error.details.waiting_for, "Cuna to answer the remote session read");
    assert.equal(error.details.read_reissues, 0);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(reads, 1, "a launch with no time left must not re-issue");
});

test("a create is never turned into a wait, and its replay keeps one durable identity", async () => {
  // R5's other half on this path. The single replay below is the existing
  // at-most-once dispatch under a recorded operation id, not the read policy:
  // the wait reporter must stay silent for anything that commits.
  const f = fixture();
  const requests = [];
  f.client.createProviderSessionV2 = async (_machineId, request) => {
    requests.push(request);
    if (requests.length === 1) throw budgetElapsed("/v1/machines/machine/provider-sessions");
    return { agentSession: f.session };
  };
  assert.equal(await launchRemoteWorkspaceSession(f.input), "session");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(f.waits, [], "a mutation must never render as a wait the CLI intends to repeat");
});

test("a pending publication names what it waits for instead of one unchanging label", async () => {
  const f = fixture();
  f.workspace.publicationStatus = "pending";
  const progress = [];
  f.input.onProgress = (line) => progress.push(line);
  await assert.rejects(launchRemoteWorkspaceSession(f.input), (error) => {
    assert.equal(error.details.remote_outcome, "unobserved");
    assert.equal(error.details.waiting_for, "the machine to publish its remote Workspace");
    return true;
  });
  assert.deepEqual([...new Set(f.waits.map((wait) => wait.waitingFor))], ["the machine to publish its remote Workspace"]);
  // The elapsed figure must move, or the line repeats and the dwell returns.
  assert.ok(f.waits.length > 1);
  assert.ok(f.waits.at(-1).elapsedMs > f.waits[0].elapsedMs);
  // What the label alone had to offer: one sentence, said once, for the whole
  // wait. That is the measured defect, and it is why the wait line exists.
  assert.deepEqual(progress, ["Preparing remote workspace · no local sync"]);
});

test("a remote session that has not started yet is named as such", async () => {
  const f = fixture();
  let reads = 0;
  f.client.getAgentSession = async () => ({ ...f.session, processState: reads++ === 0 ? "pending" : "running" });
  assert.equal(await launchRemoteWorkspaceSession(f.input), "session");
  assert.deepEqual(f.waits.map((wait) => wait.waitingFor), ["the remote session to start"]);
  assert.equal(f.waits[0].deadlineMs, REMOTE_CONVERGENCE_BUDGET_MS);
});

test("a new remote launch is announced as created, before readiness is waited on", async () => {
  const f = fixture();
  const order = [];
  f.client.createProviderSessionV2 = async (_machineId, request) => {
    order.push("create"); f.operations.push(request.operation_id); return { agentSession: f.session };
  };
  f.client.getAgentSession = async () => { order.push("readiness-read"); return f.session; };
  f.input.onAgentSession = (event) => { order.push(`announce:${event.disposition}`); f.settled.push(event); };
  await launchRemoteWorkspaceSession(f.input);
  assert.deepEqual(order, ["create", "announce:created", "readiness-read"]);
  assert.deepEqual(f.settled, [{ agentSessionId: "session", machineId: "machine", disposition: "created" }]);
});

test("a resumed recorded launch is announced as reused, not created", async () => {
  const f = fixture();
  await launchRemoteWorkspaceSession(f.input);
  await launchRemoteWorkspaceSession({ ...f.input, confirmNew: async () => false });
  assert.deepEqual(f.settled.map((event) => event.disposition), ["created", "reused"]);
  assert.equal(new Set(f.operations).size, 1, "a resume re-dispatches the recorded identity");
});

test("a resume taken without asking is still a reuse", async () => {
  // The hole an answer-based inference would leave: with no `confirmNew`
  // wired, `await undefined?.()` is undefined and the resume branch is taken
  // without anyone being asked. Nobody said No, and it is still not new.
  const f = fixture();
  await launchRemoteWorkspaceSession(f.input);
  await launchRemoteWorkspaceSession(f.input);
  assert.deepEqual(f.settled.map((event) => event.disposition), ["created", "reused"]);
  assert.equal(new Set(f.operations).size, 1);
});

test("confirming a new session rotates the identity and is announced as created", async () => {
  const f = fixture();
  await launchRemoteWorkspaceSession(f.input);
  await launchRemoteWorkspaceSession({ ...f.input, confirmNew: async () => true });
  assert.deepEqual(f.settled.map((event) => event.disposition), ["created", "created"]);
  assert.equal(new Set(f.operations).size, 2);
});

test("the disposition rule turns a planned create into a reuse, and never the reverse", () => {
  assert.equal(settledAgentSessionDisposition({ planned: "created", resumedRecordedLaunch: false }), "created");
  assert.equal(settledAgentSessionDisposition({ planned: "created", resumedRecordedLaunch: true }), "reused");
  assert.equal(settledAgentSessionDisposition({ planned: "reused", resumedRecordedLaunch: false }), "reused");
  assert.equal(settledAgentSessionDisposition({ planned: "reused", resumedRecordedLaunch: true }), "reused");
});
