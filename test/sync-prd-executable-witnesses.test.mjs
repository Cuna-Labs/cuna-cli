import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";
import {
  LocalSyncSupervisor,
  RevisionOverlayStore,
  SyncSupervisorRegistry,
  createWorkspaceRevision,
  progressFromReceipt,
} from "../dist/sync/index.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const capabilities = Object.freeze({
  platform: "linux",
  caseSensitive: true,
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

function version(digest, actor) {
  return Object.freeze({ kind: "file", digest, clock: Object.freeze({ base: 1, [actor]: 1 }), operationId: actor });
}

function initialRevision(tree = {}) {
  return createWorkspaceRevision({ workspaceId: "workspace", parentIds: [], policyDigest: "policy", tree });
}

function overlayInput(initial, agentSessionId, overlayId, overrides = {}) {
  return {
    workspaceId: "workspace",
    machineId: "machine",
    userId: "user",
    agentSessionId,
    baseRevision: initial.revisionId,
    policyDigest: "policy",
    quotaBytes: 1_024,
    confinementAvailable: true,
    atomicRenameAvailable: true,
    idFactory: () => overlayId,
    ...overrides,
  };
}

function apply(store, overlay, path, value) {
  return store.applyChange({
    overlayId: overlay.overlayId,
    agentSessionId: overlay.agentSessionId,
    expectedGeneration: overlay.generation,
    path,
    capabilities,
    version: value,
    accountedBytes: 1,
  });
}

function seal(store, overlay) {
  return store.seal(overlay.overlayId, overlay.agentSessionId, overlay.generation);
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "runa-sync-witness-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return directory;
}

test("TC-039-01 same-base AgentSessions have private upper layers and cannot observe sibling writes", () => {
  const initial = initialRevision();
  const store = new RevisionOverlayStore(initial);
  const first = store.allocateOverlay(overlayInput(initial, "session-a", "overlay-a"));
  const second = store.allocateOverlay(overlayInput(initial, "session-b", "overlay-b"));
  assert.notEqual(first.overlayId, second.overlayId);

  const changedFirst = apply(store, first, "only-a.txt", version(digestA, "a"));
  const changedSecond = apply(store, second, "only-b.txt", version(digestB, "b"));
  assert.deepEqual(Object.keys(changedFirst.changes), ["only-a.txt"]);
  assert.deepEqual(Object.keys(changedSecond.changes), ["only-b.txt"]);
  assert.equal(changedFirst.changes["only-b.txt"], undefined);
  assert.equal(changedSecond.changes["only-a.txt"], undefined);
  assert.throws(
    () => apply(store, { ...changedFirst, agentSessionId: "session-b" }, "intrusion.txt", version(digestC, "b")),
    (error) => error.code === "cuna.workspace.overlay_unavailable",
  );
  assert.equal(store.head.revisionId, initial.revisionId, "unmerged upper-layer writes must not reach canonical head");
});

test("TC-039-03 concurrent same-intent merge retries create exactly one canonical revision", async () => {
  const initial = initialRevision();
  const store = new RevisionOverlayStore(initial);
  const allocated = store.allocateOverlay(overlayInput(initial, "session", "overlay"));
  const sealed = seal(store, apply(store, allocated, "file.txt", version(digestA, "session")));
  const merge = () => store.merge({
    overlayId: sealed.overlayId,
    agentSessionId: sealed.agentSessionId,
    expectedOverlayGeneration: sealed.generation,
    expectedHead: initial.revisionId,
    policyDigest: "policy",
  });

  const outcomes = await Promise.allSettled([
    Promise.resolve().then(merge),
    Promise.resolve().then(merge),
  ]);
  const committed = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const fenced = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(committed.length, 1);
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].reason.code, "cuna.workspace.overlay_stale");
  assert.equal(store.head.revisionId, committed[0].value.revision.revisionId);
  assert.deepEqual(store.head.parentIds, [initial.revisionId]);
});

test("TC-039-04 divergent same-path edits preserve base, ours, theirs, and canonical head", () => {
  const baseVersion = Object.freeze({ kind: "file", digest: digestA, clock: Object.freeze({ base: 1 }), operationId: "base" });
  const initial = initialRevision({ "shared.txt": baseVersion });
  const store = new RevisionOverlayStore(initial);
  const first = store.allocateOverlay(overlayInput(initial, "session-a", "overlay-a"));
  const second = store.allocateOverlay(overlayInput(initial, "session-b", "overlay-b"));
  const sealedFirst = seal(store, apply(store, first, "shared.txt", version(digestB, "a")));
  const sealedSecond = seal(store, apply(store, second, "shared.txt", version(digestC, "b")));
  const firstMerge = store.merge({
    overlayId: sealedFirst.overlayId,
    agentSessionId: sealedFirst.agentSessionId,
    expectedOverlayGeneration: sealedFirst.generation,
    expectedHead: initial.revisionId,
    policyDigest: "policy",
  });
  const admittedHead = firstMerge.revision.revisionId;
  const conflict = store.merge({
    overlayId: sealedSecond.overlayId,
    agentSessionId: sealedSecond.agentSessionId,
    expectedOverlayGeneration: sealedSecond.generation,
    expectedHead: admittedHead,
    policyDigest: "policy",
  });

  assert.equal(conflict.revision, undefined);
  assert.equal(conflict.overlay.state, "conflicted");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].base.digest, digestA);
  assert.equal(conflict.conflicts[0].ours.digest, digestC);
  assert.equal(conflict.conflicts[0].theirs.digest, digestB);
  assert.equal(store.head.revisionId, admittedHead);
});

test("TC-039-05 disjoint sibling histories converge to the same root in either arrival order", () => {
  const run = (order) => {
    const initial = initialRevision();
    const store = new RevisionOverlayStore(initial);
    const overlays = {
      a: store.allocateOverlay(overlayInput(initial, "session-a", "overlay-a")),
      b: store.allocateOverlay(overlayInput(initial, "session-b", "overlay-b")),
    };
    const sealed = {
      a: seal(store, apply(store, overlays.a, "a.txt", version(digestA, "a"))),
      b: seal(store, apply(store, overlays.b, "b.txt", version(digestB, "b"))),
    };
    for (const key of order) {
      store.merge({
        overlayId: sealed[key].overlayId,
        agentSessionId: sealed[key].agentSessionId,
        expectedOverlayGeneration: sealed[key].generation,
        expectedHead: store.head.revisionId,
        policyDigest: "policy",
      });
    }
    return store.head;
  };

  const left = run(["a", "b"]);
  const right = run(["b", "a"]);
  assert.equal(left.manifestRoot, right.manifestRoot);
  assert.equal(left.revisionId, right.revisionId);
  assert.deepEqual(left.tree, right.tree);
});

test("TC-039-10 missing confinement or atomic rename rejects strong mode before overlay admission", () => {
  const initial = initialRevision();
  const store = new RevisionOverlayStore(initial);
  for (const unavailable of [
    { confinementAvailable: false, atomicRenameAvailable: true },
    { confinementAvailable: true, atomicRenameAvailable: false },
  ]) {
    assert.throws(
      () => store.allocateOverlay(overlayInput(initial, "session", "overlay", unavailable)),
      (error) => error.code === "cuna.workspace.overlay_unsupported",
    );
  }
  const admitted = store.allocateOverlay(overlayInput(initial, "session", "overlay"));
  assert.equal(admitted.state, "writable", "failed admission must not reserve or silently downgrade the AgentSession");
  assert.equal(store.head.revisionId, initial.revisionId);
});

test("TC-040-02 compatible clients share one supervisor and incompatible root or policy creates no second owner", () => {
  const configuration = { bindingId: "binding", bindingGeneration: 1, canonicalRoot: "/workspace", policyDigest: "policy", epoch: "epoch" };
  const registry = new SyncSupervisorRegistry();
  const first = registry.connect(configuration);
  const second = registry.connect({ ...configuration });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.supervisor, first.supervisor);
  for (const incompatible of [
    { ...configuration, canonicalRoot: "/different" },
    { ...configuration, policyDigest: "different" },
  ]) {
    assert.throws(
      () => registry.connect(incompatible),
      (error) => error.code === "cuna.workspace.supervisor_conflict",
    );
  }
  assert.equal(registry.connect(configuration).supervisor, first.supervisor);
});

test("TC-040-05 watcher overflow and sequence gaps require authoritative full reconciliation before convergence", () => {
  const configuration = { bindingId: "binding", bindingGeneration: 1, canonicalRoot: "/workspace", policyDigest: "policy", epoch: "epoch" };
  const now = Date.parse("2026-08-09T00:00:30.000Z");
  const receipt = {
    authority: "cuna_workspace_service",
    bindingId: "binding",
    bindingGeneration: 1,
    epoch: "epoch",
    policyDigest: "policy",
    localManifestRoot: digestA,
    canonicalManifestRoot: digestA,
    canonicalRevision: "revision-1",
    observedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:01:00.000Z",
  };
  for (const interrupt of ["watcherOverflow", "sequenceGap"]) {
    const supervisor = new LocalSyncSupervisor(configuration, { clock: () => now });
    supervisor[interrupt]();
    assert.equal(supervisor.snapshot.state, "reconciling");
    assert.equal(supervisor.snapshot.dirty, true);
    assert.equal(supervisor.snapshot.incrementalApplyPaused, true);
    supervisor.confirmConvergence({ ...receipt, canonicalManifestRoot: digestB }, now);
    assert.equal(supervisor.snapshot.state, "unknown");
    supervisor.confirmConvergence(receipt, now);
    assert.equal(supervisor.snapshot.state, "converged");
    assert.equal(supervisor.snapshot.canonicalRevision, "revision-1");
  }
});

test("TC-040-07 progress uses measured milestones and cannot claim readiness without a server admission receipt", () => {
  const first = progressFromReceipt({
    authority: "local_manifest",
    stage: "hashing",
    observedEntries: 4,
    observedBytes: 25,
    totalEntries: 10,
    totalBytes: 100,
    observedAt: "2026-08-09T00:00:00.000Z",
  });
  const laterClockOnly = progressFromReceipt({
    authority: "local_manifest",
    stage: "hashing",
    observedEntries: 4,
    observedBytes: 25,
    totalEntries: 10,
    totalBytes: 100,
    observedAt: "2026-08-09T00:59:00.000Z",
  });
  assert.equal(first.percent, 25);
  assert.equal(laterClockOnly.percent, 25, "elapsed time must not advance measured progress");
  assert.equal(first.ready, false);
  assert.throws(
    () => progressFromReceipt({
      authority: "local_manifest",
      stage: "committed",
      observedEntries: 10,
      observedBytes: 100,
      totalEntries: 10,
      totalBytes: 100,
      observedAt: "2026-08-09T00:00:00.000Z",
    }),
    (error) => error.code === "cuna.workspace.progress_unproven",
  );
  const admitted = progressFromReceipt({
    authority: "cuna_workspace_service",
    stage: "committed",
    observedEntries: 10,
    observedBytes: 100,
    totalEntries: 10,
    totalBytes: 100,
    canonicalRevision: "revision-1",
    observedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(admitted.ready, true);
  assert.equal(admitted.percent, 100);
  assert.equal(admitted.canonicalRevision, "revision-1");
});

test("TC-040-12 manifest omission is explained only by explicit exclusion policy, never relevance heuristics", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "cache"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "cache", "explicitly-ignored.bin"), new Uint8Array([1, 2, 3]));
  await writeFile(join(root, "node_modules", "must-still-sync.js"), "module.exports = true;\n");
  await writeFile(join(root, "large-generated-looking.lock"), "x".repeat(64 * 1024));
  await writeFile(join(root, "zero-byte.bin"), new Uint8Array());
  const reads = [];
  const manifest = await createWorkspaceManifest({
    root,
    policy: compileExclusionPolicy([{ source: "cunaignore", text: "cache/**\n" }], capabilities),
    capabilities,
    beforeContentRead: (path) => reads.push(path),
  });

  assert.deepEqual(reads.sort(), [
    "large-generated-looking.lock",
    "node_modules/must-still-sync.js",
    "zero-byte.bin",
  ]);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [
    "cache",
    "large-generated-looking.lock",
    "node_modules",
    "node_modules/must-still-sync.js",
    "zero-byte.bin",
  ]);
  assert.deepEqual(manifest.excludedCounts, { user_rule: 1 });
});
