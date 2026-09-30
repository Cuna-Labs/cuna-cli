import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCunaApiClient, createHttpTransport, EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { createApiAgentJourneyEffects } from "../dist/journey/api-effects.js";
import { conservativeFilesystemCapabilities, createWorkspaceJourneyEffects } from "../dist/journey/workspace-effects.js";

/*
 * D1 of the C4.8 fast-refusal witness
 * (`_meta_audit/2026-09-30-c48-fast-refusal/witness.json`, LIVE_RUNTIME,
 * Edge v241 / infra a6e6f8c, Machine cd0696a7 locked out): `cuna opencode .`
 * on drop f5aa387 and on installed 0.1.5 ended in ~9 s, but printed
 *
 *   Error [cuna.journey.agent_session_create_outcome_unreconcilable]: Cuna
 *   cannot prove whether the AgentSession create request committed. ...
 *   recovery: exhausted ... Next: Do not request another child with a new key.
 *   Retry recovery with the original journey identity.
 *
 * and exited 7, for a 409 `machine_supervisor_control_expired` the server had
 * marked final (`retryable: false`, action `contact_support`).
 *
 * Boundary modelled: `runCli` running the real `cuna opencode .` journey (the
 * orchestrator, the real API effects' create, the real launch record, and the
 * real HTTP transport and error mapping) over a fake `fetch` that answers
 * the create route with the lockout Problem. Machine selection, readiness and
 * the Workspace sync are fakes, except in the binding/sync test, which runs
 * the real Workspace effects over a real folder. The Problem bodies are the
 * shape `edge/src/supervisor-control-admission.ts` builds at a6e6f8c.
 */

const API_KEY = "cuna_sk_abcdefghijklmnop";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const EXECUTION_ID = "44444444-4444-4444-8444-444444444444";
const BINDING_ID = "55555555-5555-4555-8555-555555555555";
const PROFILE_ID = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

const LOCKOUTS = Object.freeze({
  machine_supervisor_control_expired: {
    title: "Machine supervisor locked out",
    detail: "This Machine's supervisor lost contact with Cuna and its control credential expired at 2026-09-29T21:37:52.000Z. No AgentSession can start on it until control is restored; AgentSessions already running keep running. Cuna support can restore control in place without restarting them. To recover now instead, stop the Machine and run `cuna machines update-supervisor 33333333-3333-4333-8333-333333333333 --yes`, which ends every AgentSession on it.",
    action: "contact_support",
  },
  machine_supervisor_control_revoked: {
    title: "Machine supervisor revoked",
    detail: "Cuna revoked this Machine's supervisor control, so no AgentSession can start on it. To install a new supervisor, stop the Machine and run `cuna machines update-supervisor 33333333-3333-4333-8333-333333333333 --yes`, which ends every AgentSession on it.",
    action: "none",
  },
  machine_supervisor_control_absent: {
    title: "Machine supervisor not enrolled",
    detail: "This Machine has no supervisor control on record, so no AgentSession can start on it. To install one, stop the Machine and run `cuna machines update-supervisor 33333333-3333-4333-8333-333333333333 --yes`, which ends every AgentSession on it.",
    action: "none",
  },
});

const directories = [];
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * A fake `fetch` that answers the listed routes in order. Every other request
 * fails the test, so a journey that reached further than it should says so.
 * `answers[path]` is a list of "lockout:<code>" | "network" | a JSON body.
 */
function serverAnswering(answers) {
  const seen = [];
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method: init?.method ?? "GET", path, body });
    const queue = Object.entries(answers).find(([route]) => path.endsWith(route))?.[1];
    const answer = queue?.shift();
    if (answer === undefined) throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    if (answer === "network") throw new TypeError("fetch failed");
    if (typeof answer === "string" && answer.startsWith("lockout:")) {
      const code = answer.slice("lockout:".length);
      const { title, detail, action } = LOCKOUTS[code];
      return new Response(JSON.stringify({
        type: `https://api.getcuna.com/problems/${code}`, title, status: 409, code, detail,
        retryable: false, action, request_id: REQUEST_ID,
      }), { status: 409, headers: { "content-type": "application/problem+json" } });
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  const transport = createHttpTransport({ baseUrl: "https://api.getcuna.com", apiKey: API_KEY, fetch });
  return { seen, transport, client: createCunaApiClient(transport) };
}

function capabilities(scope, subjectId) {
  const now = Date.now();
  return {
    schemaVersion: "1.0", subjectScope: scope, ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), etag: "fixture",
    capabilities: [{
      id: "agent_sessions.create", availability: "supported", interaction: "native",
      mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: [],
    }],
  };
}

const PRESET = Object.freeze({ kind: "provider_preset", agent: "opencode", label: "OpenCode Zen", profile_id: PROFILE_ID, profile_revision: 1 });

/**
 * The real journey effects with only Machine selection, readiness and (unless
 * given) the Workspace faked. `createAgentSession` is the real one.
 */
function journeyEffects({ server, stateDirectory, workspace }) {
  const client = {
    async discoverCapabilities(scope, id) { return capabilities(scope, id); },
    createProviderSessionV2: server.client.createProviderSessionV2,
    async getAgentSession() { assert.fail("a refused launch has no session to read"); },
  };
  const real = createApiAgentJourneyEffects({
    client,
    requestedAgent: "opencode",
    providerLaunchState: { stateDirectory, ownerId: USER_ID, workspaceId: WORKSPACE_ID },
    async selectProviderPreset() { return PRESET; },
    async confirmNewProviderLaunch() { return false; },
    inspectWorkspace: workspace?.inspectWorkspace ?? (async () => ({ canonicalLocalRoot: "C:\\work\\project" })),
    synchronizeWorkspace: workspace?.synchronizeWorkspace ?? (async () => ({
      bindingId: BINDING_ID, workspaceIdentity: BINDING_ID, executionWorkspaceId: EXECUTION_ID,
      generation: 1, remoteCwd: `/workspace/workspaces/${EXECUTION_ID}`,
    })),
    async attach() { assert.fail("a refused launch never attaches"); },
    async authorizeMachineCreate() { return false; },
  });
  return {
    ...real,
    async observeMachines() {
      return [{
        id: MACHINE_ID, name: "qa-c3-20260929", agent: "opencode", requestedAgentSupport: "supported", state: "running",
        ownership: "owned", freshness: "fresh", recency: "recent", resources: {}, costStatus: "known",
      }];
    },
    async ensureMachineReady({ machineId }) { return { id: machineId, state: "running" }; },
    async observeAgentSessions() { return []; },
    async ensureAgentSessionReady() { assert.fail("a refused launch is never waited on"); },
    async reconcileCancellation() {},
  };
}

/** `cuna opencode .` at an interactive terminal, as the witness ran it. */
async function opencode({ server, stateDirectory, workspace, path = "." }) {
  const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: false });
  const exit = await runCli(["opencode", path, "--machine", "qa-c3-20260929"], {
    streams: streams.streams,
    platform: {
      kind: "linux",
      paths: { configDirectory: "/cfg", stateDirectory, runtimeDirectory: "/run" },
      async readSafeConfig() { return { exists: false }; },
    },
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => ({
      async getIdentity() {
        return { id: USER_ID, email: "developer@example.test", workspaceAssigned: true, workspaceId: WORKSPACE_ID };
      },
      async discoverCapabilities(scope, id) { return capabilities(scope, id); },
    }),
    automaticJourneyEffectsFactory: () => journeyEffects({ server, stateDirectory, workspace }),
  });
  return { exit, stderr: streams.stderr(), stdout: streams.stdout() };
}

const creates = (server) => server.seen.filter((request) => request.path.endsWith("/workspace-agent-sessions"));

for (const [code, { title, detail }] of Object.entries(LOCKOUTS)) {
  test(`D1: \`cuna opencode .\` refused with ${code} prints the server's refusal and exits 6`, async () => {
    const server = serverAnswering({ "/workspace-agent-sessions": [`lockout:${code}`] });
    const run = await opencode({ server, stateDirectory: scratch("cuna-lockout-") });
    assert.equal(run.exit, EXIT_CODES.conflict, run.stderr);
    assert.match(run.stderr, new RegExp(`Error \\[cuna\\.remote\\.conflict\\]: ${title}\\n`, "u"));
    assert.match(run.stderr, new RegExp(`\\n  reason: ${code}\\n`, "u"));
    assert.ok(run.stderr.includes(`Next: ${detail}`), run.stderr);
    // What 8df1553 through f5aa387 said instead, none of which is true of a
    // refusal the server made final.
    assert.doesNotMatch(run.stderr, /cannot prove|unreconcilable|recovery|original journey identity|new key/u);
    assert.equal(creates(server).length, 1, "one create, no replay");
  });
}

test("D1: a launch refused on its first send is settled, so the next run starts a new one", async () => {
  // The witness's second run (installed 0.1.5, 50 s later, same folder) found
  // the first run's launch still recorded as unresolved. Kept pending, a
  // refused launch is re-sent forever, and once the Workspace changes it is
  // refused locally as "a previous provider launch is unresolved".
  const stateDirectory = scratch("cuna-lockout-settle-");
  const server = serverAnswering({ "/workspace-agent-sessions": ["lockout:machine_supervisor_control_expired", "lockout:machine_supervisor_control_expired"] });
  assert.equal((await opencode({ server, stateDirectory })).exit, EXIT_CODES.conflict);
  const second = await opencode({ server, stateDirectory });
  assert.equal(second.exit, EXIT_CODES.conflict, second.stderr);
  const [first, next] = creates(server).map((request) => request.body.operation_id);
  assert.notEqual(next, first, "the refused launch is not re-sent as if its outcome were unknown");
  assert.doesNotMatch(second.stderr, /earlier attempt/u);
});

test("D1: a refusal after an unanswered first send keeps the launch and says where to look", async () => {
  // Here the first POST's answer was lost, so it may have committed; on C4.8
  // the lockout is checked before idempotent replay and would hide that
  // (witness D3). The refusal is still final for the re-send, but not proof
  // about the first one.
  const stateDirectory = scratch("cuna-lockout-replay-");
  const server = serverAnswering({ "/workspace-agent-sessions": ["network", "lockout:machine_supervisor_control_expired", "lockout:machine_supervisor_control_expired"] });
  const run = await opencode({ server, stateDirectory });
  assert.equal(run.exit, EXIT_CODES.conflict, run.stderr);
  assert.match(run.stderr, /Error \[cuna\.remote\.conflict\]: Machine supervisor locked out\n/u);
  assert.ok(run.stderr.includes(`An earlier attempt of this launch got no answer and may have started a session; \`cuna agent-sessions list --machine ${MACHINE_ID}\` shows it.`), run.stderr);
  assert.doesNotMatch(run.stderr, /cannot prove|recovery|original journey identity/u);
  const [first, replay] = creates(server).map((request) => request.body.operation_id);
  assert.equal(replay, first, "the re-send carries the same launch identity");
  // Not settled: the next run re-sends the same identity, and says the same.
  const second = await opencode({ server, stateDirectory });
  assert.equal(second.exit, EXIT_CODES.conflict, second.stderr);
  assert.equal(creates(server).at(-1).body.operation_id, first);
  assert.match(second.stderr, /An earlier attempt of this launch got no answer/u);
});

test("D1 NEGATIVE CONTROL: a create refusal the server did not make final stays unreconcilable", async () => {
  // Varies only the code: `provider_session_v2_operation_conflict` is a 409
  // whose detail says creation could not be confirmed. Status alone must not
  // turn it into a definitive refusal.
  const stateDirectory = scratch("cuna-lockout-control-");
  const fetchAnswer = async () => new Response(JSON.stringify({
    type: "https://api.getcuna.com/problems/provider_session_v2_operation_conflict", title: "Provider session creation unavailable",
    status: 409, code: "provider_session_v2_operation_conflict",
    detail: "Creation could not be confirmed. Preserve the same operation identity when retrying the same request.",
    retryable: false, action: "none", request_id: REQUEST_ID,
  }), { status: 409, headers: { "content-type": "application/problem+json" } });
  const transport = createHttpTransport({ baseUrl: "https://api.getcuna.com", apiKey: API_KEY, fetch: fetchAnswer });
  const server = { seen: [], transport, client: createCunaApiClient(transport) };
  const run = await opencode({ server, stateDirectory });
  assert.equal(run.exit, EXIT_CODES.remote, run.stderr);
  assert.match(run.stderr, /cuna\.journey\.agent_session_create_outcome_unreconcilable/u);
});

test("D2: the same refusal at the Workspace binding, the sync, or the create reads the same", async () => {
  // Edge D2 (not yet deployed) moves the refusal to the first mutation of the
  // journey: the WorkspaceBinding create, or the sync session. Whichever step
  // receives it, the person must read one refusal, not three.
  const code = "machine_supervisor_control_expired";
  const project = scratch("cuna-lockout-project-");
  writeFileSync(join(project, "main.js"), "console.log(1);\n");
  const realWorkspace = (server, stateDirectory, client) => createWorkspaceJourneyEffects({
    client,
    transport: { request: (request) => server.transport.request(request), authentication: "authenticated", credentialAuthority: "api_key" },
    profileId: "default", userId: USER_ID, workspaceId: WORKSPACE_ID, stateDirectory,
    filesystemCapabilities: conservativeFilesystemCapabilities(process.platform === "win32" ? "windows" : "linux"),
  });
  const render = (stderr) => stderr.split("\n").filter((line) => !line.startsWith("  request_id:")).join("\n");

  // At the binding: the first run of a folder creates its WorkspaceBinding.
  const atBinding = serverAnswering({ "/v1/workspace-bindings": [`lockout:${code}`] });
  const bindingState = scratch("cuna-lockout-binding-state-");
  const bindingRun = await opencode({ server: atBinding, stateDirectory: bindingState, path: project, workspace: realWorkspace(atBinding, bindingState, atBinding.client) });

  // At the sync: the binding exists, and the upload's first request is refused.
  const atSync = serverAnswering({ "/sync-sessions": [`lockout:${code}`] });
  const syncState = scratch("cuna-lockout-sync-state-");
  const bindingClient = {
    async createWorkspaceBinding(input) {
      return {
        bindingId: BINDING_ID, workspaceId: WORKSPACE_ID, projectId: input.projectId, localInstanceId: input.localInstanceId,
        machineId: MACHINE_ID, executionWorkspaceId: EXECUTION_ID, remoteRoot: `/workspace/workspaces/${EXECUTION_ID}`,
        exclusionPolicyDigest: input.exclusionPolicyDigest, activeGeneration: 0, activeManifestRoot: "0".repeat(64),
        bindingEpoch: 1, minimumReader: 1, minimumWriter: 2,
        createdAt: "2026-09-30T07:58:09.764Z", updatedAt: "2026-09-30T07:58:09.764Z",
      };
    },
  };
  const syncRun = await opencode({ server: atSync, stateDirectory: syncState, path: project, workspace: realWorkspace(atSync, syncState, bindingClient) });

  // At the create, as the witness saw it.
  const atCreate = serverAnswering({ "/workspace-agent-sessions": [`lockout:${code}`] });
  const createRun = await opencode({ server: atCreate, stateDirectory: scratch("cuna-lockout-create-state-") });

  for (const [step, run, server, route] of [
    ["binding", bindingRun, atBinding, "/v1/workspace-bindings"],
    ["sync", syncRun, atSync, "/sync-sessions"],
    ["create", createRun, atCreate, "/workspace-agent-sessions"],
  ]) {
    assert.equal(run.exit, EXIT_CODES.conflict, `${step}: ${run.stderr}`);
    assert.ok(server.seen.at(-1).path.endsWith(route), `${step} stopped at its own step: ${server.seen.at(-1).path}`);
  }
  assert.equal(render(bindingRun.stderr), render(createRun.stderr));
  assert.equal(render(syncRun.stderr), render(createRun.stderr));
});
