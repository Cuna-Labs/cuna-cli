import assert from "node:assert/strict";
import test from "node:test";

import {
  CUNA_TRANSFER_ROOT,
  FileTransferActions,
  FileTransferError,
} from "../dist/local-actions/file-transfers.js";

const BINDING = Object.freeze({
  workspaceBindingId: "11111111-1111-4111-8111-111111111111",
  workspaceBindingGeneration: 4,
});
const DIGEST = "a".repeat(64);
const SELECT_ARGS = Object.freeze({
  purpose: "attachment",
  accept: Object.freeze([{ extension: ".txt", mediaType: "text/plain" }]),
  multiple: true,
  maximumFiles: 2,
  maximumTotalBytes: 32,
});

class MemoryStore {
  supported = true;
  creates = [];
  verifies = [];
  saves = [];
  removals = [];
  failOnCreate = undefined;
  failSave = undefined;
  destinationPresent = false;

  async createSnapshot(input) {
    this.creates.push(input);
    if (this.failOnCreate === this.creates.length) throw new FileTransferError("source_changed");
    return Object.freeze({
      opaqueId: input.opaqueId,
      displayName: `file-${this.creates.length}.txt`,
      byteLength: 8,
      sha256: DIGEST,
      workspaceRelativeSnapshotPath: `${CUNA_TRANSFER_ROOT}/${input.binding.workspaceBindingId}/${input.opaqueId}`,
    });
  }
  async verifySnapshot(input) {
    this.verifies.push(input);
    return Object.freeze({
      opaqueId: input.opaqueId,
      displayName: "file.txt",
      byteLength: 8,
      sha256: input.expectedSha256,
      workspaceRelativeSnapshotPath: `${CUNA_TRANSFER_ROOT}/${input.binding.workspaceBindingId}/${input.opaqueId}`,
    });
  }
  async saveArtifact(input) {
    this.saves.push(input);
    if (this.failSave !== undefined) throw new FileTransferError(this.failSave);
    if (input.destinationPath === "") throw new FileTransferError("destination_required");
  }
  async destinationExists() { return this.destinationPresent; }
  async removeSnapshot(binding, opaqueId) {
    this.removals.push({ binding, opaqueId });
  }
}

function harness(overrides = {}) {
  const store = overrides.store ?? new MemoryStore();
  const calls = { select: 0, save: 0, confirm: 0, excluded: 0, artifact: 0 };
  const picker = {
    async selectFiles() { calls.select += 1; return overrides.selected ?? ["C:\\selected\\one.txt"]; },
    async selectSaveDestination() { calls.save += 1; return overrides.destination ?? "C:\\saved\\artifact.txt"; },
    async confirmOverwrite() { calls.confirm += 1; return overrides.overwrite ?? false; },
  };
  const actions = new FileTransferActions({
    platform: "win32",
    workspaceRoot: "C:\\workspace",
    picker,
    artifacts: {
      async resolve() {
        calls.artifact += 1;
        return overrides.artifact ?? {
          localCopyPath: "C:\\workspace\\artifact-copy",
          workspaceBindingId: BINDING.workspaceBindingId,
          workspaceBindingGeneration: BINDING.workspaceBindingGeneration,
        };
      },
    },
    isSyncExcluded: async () => { calls.excluded += 1; return overrides.excluded ?? false; },
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    windowsNativeStore: store,
  });
  return { actions, calls, store };
}

test("Windows without native no-follow/reparse primitives is unsupported before picker or filesystem access", async () => {
  let pickerCalls = 0;
  const actions = new FileTransferActions({
    platform: "win32",
    workspaceRoot: "C:\\workspace",
    picker: {
      async selectFiles() { pickerCalls += 1; return ["C:\\secret"]; },
      async selectSaveDestination() { pickerCalls += 1; return null; },
      async confirmOverwrite() { pickerCalls += 1; return false; },
    },
    artifacts: { async resolve() { throw new Error("must not run"); } },
    isSyncExcluded: () => false,
  });
  assert.equal(actions.supported, false);
  await assert.rejects(actions.selectFiles(SELECT_ARGS, BINDING),
    (error) => error instanceof FileTransferError && error.code === "unsupported");
  assert.equal(pickerCalls, 0);
});

test("effective exclusions fail before human selection", async () => {
  const { actions, calls, store } = harness({ excluded: true });
  await assert.rejects(actions.selectFiles(SELECT_ARGS, BINDING),
    (error) => error instanceof FileTransferError && error.code === "snapshot_path_excluded");
  assert.deepEqual(calls, { select: 0, save: 0, confirm: 0, excluded: 1, artifact: 0 });
  assert.equal(store.creates.length, 0);
});

test("selection publishes immutable opaque snapshots without exposing local absolute paths", async () => {
  const { actions } = harness({ selected: ["C:\\private\\alpha.txt", "C:\\private\\beta.txt"] });
  const receipt = await actions.selectFiles(SELECT_ARGS, BINDING);
  assert.equal(receipt.count, 2);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.files), true);
  assert.equal(Object.isFrozen(receipt.files[0]), true);
  assert.match(receipt.selectionId, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.files.every((file) => !file.workspaceRelativeSnapshotPath.includes("C:\\")), true);
  assert.equal(receipt.files.every((file) => file.workspaceRelativeSnapshotPath.startsWith(
    `${CUNA_TRANSFER_ROOT}/${BINDING.workspaceBindingId}/`)), true);
  assert.equal(JSON.stringify(receipt).includes("private"), false);
});

test("partial selection failure cleans every snapshot owned by the action", async () => {
  const store = new MemoryStore();
  store.failOnCreate = 2;
  const { actions } = harness({ store, selected: ["C:\\one", "C:\\two"] });
  await assert.rejects(actions.selectFiles(SELECT_ARGS, BINDING),
    (error) => error instanceof FileTransferError && error.code === "source_changed");
  assert.equal(store.removals.length, 1);
  assert.equal(store.removals[0].binding.workspaceBindingId, BINDING.workspaceBindingId);
});

test("symlink, hardlink, race, traversal, and budget failures remain typed and publish nothing", async () => {
  for (const code of ["source_symlink", "source_hardlink", "source_changed", "path_escape", "byte_budget_exceeded"]) {
    const store = new MemoryStore();
    store.createSnapshot = async () => { throw new FileTransferError(code); };
    const { actions } = harness({ store });
    await assert.rejects(actions.selectFiles(SELECT_ARGS, BINDING),
      (error) => error instanceof FileTransferError && error.code === code);
    assert.equal(store.removals.length, 0);
  }
});

test("attachment import is bound to workspace generation and re-verifies digest and size", async () => {
  const { actions, store } = harness();
  const selected = await actions.selectFiles(SELECT_ARGS, BINDING);
  const snapshot = selected.files[0];
  const imported = await actions.importAttachment({ opaqueId: snapshot.opaqueId, expectedSha256: DIGEST }, BINDING);
  assert.deepEqual(imported, { opaqueArtifactId: snapshot.opaqueId, digest: DIGEST });
  assert.equal(store.verifies.length, 1);
  await assert.rejects(actions.importAttachment(
    { opaqueId: snapshot.opaqueId, expectedSha256: DIGEST },
    { ...BINDING, workspaceBindingGeneration: 5 },
  ), (error) => error instanceof FileTransferError && error.code === "snapshot_scope_mismatch");
});

test("artifact digest and workspace scope are verified before Save As; results contain no destination path", async () => {
  const wrongScope = harness({ artifact: {
    localCopyPath: "C:\\workspace\\artifact-copy",
    workspaceBindingId: "other-workspace",
    workspaceBindingGeneration: 1,
  } });
  await assert.rejects(wrongScope.actions.saveArtifact({
    remoteArtifactId: "artifact-1", expectedSha256: DIGEST, suggestedName: "result.txt", maximumBytes: 32,
  }, BINDING), (error) => error instanceof FileTransferError && error.code === "artifact_scope_mismatch");
  assert.equal(wrongScope.calls.save, 0);

  const badDigestStore = new MemoryStore();
  badDigestStore.failSave = "artifact_digest_mismatch";
  const badDigest = harness({ store: badDigestStore });
  await assert.rejects(badDigest.actions.saveArtifact({
    remoteArtifactId: "artifact-1", expectedSha256: DIGEST, suggestedName: "result.txt", maximumBytes: 32,
  }, BINDING), (error) => error instanceof FileTransferError && error.code === "artifact_digest_mismatch");
  assert.equal(badDigest.calls.save, 0);

  const success = harness({ destination: "C:\\fresh\\result.txt" });
  const receipt = await success.actions.saveArtifact({
    remoteArtifactId: "artifact-1", expectedSha256: DIGEST, suggestedName: "result.txt", maximumBytes: 32,
  }, BINDING);
  assert.deepEqual(receipt, { completed: true });
  assert.equal(JSON.stringify(receipt).includes("C:\\"), false);
  assert.equal(success.store.saves.length, 2, "one verification and one neighboring-temp publication");
});

test("overwrite requires a separate confirmation and cancellation performs no local read", async () => {
  const existingStore = new MemoryStore();
  existingStore.destinationPresent = true;
  const denied = harness({ store: existingStore, overwrite: false });
  assert.equal(await denied.actions.saveArtifact({
    remoteArtifactId: "artifact-1", expectedSha256: DIGEST, suggestedName: "result.txt", maximumBytes: 32,
  }, BINDING), null);
  assert.equal(denied.calls.confirm, 1);
  assert.equal(existingStore.saves.length, 1, "verification may run, publication may not");

  const approvedStore = new MemoryStore();
  approvedStore.destinationPresent = true;
  const approved = harness({ store: approvedStore, overwrite: true });
  assert.deepEqual(await approved.actions.saveArtifact({
    remoteArtifactId: "artifact-1", expectedSha256: DIGEST, suggestedName: "result.txt", maximumBytes: 32,
  }, BINDING), { completed: true });
  assert.equal(approvedStore.saves.at(-1).overwrite, true);

  const abort = new AbortController();
  abort.abort("user_cancelled");
  const cancelled = harness();
  await assert.rejects(cancelled.actions.selectFiles(SELECT_ARGS, BINDING, abort.signal),
    (error) => error instanceof FileTransferError && error.code === "cancelled");
  assert.equal(cancelled.calls.select, 0);
});
