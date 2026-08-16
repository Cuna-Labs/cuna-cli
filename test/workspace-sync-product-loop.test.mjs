import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CunaError } from "../dist/core/errors.js";
import { createHttpTransport } from "../dist/api/http.js";
import { createWorkspaceManifest, compileExclusionPolicy } from "../dist/workspace/index.js";
import {
  FileWorkspaceSyncCheckpointStore,
  WorkspaceSyncCoordinator,
  createFilesystemChunkSource,
  createWorkspaceSyncClient,
} from "../dist/sync/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const workspaceBindingId = "55555555-5555-4555-8555-555555555555";
const machineId = "22222222-2222-4222-8222-222222222222";
const syncId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const capabilities = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
]);
const filesystem = Object.freeze({
  platform: "linux",
  caseSensitive: true,
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuna-workspace-loop-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return directory;
}

async function fixture(t, fileCount = 3, chunkBytes = 4) {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(root, "src", `file-${index}.txt`), `content-${index}-abcdefghijk`);
  }
  const manifest = await createWorkspaceManifest({
    root,
    policy: compileExclusionPolicy([], filesystem),
    capabilities: filesystem,
    limits: { chunkBytes },
  });
  return { root, manifest, source: await createFilesystemChunkSource(root, manifest) };
}

function envelope(data) {
  return Object.freeze({ request_id: requestId, selected_protocol: 2, capabilities, data });
}

function networkFailure() {
  return new CunaError({
    code: "cuna.network.failed",
    message: "The Runa request outcome is unknown.",
    exitCode: 5,
  });
}

class FakeWorkspaceService {
  constructor(options = {}) {
    this.options = options;
    this.stored = new Set();
    this.manifestDigests = new Set();
    this.keys = new Map();
    this.beginApplied = false;
    this.commitApplied = false;
    this.commitGeneration = 1;
    this.activeUploads = 0;
    this.peakUploads = 0;
    this.chunkReads = 0;
    this.changeCalls = 0;
  }

  stableKey(operation, key) {
    const prior = this.keys.get(operation);
    if (prior === undefined) this.keys.set(operation, key);
    else assert.equal(key, prior, `idempotency identity changed for ${operation}`);
  }

  async begin(observedWorkspace, request, key) {
    assert.equal(observedWorkspace, workspaceId);
    assert.equal(request.machine_id, machineId);
    this.stableKey("begin", key);
    this.beginApplied = true;
    if (this.options.loseBeginOnce) {
      this.options.loseBeginOnce = false;
      throw networkFailure();
    }
    return envelope(session(request));
  }

  async manifest(observedSync, page, key) {
    assert.equal(observedSync, syncId);
    this.stableKey(`manifest:${page.page_index}`, key);
    for (const entry of page.entries) for (const chunk of entry.chunks) this.manifestDigests.add(chunk.digest);
    const missing = [...this.manifestDigests].filter((digest) => !this.stored.has(digest));
    if (this.options.unexpectedMissingOnce) {
      this.options.unexpectedMissingOnce = false;
      missing.push("f".repeat(64));
    }
    return envelope({
      sync: session({ machine_id: machineId, base_generation: 0, exclusion_policy_digest: page.policy ?? this.options.policyDigest }),
      page_index: page.page_index,
      page_digest: "a".repeat(64),
      missing_digests: missing,
    });
  }

  async chunk(observedSync, digest, bytes, key) {
    assert.equal(observedSync, syncId);
    this.stableKey(`chunk:${digest}`, key);
    this.activeUploads += 1;
    this.peakUploads = Math.max(this.peakUploads, this.activeUploads);
    this.chunkReads += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      this.stored.add(digest);
      if (this.options.loseChunkOnce === digest) {
        this.options.loseChunkOnce = undefined;
        throw networkFailure();
      }
      return envelope({ selected_protocol: 2, digest, byte_length: bytes.byteLength, stored: true });
    } finally {
      this.activeUploads -= 1;
    }
  }

  async commit(observedSync, request, key) {
    assert.equal(observedSync, syncId);
    this.stableKey("commit", key);
    assert.deepEqual([...this.manifestDigests].filter((digest) => !this.stored.has(digest)), []);
    if (!this.commitApplied) {
      this.commitApplied = true;
      this.commitRoot = request.manifest_root;
    } else {
      assert.equal(request.manifest_root, this.commitRoot);
    }
    if (this.options.conflictCommit) {
      throw new CunaError({
        code: "cuna.remote.conflict",
        message: "Generation conflict.",
        exitCode: 6,
        details: { reason: "workspace_sync_generation_conflict" },
      });
    }
    if (this.options.loseCommitOnce) {
      this.options.loseCommitOnce = false;
      throw networkFailure();
    }
    return envelope({
      selected_protocol: 2,
      state: "committed",
      generation: this.commitGeneration,
      manifest_root: request.manifest_root,
      committed_at: "2026-08-09T00:00:00.000Z",
      minimum_reader: 1,
      minimum_writer: 1,
    });
  }

  async changes(_sync, options) {
    this.changeCalls += 1;
    if (options.cursor === undefined) {
      return envelope({ selected_protocol: 2, items: [], next_cursor: "page-two" });
    }
    assert.equal(options.cursor, "page-two");
    return envelope({ selected_protocol: 2, items: [], next_cursor: null });
  }

  async reconcile(observedWorkspace, request, key) {
    assert.equal(observedWorkspace, workspaceId);
    this.stableKey("reconcile", key);
    return envelope({
      selected_protocol: 2,
      status: request.manifest_root === this.commitRoot ? "converged" : "reconciliation_required",
      active_generation: this.commitApplied ? 1 : 0,
      active_manifest_root: this.commitRoot ?? "0".repeat(64),
      exclusion_policy_digest: request.exclusion_policy_digest,
    });
  }
}

function session(request) {
  return {
    id: syncId,
    workspace_id: workspaceId,
    machine_id: request.machine_id,
    base_generation: request.base_generation,
    exclusion_policy_digest: request.exclusion_policy_digest,
    selected_protocol: 2,
    capabilities,
    state: "staging",
    manifest_entry_count: 0,
    manifest_encoded_bytes: 0,
    content_bytes: 0,
    expires_at: "2026-08-10T00:00:00.000Z",
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

test("public sync client emits all frozen routes, verifies downloaded bytes, and keeps stable idempotency", async () => {
  const requests = [];
  const policy = "a".repeat(64);
  const root = "b".repeat(64);
  const transport = {
    async request(request) {
      requests.push(request);
      if (request.path.endsWith("/sync-sessions")) return envelope(session(request.body));
      if (request.path.endsWith("/manifests")) return envelope({ sync: session({ machine_id: machineId, base_generation: 0, exclusion_policy_digest: policy }), page_index: 0, page_digest: "c".repeat(64), missing_digests: [] });
      if (request.method === "PUT") return envelope({ selected_protocol: 2, digest: request.path.split("/").at(-1), byte_length: request.body.byteLength, stored: true });
      if (request.method === "GET" && request.path.includes("/chunks/")) return envelope({ selected_protocol: 2, digest: request.path.split("/").at(-1), byte_length: 6, minimum_reader: 1, content_base64: "aGVsbG8K" });
      if (request.path.endsWith("/commit")) return envelope({ selected_protocol: 2, state: "committed", generation: 1, manifest_root: root, committed_at: "2026-08-09T00:00:00.000Z", minimum_reader: 1, minimum_writer: 1 });
      if (request.path.endsWith("/changes")) return envelope({ selected_protocol: 2, items: [], next_cursor: null });
      return envelope({ selected_protocol: 2, status: "converged", active_generation: 1, active_manifest_root: root, exclusion_policy_digest: policy });
    },
  };
  const client = createWorkspaceSyncClient(transport);
  const key = "stable-idempotency-key-1234";
  await client.begin(workspaceId, { workspace_binding_id: workspaceBindingId, machine_id: machineId, base_generation: 0, exclusion_policy_digest: policy, protocol: { minimum: 1, maximum: 2 }, minimum_reader: 1, minimum_writer: 1 }, key);
  await client.manifest(syncId, { page_index: 0, is_last: true, minimum_reader: 1, minimum_writer: 1, entries: [] }, key);
  const bytes = new TextEncoder().encode("hello\n");
  const chunkDigest = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
  await client.chunk(syncId, chunkDigest, bytes, key);
  const downloaded = await client.downloadChunk(syncId, chunkDigest, 2);
  assert.deepEqual(Buffer.from(downloaded.data.content_base64, "base64"), Buffer.from(bytes));
  await client.commit(syncId, { expected_generation: 0, exclusion_policy_digest: policy, manifest_root: root, minimum_reader: 1, minimum_writer: 1 }, key);
  await client.changes(syncId, { readerVersion: 2, cursor: "opaque", limit: 10 });
  await client.reconcile(workspaceId, { workspace_binding_id: workspaceBindingId, machine_id: machineId, observed_generation: 1, exclusion_policy_digest: policy, manifest_root: root, protocol: { minimum: 1, maximum: 2 } }, key);
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ["POST", `/v1/workspaces/${workspaceId}/sync-sessions`],
    ["POST", `/v1/workspace-sync/${syncId}/manifests`],
    ["PUT", `/v1/workspace-sync/${syncId}/chunks/${chunkDigest}`],
    ["GET", `/v1/workspace-sync/${syncId}/chunks/${chunkDigest}`],
    ["POST", `/v1/workspace-sync/${syncId}/commit`],
    ["GET", `/v1/workspace-sync/${syncId}/changes`],
    ["POST", `/v1/workspaces/${workspaceId}/reconcile`],
  ]);
  assert.equal(requests[2].contentType, "application/octet-stream");
  assert.equal(requests[0].body.workspace_binding_id, workspaceBindingId);
  assert.equal(requests[6].body.workspace_binding_id, workspaceBindingId);
  assert.equal(requests[5].query.reader_version, "2");
  assert.equal(requests[3].query.reader_version, "2");
  assert.ok(requests.filter((request) => request.method !== "GET").every((request) => request.idempotencyKey === key));
  await assert.rejects(
    client.begin(workspaceId, { workspace_binding_id: workspaceId, machine_id: machineId, base_generation: 0, exclusion_policy_digest: policy, protocol: { minimum: 1, maximum: 2 }, minimum_reader: 1, minimum_writer: 1 }, key),
    (error) => error.code === "cuna.workspace_sync.invalid_request" && error.details.reason === "workspace_binding_id_domain",
  );
  assert.equal(requests.length, 7);
});

test("downloaded workspace chunks reject non-canonical or digest-mismatched content", async () => {
  const client = createWorkspaceSyncClient({
    async request() {
      return envelope({
        selected_protocol: 2,
        digest: "0".repeat(64),
        byte_length: 6,
        minimum_reader: 1,
        content_base64: "aGVsbG8K",
      });
    },
  });
  await assert.rejects(
    client.downloadChunk(syncId, "0".repeat(64), 2),
    (error) => error.code === "cuna.workspace_sync.contract_mismatch" && error.details.reason === "chunk_content_mismatch",
  );
});

test("CLI manifest and binary HTTP transport match the frozen cross-runtime golden vector", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "café.ts"), "hello\n");
  const manifest = await createWorkspaceManifest({
    root,
    policy: compileExclusionPolicy([], filesystem),
    capabilities: filesystem,
  });
  assert.equal(manifest.manifestRoot, "49ed1e18796cbc7209b2e92e727aa4a0e687050ba6fffb7cb6c432745c8de710");
  assert.equal(manifest.entries.find((entry) => entry.kind === "file").chunks[0].digest, "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");

  let observed;
  const bytes = new TextEncoder().encode("hello\n");
  const client = createWorkspaceSyncClient(createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: `cuna_sk_${"a".repeat(43)}`,
    async fetch(_url, init) {
      observed = init;
      return new Response(JSON.stringify(envelope({
        selected_protocol: 2,
        digest: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
        byte_length: bytes.byteLength,
        stored: true,
      })), { status: 200, headers: { "content-type": "application/json" } });
    },
  }));
  await client.chunk(syncId, "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", bytes, "stable-idempotency-key-1234");
  assert.equal(observed.method, "PUT");
  assert.equal(observed.headers["Content-Type"], "application/octet-stream");
  assert.equal(observed.headers["Content-Length"], String(bytes.byteLength));
  assert.deepEqual(new Uint8Array(observed.body), bytes);
});

test("ambiguous begin and commit outcomes resume after process restart with one authority effect", async (t) => {
  const { manifest, source } = await fixture(t, 4, 5);
  const state = await temporaryDirectory(t);
  const store = new FileWorkspaceSyncCheckpointStore(state);
  const service = new FakeWorkspaceService({ loseBeginOnce: true, policyDigest: manifest.policyDigest });
  const first = new WorkspaceSyncCoordinator({ client: service, checkpointStore: store, chunkSource: source, maximumAttempts: 1 });
  await assert.rejects(first.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest }), (error) => error.code === "cuna.network.failed");
  assert.equal((await store.load()).phase, "begin_pending");
  service.options.loseCommitOnce = true;
  const second = new WorkspaceSyncCoordinator({ client: service, checkpointStore: store, chunkSource: source, maximumAttempts: 1 });
  await assert.rejects(second.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest }), (error) => error.code === "cuna.network.failed");
  assert.equal((await store.load()).phase, "commit_pending");
  const third = new WorkspaceSyncCoordinator({ client: service, checkpointStore: store, chunkSource: source, maximumAttempts: 2, sleep: async () => undefined });
  const result = await third.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest });
  assert.equal(result.manifest_root, manifest.manifestRoot);
  assert.equal((await store.load()).phase, "committed");
  assert.equal(service.beginApplied, true);
  assert.equal(service.commitApplied, true);
  assert.equal(service.keys.size, 2 + service.manifestDigests.size + 1);
});

test("missing chunks use bounded backpressure and malicious missing-digest claims fail before content reads", async (t) => {
  const { manifest, source } = await fixture(t, 6, 3);
  const state = await temporaryDirectory(t);
  const service = new FakeWorkspaceService({ policyDigest: manifest.policyDigest });
  const coordinator = new WorkspaceSyncCoordinator({ client: service, checkpointStore: new FileWorkspaceSyncCheckpointStore(state), chunkSource: source, maximumConcurrentUploads: 2, sleep: async () => undefined });
  await coordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest });
  assert.ok(service.peakUploads <= 2);
  assert.equal(service.stored.size, service.manifestDigests.size);

  const hostileState = await temporaryDirectory(t);
  const hostile = new FakeWorkspaceService({ policyDigest: manifest.policyDigest, unexpectedMissingOnce: true });
  let reads = 0;
  const guardedSource = { async read(...args) { reads += 1; return source.read(...args); } };
  const hostileCoordinator = new WorkspaceSyncCoordinator({ client: hostile, checkpointStore: new FileWorkspaceSyncCheckpointStore(hostileState), chunkSource: guardedSource, maximumAttempts: 1 });
  await assert.rejects(hostileCoordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest }), (error) => error.code === "cuna.workspace_sync.contract_mismatch");
  assert.equal(reads, 0);
});

test("generation conflict persists fail-closed and checkpoint/error evidence contains no local path", async (t) => {
  const { root, manifest, source } = await fixture(t, 1, 5);
  const state = await temporaryDirectory(t);
  const service = new FakeWorkspaceService({ policyDigest: manifest.policyDigest, conflictCommit: true });
  const coordinator = new WorkspaceSyncCoordinator({ client: service, checkpointStore: new FileWorkspaceSyncCheckpointStore(state), chunkSource: source, maximumAttempts: 1 });
  await assert.rejects(coordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest }), (error) => error.code === "cuna.remote.conflict" && !error.message.includes(root));
  assert.equal((await new FileWorkspaceSyncCheckpointStore(state).load()).phase, "conflicted");
  const persisted = await readFile(join(state, "workspace-sync.checkpoint.json"), "utf8");
  assert.equal(persisted.includes(root), false);
  const calls = service.keys.size;
  await assert.rejects(coordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest }), (error) => error.code === "cuna.workspace_sync.conflict");
  assert.equal(service.keys.size, calls);
});

test("change pages apply serially with cursor progress before reconcile establishes convergence", async (t) => {
  const { manifest, source } = await fixture(t, 1, 8);
  const state = await temporaryDirectory(t);
  const service = new FakeWorkspaceService({ policyDigest: manifest.policyDigest });
  const coordinator = new WorkspaceSyncCoordinator({ client: service, checkpointStore: new FileWorkspaceSyncCheckpointStore(state), chunkSource: source, sleep: async () => undefined });
  await coordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest });
  let active = 0;
  let peak = 0;
  const cursor = await coordinator.consumeChanges({
    syncId,
    async onPage() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    },
  });
  assert.equal(cursor, null);
  assert.equal(service.changeCalls, 2);
  assert.equal(peak, 1);
  const reconciliation = await coordinator.reconcile({ workspaceId, workspaceBindingId, machineId, observedGeneration: 1, exclusionPolicyDigest: manifest.policyDigest, manifestRoot: manifest.manifestRoot });
  assert.equal(reconciliation.status, "converged");
});
