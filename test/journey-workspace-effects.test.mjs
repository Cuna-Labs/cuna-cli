import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
import { conservativeFilesystemCapabilities, createWorkspaceJourneyEffects } from "../dist/journey/workspace-effects.js";

const USER = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const MACHINE = "30000000-0000-4000-8000-000000000001";
const OTHER_MACHINE = "30000000-0000-4000-8000-000000000002";

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), "cuna-journey-workspace-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(base, { recursive: true, force: true })); });
  const project = join(base, "project");
  const state = join(base, "state");
  await Promise.all([mkdir(project), mkdir(state)]);
  return { project, state };
}

function effects(client, stateDirectory, options = {}) {
  return createWorkspaceJourneyEffects({
    client,
    transport: { authentication: "authenticated", credentialAuthority: "interactive", async request() { throw new Error("unexpected sync"); } },
    profileId: "default",
    userId: USER,
    workspaceId: WORKSPACE,
    stateDirectory,
    filesystemCapabilities: conservativeFilesystemCapabilities("windows"),
    ...options,
  });
}

const PROJECT = "50000000-0000-4000-8000-000000000009";
const LOCAL_INSTANCE = "60000000-0000-4000-8000-000000000009";
const OLD_BINDING = "40000000-0000-4000-8000-000000000009";
const NEW_BINDING = "40000000-0000-4000-8000-000000000010";

/**
 * A folder already bound to OTHER_MACHINE, exactly as a first `cuna <agent>`
 * run leaves it. Returns the digest the policy authority computes for the
 * folder so the record matches what `synchronizeWorkspace` re-derives.
 */
async function seedBoundFolder(project) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(project, "main.js"), "console.log(1);\n");
  const { inspectWorkspaceSyncPolicy, computeWorkspaceManifestRoot } = await import("../dist/sync/workspace-sync-product-service.js");
  const { persistWorkspaceBinding } = await import("../dist/workspace/binding-store.js");
  const capabilities = conservativeFilesystemCapabilities("windows");
  const policy = await inspectWorkspaceSyncPolicy({ localRoot: project, filesystemCapabilities: capabilities });
  const manifestRoot = await computeWorkspaceManifestRoot({ localRoot: project, filesystemCapabilities: capabilities });
  const createdAt = "2026-09-01T10:00:00.000Z";
  const record = await persistWorkspaceBinding({
    root: project,
    binding: {
      profileId: "default",
      userId: USER,
      workspaceId: WORKSPACE,
      bindingId: OLD_BINDING,
      projectId: PROJECT,
      localInstanceId: LOCAL_INSTANCE,
      machineId: OTHER_MACHINE,
      remoteRoot: `/workspace/projects/${PROJECT}`,
      policyDigest: policy.exclusionPolicyDigest,
      generation: 3,
      bindingCreatedAt: createdAt,
      bindingUpdatedAt: createdAt,
    },
    expected: null,
  });
  return { record, policyDigest: policy.exclusionPolicyDigest, manifestRoot };
}

async function readBoundRecord(project) {
  const { loadWorkspaceBindingIntent } = await import("../dist/workspace/binding-store.js");
  const loaded = await loadWorkspaceBindingIntent({ startPath: project, profileId: "default", userId: USER, workspaceId: WORKSPACE });
  return loaded.record;
}

function remoteNotFound() {
  return new CunaError({
    code: "cuna.remote.not_found",
    message: "The requested Cuna resource or operation was not found.",
    exitCode: EXIT_CODES.remote,
    details: { http_status: 404, reason: "resource_not_found" },
  });
}

function serviceUnavailable() {
  return new CunaError({
    code: "cuna.network.service_unavailable",
    message: "The Cuna service is temporarily unavailable.",
    exitCode: EXIT_CODES.network,
    retryable: true,
    details: { http_status: 503 },
  });
}

// PRD-PM-008 E14-D1. The folder is the project; a Machine is disposable. When
// the Machine a folder is bound to no longer exists (the read answers 404
// resource_not_found), `cuna <agent> --machine other` must rebind the folder to
// the selected Machine through the same create path a first bind uses, keep
// the project identity, bump the local record, and say so in one line.
test("E14-D1: a bound Machine that no longer exists rebinds the folder to the selected Machine", async (t) => {
  const { project, state } = await roots(t);
  const seeded = await seedBoundFolder(project);
  const reads = [];
  const creates = [];
  const notices = [];
  const client = {
    async getMachine(id) {
      reads.push(id);
      throw remoteNotFound();
    },
    async createWorkspaceBinding(input, key) {
      creates.push(structuredClone({ input, key }));
      return {
        bindingId: NEW_BINDING,
        workspaceId: WORKSPACE,
        projectId: input.projectId,
        localInstanceId: input.localInstanceId,
        machineId: input.machineId,
        remoteRoot: `/workspace/projects/${input.projectId}`,
        exclusionPolicyDigest: input.exclusionPolicyDigest,
        activeGeneration: 1,
        activeManifestRoot: seeded.manifestRoot,
        bindingEpoch: 1,
        minimumReader: 1,
        minimumWriter: 2,
        createdAt: "2026-09-02T09:00:00.000Z",
        updatedAt: "2026-09-02T09:00:00.000Z",
      };
    },
    async getWorkspaceBinding() { throw new Error("the previous binding must not be read: its Machine is gone"); },
  };
  const result = await effects(client, state, { onNotice: (line) => notices.push(line) }).synchronizeWorkspace({
    machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal,
  });

  // The bound Machine is read for the decision; the selected one only for its
  // display name in the notice, which falls back to the id when unreadable.
  assert.deepEqual(reads, [OTHER_MACHINE, MACHINE]);
  assert.equal(creates.length, 1, "one binding is minted through the create path");
  assert.equal(creates[0].input.projectId, PROJECT, "the project identity is kept");
  assert.equal(creates[0].input.localInstanceId, LOCAL_INSTANCE);
  assert.equal(creates[0].input.machineId, MACHINE, "the selected Machine is the new owner");
  assert.equal(creates[0].input.exclusionPolicyDigest, seeded.policyDigest);
  assert.match(creates[0].key, /^cuna-workspace-binding-v2-[0-9a-f]{64}$/u);
  assert.deepEqual(result, { bindingId: NEW_BINDING, workspaceIdentity: NEW_BINDING, generation: 1, remoteCwd: `/workspace/projects/${PROJECT}` });

  const record = await readBoundRecord(project);
  assert.equal(record.machineId, MACHINE, "the local record names the new Machine");
  assert.equal(record.bindingId, NEW_BINDING);
  assert.equal(record.projectId, PROJECT);
  assert.equal(record.remoteRoot, `/workspace/projects/${PROJECT}`);
  assert.equal(record.recordRevision, seeded.record.recordRevision + 1, "the local record is bumped, not replaced");
  assert.equal(record.generation, 1);

  assert.deepEqual(notices, [`Rebound this folder to ${MACHINE} · the previous Machine no longer exists`]);
});

test("E14-D1: a bound Machine the server still holds as deleted is treated as absent", async (t) => {
  const { project, state } = await roots(t);
  const seeded = await seedBoundFolder(project);
  const creates = [];
  const notices = [];
  const client = {
    async getMachine(id) {
      return { id, name: "claude-stack-1", state: "deleted" };
    },
    async createWorkspaceBinding(input) {
      creates.push(input.machineId);
      return {
        bindingId: NEW_BINDING, workspaceId: WORKSPACE, projectId: input.projectId, localInstanceId: input.localInstanceId,
        machineId: input.machineId, remoteRoot: `/workspace/projects/${input.projectId}`, exclusionPolicyDigest: input.exclusionPolicyDigest,
        activeGeneration: 1, activeManifestRoot: seeded.manifestRoot, bindingEpoch: 1, minimumReader: 1, minimumWriter: 2,
        createdAt: "2026-09-02T09:00:00.000Z", updatedAt: "2026-09-02T09:00:00.000Z",
      };
    },
  };
  await effects(client, state, { onNotice: (line) => notices.push(line) }).synchronizeWorkspace({
    machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal,
  });
  assert.deepEqual(creates, [MACHINE]);
  assert.equal((await readBoundRecord(project)).machineId, MACHINE);
  assert.equal(notices.length, 1);
});

// Negative control for the rebind: the bound Machine exists and merely differs
// from --machine. That is the typed refusal, naming both Machines and the way
// out; nothing is created, nothing is rewritten, nothing is announced.
test("E14-D1 control: a bound Machine that still exists but differs from --machine is refused without a rebind", async (t) => {
  const { project, state } = await roots(t);
  const seeded = await seedBoundFolder(project);
  const machines = new Map([
    [OTHER_MACHINE, { id: OTHER_MACHINE, name: "claude-stack-1", state: "running" }],
    [MACHINE, { id: MACHINE, name: "claude-stack-3", state: "running" }],
  ]);
  let creates = 0;
  const notices = [];
  const client = {
    async getMachine(id) { return machines.get(id); },
    async createWorkspaceBinding() { creates += 1; throw new Error("a create is a rebind; there must be none"); },
    async getWorkspaceBinding() { throw new Error("the refusal must come before any binding read"); },
  };
  await assert.rejects(
    effects(client, state, { onNotice: (line) => notices.push(line) }).synchronizeWorkspace({
      machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.code, "cuna.journey.workspace_binding_conflict");
      assert.match(error.message, /claude-stack-1/u, "the bound Machine is named");
      assert.match(error.message, /claude-stack-3/u, "the selected Machine is named");
      assert.match(error.hint, /--machine claude-stack-1/u, "the way out names the bound Machine");
      assert.match(error.hint, /\.cuna[\\/]workspace\.json/u, "no unbind command exists, so the file is named");
      assert.equal(error.details.bound_machine_id, OTHER_MACHINE);
      assert.equal(error.details.selected_machine_id, MACHINE);
      return true;
    },
  );
  assert.equal(creates, 0);
  assert.deepEqual(notices, []);
  const record = await readBoundRecord(project);
  assert.equal(record.integrityDigest, seeded.record.integrityDigest, "the local record is untouched");
});

// Transient control: a 503 on the Machine read proves nothing about absence.
// It stays the retryable error it already is; no rebind, no request, no rewrite.
test("E14-D1 control: a transient failure reading the bound Machine stays retryable and rebinds nothing", async (t) => {
  const { project, state } = await roots(t);
  const seeded = await seedBoundFolder(project);
  let creates = 0;
  const notices = [];
  const client = {
    async getMachine() { throw serviceUnavailable(); },
    async createWorkspaceBinding() { creates += 1; throw new Error("unexpected create"); },
    async getWorkspaceBinding() { throw new Error("unexpected binding read"); },
  };
  await assert.rejects(
    effects(client, state, { onNotice: (line) => notices.push(line) }).synchronizeWorkspace({
      machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal,
    }),
    (error) => error instanceof CunaError && error.retryable === true && error.code === "cuna.network.service_unavailable",
  );
  assert.equal(creates, 0);
  assert.deepEqual(notices, []);
  assert.equal((await readBoundRecord(project)).integrityDigest, seeded.record.integrityDigest);
});

test("workspace create retry reuses the exact durable identity tuple and idempotency key", async (t) => {
  const { project, state } = await roots(t);
  const creates = [];
  const client = {
    async createWorkspaceBinding(input, key) {
      creates.push(structuredClone({ input, key }));
      throw new Error("response lost");
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      effects(client, state).synchronizeWorkspace({ machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal }),
      /response lost/u,
    );
  }
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1], creates[0]);
  assert.match(creates[0].input.projectId, /^[0-9a-f-]{36}$/u);
  assert.match(creates[0].input.localInstanceId, /^[0-9a-f-]{36}$/u);
  assert.match(creates[0].key, /^cuna-workspace-binding-v2-[0-9a-f]{64}$/u);
});

test("workspace create idempotency changes when the request body selects another machine", async (t) => {
  const { project, state } = await roots(t);
  const creates = [];
  const client = {
    async createWorkspaceBinding(input, key) {
      creates.push(structuredClone({ input, key }));
      throw new Error("stop after create boundary");
    },
  };
  for (const machineId of [MACHINE, OTHER_MACHINE]) {
    await assert.rejects(
      effects(client, state).synchronizeWorkspace({ machineId, localPath: project, syncMode: "enabled", signal: new AbortController().signal }),
      /stop after create boundary/u,
    );
  }
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].key, creates[1].key);
  assert.equal(creates[0].input.machineId, MACHINE);
  assert.equal(creates[1].input.machineId, OTHER_MACHINE);
});

test("--no-sync without a committed local binding performs no producer mutation", async (t) => {
  const { project, state } = await roots(t);
  let creates = 0;
  const client = { async createWorkspaceBinding() { creates += 1; throw new Error("unexpected"); } };
  await assert.rejects(
    effects(client, state).synchronizeWorkspace({ machineId: MACHINE, localPath: project, syncMode: "disabled", signal: new AbortController().signal }),
    (error) => error.code === "cuna.journey.workspace_binding_required",
  );
  assert.equal(creates, 0);
});

// A generation is a witness to workspace content. Committing one for content
// the server already has is not a wasted round trip, it is an identity change:
// `workspaceGeneration` is compared in `isExactSessionKey`, so the previous
// AgentSession stops being exact and the journey creates a sibling with a new
// process epoch. Measured in production 2026-08-30 on binding dab40ec9:
// generations 1, 2 and 3 all carried manifest root d4313d11..., entry_count 1,
// content_bytes 28, with no file touched between runs — and two runs against
// one Machine left two live OpenCode processes where the owner expected to
// reconnect to one.
test("an unchanged workspace reuses its committed generation instead of committing another", async (t) => {
  const { project, state } = await roots(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(project, "main.js"), "console.log(1);\n");

  const { computeWorkspaceManifestRoot } = await import(
    "../dist/sync/workspace-sync-product-service.js"
  );
  const manifestRoot = await computeWorkspaceManifestRoot({
    localRoot: project,
    filesystemCapabilities: conservativeFilesystemCapabilities("windows"),
  });

  const binding = {
    bindingId: "40000000-0000-4000-8000-000000000001",
    projectId: "50000000-0000-4000-8000-000000000001",
    localInstanceId: "60000000-0000-4000-8000-000000000001",
    remoteRoot: "/workspace/projects/p",
    exclusionPolicyDigest: undefined,
    activeGeneration: 7,
    activeManifestRoot: manifestRoot,
  };
  const client = {
    async createWorkspaceBinding(input) {
      binding.exclusionPolicyDigest = input.exclusionPolicyDigest;
      return { ...binding, exclusionPolicyDigest: input.exclusionPolicyDigest };
    },
    async getWorkspaceBinding() {
      return { ...binding };
    },
  };

  // The transport throws on any request, so reaching the network at all fails
  // this test rather than silently passing on a slower path.
  const result = await effects(client, state).synchronizeWorkspace({
    machineId: MACHINE,
    localPath: project,
    syncMode: "enabled",
    signal: new AbortController().signal,
  });

  assert.equal(result.generation, 7, "the committed generation must be reused, not advanced");
  assert.equal(result.bindingId, binding.bindingId);
});

// Negative control: the skip must be keyed on the manifest, not on nothing at
// all. With a different remote manifest root the journey must go to the network
// — here that surfaces as the transport's own refusal, which is proof it tried.
test("a changed workspace still synchronizes rather than reusing a stale generation", async (t) => {
  const { project, state } = await roots(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(project, "main.js"), "console.log(1);\n");

  const binding = {
    bindingId: "40000000-0000-4000-8000-000000000002",
    projectId: "50000000-0000-4000-8000-000000000002",
    localInstanceId: "60000000-0000-4000-8000-000000000002",
    remoteRoot: "/workspace/projects/p",
    exclusionPolicyDigest: undefined,
    activeGeneration: 7,
    activeManifestRoot: "0".repeat(64),
  };
  const client = {
    async createWorkspaceBinding(input) {
      binding.exclusionPolicyDigest = input.exclusionPolicyDigest;
      return { ...binding, exclusionPolicyDigest: input.exclusionPolicyDigest };
    },
    async getWorkspaceBinding() {
      return { ...binding };
    },
  };

  await assert.rejects(
    effects(client, state).synchronizeWorkspace({
      machineId: MACHINE,
      localPath: project,
      syncMode: "enabled",
      signal: new AbortController().signal,
    }),
    "a differing manifest must reach the transport, not silently reuse generation 7",
  );
});
