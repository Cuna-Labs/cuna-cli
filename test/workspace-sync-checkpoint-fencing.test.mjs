import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileWorkspaceSyncCheckpointStore,
  WorkspaceSyncCoordinator,
} from "../dist/sync/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const workspaceBindingId = "55555555-5555-4555-8555-555555555555";
const machineId = "22222222-2222-4222-8222-222222222222";
const syncId = "33333333-3333-4333-8333-333333333333";
const policyDigest = "a".repeat(64);
const manifestRoot = "b".repeat(64);
const capabilities = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
]);
const manifest = Object.freeze({
  schemaVersion: 2,
  minimumReaderVersion: 1,
  minimumWriterVersion: 2,
  policyDigest,
  manifestRoot,
  entryCount: 0,
  totalBytes: 0,
  excludedCounts: Object.freeze({}),
  entries: Object.freeze([]),
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "runa-sync-fencing-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function session() {
  return {
    id: syncId,
    workspace_id: workspaceId,
    machine_id: machineId,
    base_generation: 0,
    exclusion_policy_digest: policyDigest,
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

function envelope(data) {
  return {
    request_id: "44444444-4444-4444-8444-444444444444",
    selected_protocol: 2,
    capabilities,
    data,
  };
}

function client(beginGate, calls) {
  return {
    async begin() {
      calls.push("begin");
      if (beginGate !== undefined) await beginGate.promise;
      return envelope(session());
    },
    async manifest(_observedSync, request) {
      calls.push("manifest");
      return envelope({ sync: session(), page_index: request.page_index, page_digest: "c".repeat(64), missing_digests: [] });
    },
    async chunk() {
      throw new Error("An empty manifest cannot request chunks.");
    },
    async commit() {
      calls.push("commit");
      return envelope({
        selected_protocol: 2,
        state: "committed",
        generation: 1,
        manifest_root: manifestRoot,
        committed_at: "2026-08-09T12:00:00.000Z",
        minimum_reader: 1,
        minimum_writer: 1,
      });
    },
    async changes() {
      throw new Error("Changes are outside this test.");
    },
    async reconcile() {
      throw new Error("Reconciliation is outside this test.");
    },
  };
}

function synchronize(coordinator) {
  return coordinator.synchronize({ workspaceId, workspaceBindingId, machineId, baseGeneration: 0, manifest });
}

function checkpoint(phase, updatedAt) {
  const committed = phase === "committed";
  return Object.freeze({
    schema_version: 2,
    workspace_id: workspaceId,
    workspace_binding_id: workspaceBindingId,
    machine_id: machineId,
    base_generation: 0,
    exclusion_policy_digest: policyDigest,
    manifest_root: manifestRoot,
    phase,
    sync_id: syncId,
    selected_protocol: 2,
    committed_generation: committed ? 1 : null,
    updated_at: updatedAt,
  });
}

test("two process-style coordinators admit one writer and preserve its committed checkpoint", async (t) => {
  const directory = await temporaryDirectory(t);
  const gate = deferred();
  const firstCalls = [];
  const secondCalls = [];
  const first = new WorkspaceSyncCoordinator({
    client: client(gate, firstCalls),
    checkpointStore: new FileWorkspaceSyncCheckpointStore(directory),
    chunkSource: { async read() { throw new Error("No chunks expected."); } },
    maximumAttempts: 1,
  });
  const secondStore = new FileWorkspaceSyncCheckpointStore(directory);
  const second = new WorkspaceSyncCoordinator({
    client: client(undefined, secondCalls),
    checkpointStore: secondStore,
    chunkSource: { async read() { throw new Error("No chunks expected."); } },
    maximumAttempts: 1,
  });

  const firstRun = synchronize(first);
  while (firstCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    synchronize(second),
    (error) => error.code === "cuna.workspace_sync.checkpoint_busy" && error.retryable === true,
  );
  assert.deepEqual(secondCalls, []);

  gate.resolve();
  const receipt = await firstRun;
  assert.equal(receipt.generation, 1);
  assert.equal((await secondStore.load()).phase, "committed");

  const replay = await synchronize(second);
  assert.equal(replay.generation, 1);
  assert.deepEqual(secondCalls, []);
  const document = JSON.parse(await readFile(join(directory, "workspace-sync.checkpoint.json"), "utf8"));
  assert.equal(document.phase, "committed");
  assert.equal(document.storage_revision, 4);
  assert.equal(document.fence, 1);
});

test("causal negative control fences a stale transaction after a newer lease commits", async (t) => {
  const directory = await temporaryDirectory(t);
  const firstStore = new FileWorkspaceSyncCheckpointStore(directory);
  let staleTransaction;
  await firstStore.withLease(async (transaction) => {
    staleTransaction = transaction;
    assert.equal(await transaction.load(), undefined);
    await transaction.save(checkpoint("staging", "2026-08-09T00:00:00.000Z"));
  });

  const secondStore = new FileWorkspaceSyncCheckpointStore(directory);
  await secondStore.withLease(async (transaction) => {
    assert.equal((await transaction.load()).phase, "staging");
    await transaction.save(checkpoint("committed", "2026-08-09T00:01:00.000Z"));
  });

  await assert.rejects(
    staleTransaction.save(checkpoint("conflicted", "2026-08-09T00:02:00.000Z")),
    (error) => error.code === "cuna.workspace_sync.checkpoint_lease_lost",
  );
  assert.equal((await firstStore.load()).phase, "committed");
  const document = JSON.parse(await readFile(join(directory, "workspace-sync.checkpoint.json"), "utf8"));
  assert.equal(document.phase, "committed");
  assert.equal(document.storage_revision, 2);
  assert.equal(document.fence, 2);
});

test("a pre-binding checkpoint is preserved but cannot authorize work under a guessed binding", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "workspace-sync.checkpoint.json");
  const legacy = {
    ...checkpoint("staging", "2026-08-09T00:00:00.000Z"),
    schema_version: 1,
    storage_revision: 1,
    fence: 1,
  };
  delete legacy.workspace_binding_id;
  const serialized = `${JSON.stringify(legacy)}\n`;
  await writeFile(path, serialized, { mode: 0o600 });

  const store = new FileWorkspaceSyncCheckpointStore(directory);
  await assert.rejects(
    store.load(),
    (error) => error.code === "cuna.workspace_sync.checkpoint_invalid",
  );
  assert.equal(await readFile(path, "utf8"), serialized);
});
