// `agent-sessions create` is usable without two UUIDs the product never
// published.
//
// Nothing publishes a workspace binding id: there is no list operation, and
// `agent-sessions list` carries the pair only for sessions that already exist.
// The pair is read from the folder's own `.cuna/workspace.json` instead, and an
// unbound folder is refused by naming the command that binds one. A binding is
// never created here: that means choosing a local root, an exclusion policy and
// a project identity, which are the journey's decisions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { persistWorkspaceBinding } from "../dist/workspace/binding-store.js";

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const NOW_MS = Date.parse("2026-09-02T00:00:00.000Z");
const OBSERVED_AT = new Date(NOW_MS).toISOString();
const EXPIRES_AT = new Date(NOW_MS + 30_000).toISOString();

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

async function boundFolder(t, generation = 7) {
  const root = await mkdtemp(join(tmpdir(), "cuna-session-create-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await persistWorkspaceBinding({
    root,
    expected: null,
    binding: {
      profileId: "default",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      projectId: PROJECT_ID,
      localInstanceId: "77777777-7777-4777-8777-777777777777",
      machineId: MACHINE_ID,
      // The store requires `remoteRoot` to equal `/workspace/projects/<projectId>`.
      remoteRoot: `/workspace/projects/${PROJECT_ID}`,
      policyDigest: "a".repeat(64),
      generation,
      bindingCreatedAt: "2026-09-01T00:00:00.000000+00:00",
      bindingUpdatedAt: "2026-09-01T00:00:00.000000+00:00",
    },
  });
  return root;
}

async function unboundFolder(t) {
  const root = await mkdtemp(join(tmpdir(), "cuna-session-unbound-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

/** Run `agent-sessions create` and report what reached the API. */
async function create(argv, workspaceRoot) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const sent = [];
  let identityReads = 0;
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    now: () => NOW_MS,
    workspaceRoot,
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async getIdentity() {
        identityReads += 1;
        return { id: USER_ID, email: "someone@example.com", workspaceAssigned: true, workspaceId: WORKSPACE_ID };
      },
      async discoverCapabilities(scope, resourceId) {
        return {
          schemaVersion: "1.0",
          subjectScope: scope,
          subjectId: resourceId,
          observedAt: OBSERVED_AT,
          expiresAt: EXPIRES_AT,
          etag: "e",
          capabilities: [{
            id: "agent_sessions.create",
            availability: "supported",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
          }],
        };
      },
      async getMachine() {
        return {
          id: MACHINE_ID,
          name: "harness",
          state: "running",
          agent: "opencode",
          vcpus: 1,
          memoryMiB: 2048,
        };
      },
      // `createAgentSession(machineId, input)` — the request body is the
      // SECOND argument.
      async createAgentSession(_machineId, input) {
        sent.push(input);
        throw new Error("stop-after-request");
      },
    }),
  });
  const stderr = streams.stderr().trim();
  const record = stderr === "" ? undefined : JSON.parse(stderr.split("\n").at(-1));
  return { exit, record, sent, identityReads };
}

test("a bound folder supplies the binding and the generation with no flags", async (t) => {
  const root = await boundFolder(t, 7);
  const run = await create(
    ["agent-sessions", "create", "--machine", MACHINE_ID, "--agent", "opencode", "--yes"],
    root,
  );
  // The request is what proves it: the pair the caller never typed reached the
  // API, read from the folder's own binding.
  assert.equal(run.sent.length, 1, JSON.stringify(run.record));
  assert.equal(run.sent[0].workspaceBindingId, BINDING_ID);
  assert.equal(run.sent[0].workspaceGeneration, 7);
});

test("an explicit flag still wins over the folder", async (t) => {
  const root = await boundFolder(t, 7);
  const other = "88888888-8888-4888-8888-888888888888";
  const run = await create(
    [
      "agent-sessions", "create", "--machine", MACHINE_ID, "--agent", "opencode", "--yes",
      "--workspace-binding-id", other, "--workspace-generation", "3",
    ],
    root,
  );
  assert.equal(run.sent.length, 1, JSON.stringify(run.record));
  assert.equal(run.sent[0].workspaceBindingId, other);
  assert.equal(run.sent[0].workspaceGeneration, 3);
  // A caller who supplied both must not pay for a read they did not need.
  assert.equal(run.identityReads, 0);
});

test("an unbound folder is refused by naming the command that binds one", async (t) => {
  const root = await unboundFolder(t);
  const run = await create(
    ["agent-sessions", "create", "--machine", MACHINE_ID, "--agent", "opencode", "--yes"],
    root,
  );
  assert.equal(run.exit, EXIT_CODES.usage, JSON.stringify(run.record));
  assert.equal(run.record.error.code, "cuna.workspace.binding_required");
  assert.equal(run.record.error.details.reason, "folder_not_bound");
  assert.match(run.record.error.hint, /cuna opencode/u);
  // Nothing was attempted.
  assert.equal(run.sent.length, 0);
});

test("a binding with no committed generation says so rather than sending zero", async (t) => {
  // `generation` is a fencing token compared exactly. A folder bound but not yet
  // synchronised carries 0, and sending it would be a request the producer must
  // reject for a reason the reader could not act on.
  const root = await boundFolder(t, 0);
  const run = await create(
    ["agent-sessions", "create", "--machine", MACHINE_ID, "--agent", "opencode", "--yes"],
    root,
  );
  assert.equal(run.exit, EXIT_CODES.usage, JSON.stringify(run.record));
  assert.equal(run.record.error.details.reason, "generation_uncommitted");
  assert.equal(run.sent.length, 0);
});

test("a malformed binding id is still refused before any network work", async (t) => {
  // The negative control for making the options optional: preflight must still
  // reject a value that IS supplied and malformed.
  const root = await boundFolder(t, 7);
  const run = await create(
    [
      "agent-sessions", "create", "--machine", MACHINE_ID, "--agent", "opencode", "--yes",
      "--workspace-binding-id", "not-a-uuid",
    ],
    root,
  );
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.equal(run.record.error.message, "Invalid workspace binding ID.");
  assert.equal(run.sent.length, 0);
  assert.equal(run.identityReads, 0);
});
