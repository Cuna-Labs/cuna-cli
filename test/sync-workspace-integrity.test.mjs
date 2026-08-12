import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoPortableCollisions,
  compileExclusionPolicy,
  createWorkspaceBinding,
  createWorkspaceManifest,
  deleteLocalState,
  exportSafeLocalState,
  normalizeWirePath,
  validateWorkspaceBinding,
} from "../dist/workspace/index.js";
import {
  BoundedOperationQueue,
  classifyConflict,
  compareVectorClocks,
  ConflictStore,
  createWorkspaceRevision,
  DurableSyncJournal,
  incrementVectorClock,
  inspectSyncJournal,
  LocalSyncSupervisor,
  progressFromReceipt,
  RevisionOverlayStore,
  SyncSupervisorRegistry,
} from "../dist/sync/index.js";

const linuxCapabilities = Object.freeze({
  platform: "linux",
  caseSensitive: true,
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

const windowsCapabilities = Object.freeze({
  ...linuxCapabilities,
  platform: "windows",
  caseSensitive: false,
  unicodeNormalization: "nfc",
});

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "runa-sync-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function version(digest, clock, operationId, kind = "file") {
  return { kind, digest: kind === "tombstone" ? null : digest, clock, operationId };
}

test("workspace binding identity is distinct, canonical, tenant-bound, and generation-checked", async (t) => {
  const root = await temporaryDirectory(t);
  const identifiers = ["project_1", "local_1", "binding_1"];
  const binding = await createWorkspaceBinding({
    root,
    tenantId: "tenant_1",
    workspaceId: "workspace_1",
    machineId: "machine_1",
    idFactory: () => identifiers.shift(),
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.notEqual(binding.projectId, binding.localInstanceId);
  assert.equal(binding.remoteRoot, "/workspace/projects/project_1");
  await validateWorkspaceBinding(binding, {
    tenantId: "tenant_1",
    workspaceId: "workspace_1",
    machineId: "machine_1",
    canonicalLocalRoot: root,
    generation: 0,
  });
  await assert.rejects(validateWorkspaceBinding(binding, {
    tenantId: "tenant_foreign",
    workspaceId: "workspace_1",
    machineId: "machine_1",
    canonicalLocalRoot: root,
  }), (error) => error.code === "runa.workspace.identity_unproven");
});

test("portable path property corpus rejects traversal, platform aliases, devices, and malformed components", () => {
  for (const candidate of [
    "../secret",
    "a/../secret",
    "/absolute",
    "C:/absolute",
    "a\\b",
    "CON",
    "aux.txt",
    "name.",
    "name ",
    "a//b",
    "a/./b",
    `bad\0name`,
  ]) {
    assert.throws(() => normalizeWirePath(candidate, windowsCapabilities), (error) => error.code === "runa.workspace.path_invalid");
  }
  assert.equal(normalizeWirePath("src/caf\u00e9.ts", windowsCapabilities), "src/caf\u00e9.ts");
});

test("case and Unicode normalization collisions quarantine before materialization", () => {
  assert.throws(
    () => assertNoPortableCollisions(["README", "readme"], windowsCapabilities),
    (error) => error.code === "runa.workspace.portability_conflict",
  );
  assert.throws(
    () => assertNoPortableCollisions(["caf\u00e9", "cafe\u0301"], windowsCapabilities),
    (error) => error.code === "runa.workspace.portability_conflict",
  );
  assert.doesNotThrow(() => assertNoPortableCollisions(["README", "readme"], linuxCapabilities));
});

test("exclusion policy runs before content reads and never opens immutable secret paths", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, ".runa"));
  await writeFile(join(root, ".runa", "workspace.json"), "private metadata");
  await writeFile(join(root, ".env"), "SECRET=should-not-be-read");
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "generated.js"), "generated");
  await writeFile(join(root, "source.ts"), "export const safe = true;\n");
  const policy = compileExclusionPolicy([{ source: "runaignore", text: "dist/**\n" }], linuxCapabilities);
  const opened = [];
  const manifest = await createWorkspaceManifest({
    root,
    policy,
    capabilities: linuxCapabilities,
    beforeContentRead: (path) => opened.push(path),
  });
  assert.deepEqual(opened, ["source.ts"]);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), ["dist", "source.ts"]);
  assert.equal(manifest.excludedCounts.immutable_credentials, 1);
  assert.equal(manifest.excludedCounts.immutable_metadata, 1);
  assert.equal(manifest.excludedCounts.user_rule, 1);
});

test("admitted high-confidence secrets are blocked without exposing their value", async (t) => {
  const root = await temporaryDirectory(t);
  // Keep the detector fixture out of the release candidate's literal secret
  // scan while still exercising the exact PEM marker at runtime.
  const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  await writeFile(join(root, "source.txt"), `${privateKeyMarker}\nsuper-sensitive-material`);
  const policy = compileExclusionPolicy([], linuxCapabilities);
  await assert.rejects(
    createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities }),
    (error) => error.code === "runa.workspace.secret_blocked" && !error.message.includes("super-sensitive"),
  );
});

test("symlink and junction escape is rejected before outside content is read", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside secret");
  try {
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("The test host does not permit symlink or junction creation.");
    throw error;
  }
  const opened = [];
  await assert.rejects(
    createWorkspaceManifest({
      root,
      policy: compileExclusionPolicy([], linuxCapabilities),
      capabilities: linuxCapabilities,
      allowSafeRelativeSymlinks: true,
      beforeContentRead: (path) => opened.push(path),
    }),
    (error) => error.code === "runa.workspace.path_escape",
  );
  assert.deepEqual(opened, []);
});

test("manifest roots and chunk identities are deterministic and change with bytes", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.txt"), "alpha");
  await writeFile(join(root, "src", "b.txt"), "beta");
  const policy = compileExclusionPolicy([], linuxCapabilities);
  const first = await createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities, limits: { chunkBytes: 2 } });
  const second = await createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities, limits: { chunkBytes: 2 } });
  assert.equal(first.manifestRoot, second.manifestRoot);
  assert.equal(first.entries.find((entry) => entry.path === "src/a.txt").chunks.length, 3);
  await writeFile(join(root, "src", "a.txt"), "alphA");
  const changed = await createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities, limits: { chunkBytes: 2 } });
  assert.notEqual(first.manifestRoot, changed.manifestRoot);
});

test("vector clocks provide a deterministic causal partial order", () => {
  const initial = {};
  const a = incrementVectorClock(initial, "agent-a");
  const b = incrementVectorClock(initial, "agent-b");
  assert.equal(compareVectorClocks(initial, a), "before");
  assert.equal(compareVectorClocks(a, initial), "after");
  assert.equal(compareVectorClocks(a, b), "concurrent");
  assert.equal(compareVectorClocks(a, { "agent-a": 1 }), "equal");
});

test("content-equivalent disjoint histories produce one deterministic revision identity", () => {
  const treeLeft = {
    a: version(digestA, { a: 1 }, "a"),
    b: version(digestB, { b: 1 }, "b"),
  };
  const treeRight = {
    b: version(digestB, { b: 1 }, "b"),
    a: version(digestA, { a: 1 }, "a"),
  };
  const left = createWorkspaceRevision({ workspaceId: "w", parentIds: ["base", "left"], policyDigest: "p", tree: treeLeft });
  const right = createWorkspaceRevision({ workspaceId: "w", parentIds: ["base", "right"], policyDigest: "p", tree: treeRight });
  assert.equal(left.manifestRoot, right.manifestRoot);
  assert.equal(left.revisionId, right.revisionId);
});

test("rename/delete and modify/delete conflicts preserve base, ours, and theirs", () => {
  const base = version(digestA, { base: 1 }, "base");
  const deleted = version(null, { base: 1, local: 1 }, "delete", "tombstone");
  const modified = version(digestB, { base: 1, remote: 1 }, "modify");
  const modifyDelete = classifyConflict({ workspaceId: "w", path: "a", base, ours: deleted, theirs: modified });
  assert.equal(modifyDelete.disposition, "conflict");
  assert.equal(modifyDelete.conflict.class, "modify_delete");
  assert.equal(modifyDelete.conflict.base.digest, digestA);
  assert.equal(modifyDelete.conflict.ours.kind, "tombstone");
  assert.equal(modifyDelete.conflict.theirs.digest, digestB);

  const renamed = classifyConflict({
    workspaceId: "w",
    path: "renamed-a",
    base,
    ours: version(digestA, { base: 1, local: 1 }, "rename"),
    theirs: modified,
    classHint: "rename_modify",
  });
  assert.equal(renamed.conflict.class, "rename_modify");
});

test("conflict resolution uses generation CAS and identical bytes converge", () => {
  const identical = classifyConflict({
    workspaceId: "w",
    path: "a",
    base: null,
    ours: version(digestA, { a: 1 }, "a"),
    theirs: version(digestA, { b: 1 }, "b"),
  });
  assert.equal(identical.disposition, "converged");

  const divergent = classifyConflict({
    workspaceId: "w",
    path: "a",
    base: null,
    ours: version(digestA, { a: 1 }, "a"),
    theirs: version(digestB, { b: 1 }, "b"),
  }).conflict;
  const store = new ConflictStore();
  store.add(divergent);
  const preview = store.preview(divergent.conflictId, 1);
  assert.throws(() => store.resolve(divergent.conflictId, 1, "ours"), (error) => error.code === "runa.workspace.conflict_stale");
  const resolved = store.resolve(divergent.conflictId, preview.generation, "ours");
  assert.equal(resolved.state, "resolved");
  assert.equal(store.get(divergent.conflictId).ours.digest, digestA);
  assert.equal(store.get(divergent.conflictId).theirs.digest, digestB);
});

test("AgentSession overlays are private and disjoint merge histories converge deterministically", () => {
  const initial = createWorkspaceRevision({ workspaceId: "w", parentIds: [], policyDigest: "policy", tree: {} });
  const store = new RevisionOverlayStore(initial);
  const common = {
    workspaceId: "w",
    machineId: "m",
    userId: "u",
    baseRevision: initial.revisionId,
    policyDigest: "policy",
    quotaBytes: 100,
    confinementAvailable: true,
    atomicRenameAvailable: true,
  };
  const a = store.allocateOverlay({ ...common, agentSessionId: "session-a", idFactory: () => "overlay-a" });
  const b = store.allocateOverlay({ ...common, agentSessionId: "session-b", idFactory: () => "overlay-b" });
  assert.notEqual(a.overlayId, b.overlayId);
  assert.throws(() => store.applyChange({
    overlayId: a.overlayId,
    agentSessionId: "session-b",
    expectedGeneration: a.generation,
    path: "a",
    capabilities: linuxCapabilities,
    version: version(digestA, { a: 1 }, "a"),
    accountedBytes: 1,
  }), (error) => error.code === "runa.workspace.overlay_unavailable");

  const changedA = store.applyChange({ overlayId: a.overlayId, agentSessionId: "session-a", expectedGeneration: a.generation, path: "a", capabilities: linuxCapabilities, version: version(digestA, { a: 1 }, "a"), accountedBytes: 1 });
  const changedB = store.applyChange({ overlayId: b.overlayId, agentSessionId: "session-b", expectedGeneration: b.generation, path: "b", capabilities: linuxCapabilities, version: version(digestB, { b: 1 }, "b"), accountedBytes: 1 });
  const sealedA = store.seal(a.overlayId, "session-a", changedA.generation);
  const mergedA = store.merge({ overlayId: a.overlayId, agentSessionId: "session-a", expectedOverlayGeneration: sealedA.generation, expectedHead: initial.revisionId, policyDigest: "policy" });
  const sealedB = store.seal(b.overlayId, "session-b", changedB.generation);
  const mergedB = store.merge({ overlayId: b.overlayId, agentSessionId: "session-b", expectedOverlayGeneration: sealedB.generation, expectedHead: mergedA.revision.revisionId, policyDigest: "policy" });
  assert.equal(mergedB.revision.tree.a.digest, digestA);
  assert.equal(mergedB.revision.tree.b.digest, digestB);
});

test("overlay quota failure preserves canonical head and a crashed session remains retained", () => {
  const initial = createWorkspaceRevision({ workspaceId: "w", parentIds: [], policyDigest: "p", tree: {} });
  const store = new RevisionOverlayStore(initial);
  const overlay = store.allocateOverlay({
    workspaceId: "w", machineId: "m", userId: "u", agentSessionId: "s", baseRevision: initial.revisionId,
    policyDigest: "p", quotaBytes: 1, confinementAvailable: true, atomicRenameAvailable: true, idFactory: () => "o",
  });
  assert.throws(() => store.applyChange({
    overlayId: "o", agentSessionId: "s", expectedGeneration: overlay.generation, path: "a",
    capabilities: linuxCapabilities, version: version(digestA, { s: 1 }, "op"), accountedBytes: 2,
  }), (error) => error.code === "runa.workspace.overlay_full");
  assert.equal(store.head.revisionId, initial.revisionId);
  assert.equal(store.retainAfterExit("o", "s", "2026-09-08T00:00:00.000Z").state, "retained");
});

test("fenced journal admits exactly one concurrent writer", async (t) => {
  const directory = await temporaryDirectory(t);
  const initializer = await DurableSyncJournal.open({ directory, bindingId: "binding", bindingGeneration: 1, ownerId: "init" });
  await initializer.close();
  const attempts = await Promise.allSettled([
    DurableSyncJournal.open({ directory, bindingId: "binding", bindingGeneration: 1, ownerId: "writer-a" }),
    DurableSyncJournal.open({ directory, bindingId: "binding", bindingGeneration: 1, ownerId: "writer-b" }),
  ]);
  const winners = attempts.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  await winners[0].value.close();
});

test("journal replay is idempotent and unknown outcome requires an authoritative query", async (t) => {
  const directory = await temporaryDirectory(t);
  const journal = await DurableSyncJournal.open({ directory, bindingId: "binding", bindingGeneration: 1, ownerId: "writer" });
  const intent = { operationId: "op-1", baseGeneration: 1, digest: digestA, byteLength: 5 };
  const first = await journal.append(intent);
  const replay = await journal.append(intent);
  assert.equal(first.recordSequence, replay.recordSequence);
  await journal.transition("op-1", "sending");
  await journal.transition("op-1", "uncertain");
  await journal.close();
  const inspection = await inspectSyncJournal(directory);
  assert.equal(inspection.requiresReconciliation, false);
  assert.deepEqual(inspection.recoveryActions, [{ operationId: "op-1", action: "query_outcome" }]);
});

test("journal terminal replay is idempotent, expired writers fail, and uncertain work cannot be blindly resent", async (t) => {
  const directory = await temporaryDirectory(t);
  let now = 100;
  const journal = await DurableSyncJournal.open({
    directory,
    bindingId: "binding",
    bindingGeneration: 1,
    ownerId: "writer",
    leaseMs: 10,
    now,
    clock: () => now,
  });
  const intent = { operationId: "op-final", baseGeneration: 1, digest: digestA, byteLength: 5 };
  await journal.append(intent);
  await journal.transition(intent.operationId, "sending");
  await journal.transition(intent.operationId, "acknowledged");
  const applied = await journal.transition(intent.operationId, "applied");
  const replay = await journal.append(intent);
  assert.equal(replay.recordSequence, applied.recordSequence);
  assert.equal(replay.state, "applied");

  const uncertain = { operationId: "op-uncertain", baseGeneration: 1, digest: digestB, byteLength: 1 };
  await journal.append(uncertain);
  await journal.transition(uncertain.operationId, "sending");
  await journal.transition(uncertain.operationId, "uncertain");
  await assert.rejects(
    journal.transition(uncertain.operationId, "sending"),
    (error) => error.code === "runa.workspace.journal_invalid",
  );
  now = 110;
  await assert.rejects(
    journal.append({ operationId: "late", baseGeneration: 1, digest: digestA, byteLength: 1 }),
    (error) => error.code === "runa.workspace.writer_fenced",
  );
  await journal.close();
});

test("expired crash lease transfers with fencing and corrupt journal requires reconciliation", async (t) => {
  const directory = await temporaryDirectory(t);
  let crashedNow = 0;
  const crashed = await DurableSyncJournal.open({
    directory, bindingId: "binding", bindingGeneration: 1, ownerId: "old", leaseMs: 10, now: crashedNow, clock: () => crashedNow,
  });
  await crashed.append({ operationId: "op-old", baseGeneration: 1, digest: digestA, byteLength: 1 });
  crashedNow = 11;
  const recovered = await DurableSyncJournal.open({ directory, bindingId: "binding", bindingGeneration: 1, ownerId: "new", leaseMs: 10, now: 11, clock: () => 11 });
  await assert.rejects(
    crashed.append({ operationId: "op-stale", baseGeneration: 1, digest: digestB, byteLength: 1 }),
    (error) => error.code === "runa.workspace.writer_fenced",
  );
  await recovered.close();
  await crashed.close();
  await appendFile(join(directory, "journal.ndjson"), "{corrupt\n");
  const inspection = await inspectSyncJournal(directory);
  assert.equal(inspection.requiresReconciliation, true);
  assert.equal(inspection.reason, "checksum_or_sequence_gap");
});

test("queue full marks the root dirty, preserves admitted intents, and never crosses a delete barrier", () => {
  const queue = new BoundedOperationQueue(3, 5);
  assert.equal(queue.enqueue({ operationId: "u1", path: "a", kind: "update", byteLength: 2, baseGeneration: 1, acknowledged: false }).admitted, true);
  const coalesced = queue.enqueue({ operationId: "u2", path: "a", kind: "update", byteLength: 3, baseGeneration: 1, acknowledged: false });
  assert.equal(coalesced.coalescedOperationId, "u1");
  queue.enqueue({ operationId: "d1", path: "a", kind: "delete", byteLength: 0, baseGeneration: 1, acknowledged: false });
  queue.enqueue({ operationId: "u3", path: "a", kind: "update", byteLength: 2, baseGeneration: 1, acknowledged: false });
  const full = queue.enqueue({ operationId: "b1", path: "b", kind: "create", byteLength: 1, baseGeneration: 1, acknowledged: false });
  assert.deepEqual(full, { admitted: false, dirty: true, reason: "operation_limit" });
  assert.deepEqual(queue.items.map((item) => item.operationId), ["u2", "d1", "u3"]);
});

test("supervisor clients share one owner, overflow reconciles, and only a fresh matching receipt proves convergence", () => {
  const config = { bindingId: "b", bindingGeneration: 1, canonicalRoot: "/root", policyDigest: "p", epoch: "e" };
  const registry = new SyncSupervisorRegistry();
  const first = registry.connect(config);
  const second = registry.connect(config);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.supervisor, second.supervisor);
  assert.throws(() => registry.connect({ ...config, policyDigest: "foreign" }), (error) => error.code === "runa.workspace.supervisor_conflict");

  const convergenceNow = Date.parse("2026-08-08T00:01:00.000Z");
  const supervisor = new LocalSyncSupervisor(config, { clock: () => convergenceNow });
  supervisor.watcherOverflow();
  assert.deepEqual(supervisor.snapshot, { state: "reconciling", dirty: true, incrementalApplyPaused: true, reason: "watcher_overflow" });
  supervisor.confirmConvergence({
    authority: "runa_workspace_service",
    bindingId: "b",
    bindingGeneration: 1,
    epoch: "e",
    policyDigest: "p",
    localManifestRoot: digestA,
    canonicalManifestRoot: digestA,
    canonicalRevision: "revision-1",
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-08-08T00:10:00.000Z",
  }, convergenceNow);
  assert.equal(supervisor.snapshot.state, "converged");
  assert.equal(supervisor.snapshot.canonicalRevision, "revision-1");
});

test("expired convergence evidence cannot remain publicly converged", () => {
  const config = { bindingId: "b", bindingGeneration: 1, canonicalRoot: "/root", policyDigest: "p", epoch: "e" };
  let now = Date.parse("2026-08-08T00:01:00.000Z");
  const supervisor = new LocalSyncSupervisor(config, { clock: () => now });
  supervisor.confirmConvergence({
    authority: "runa_workspace_service",
    bindingId: "b",
    bindingGeneration: 1,
    epoch: "e",
    policyDigest: "p",
    localManifestRoot: digestA,
    canonicalManifestRoot: digestA,
    canonicalRevision: "revision-1",
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-08-08T00:02:00.000Z",
  }, now);
  assert.equal(supervisor.snapshot.state, "converged");
  now = Date.parse("2026-08-08T00:02:00.000Z");
  assert.deepEqual(supervisor.snapshot, {
    state: "unknown",
    dirty: true,
    incrementalApplyPaused: true,
    reason: "convergence_evidence_expired",
    evidenceExpiresAt: "2026-08-08T00:02:00.000Z",
  });
});

test("progress exposes measured counts and refuses local-only commit claims", () => {
  const progress = progressFromReceipt({
    authority: "local_manifest", stage: "hashing", observedEntries: 4, observedBytes: 25,
    totalEntries: 10, totalBytes: 100, observedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(progress.percent, 25);
  assert.equal(progress.ready, false);
  assert.throws(() => progressFromReceipt({
    authority: "local_manifest", stage: "committed", observedEntries: 10, observedBytes: 100,
    observedAt: "2026-08-08T00:00:00.000Z",
  }), (error) => error.code === "runa.workspace.progress_unproven");
});

test("N and N-1 durable schema fixtures reject unsafe mutation before a lease is created", async (t) => {
  const future = join(await temporaryDirectory(t), "future");
  await mkdir(future);
  await writeFile(join(future, "journal.meta.json"), JSON.stringify({
    schemaVersion: 3, minimumReaderVersion: 3, minimumWriterVersion: 3,
    bindingId: "binding", bindingGeneration: 1, lastFence: 0,
  }));
  const futureInspection = await inspectSyncJournal(future);
  assert.equal(futureInspection.requiresReconciliation, true);
  await assert.rejects(
    DurableSyncJournal.open({ directory: future, bindingId: "binding", bindingGeneration: 1, ownerId: "writer" }),
    (error) => error.code === "runa.workspace.schema_incompatible",
  );
  await assert.rejects(readFile(join(future, "writer.lease")), (error) => error.code === "ENOENT");

  const previous = join(await temporaryDirectory(t), "previous");
  await mkdir(previous);
  await writeFile(join(previous, "journal.meta.json"), JSON.stringify({
    schemaVersion: 1, minimumReaderVersion: 1, minimumWriterVersion: 1,
    bindingId: "binding", bindingGeneration: 1, lastFence: 0,
  }));
  assert.equal((await inspectSyncJournal(previous)).requiresReconciliation, false);
  await assert.rejects(
    DurableSyncJournal.open({ directory: previous, bindingId: "binding", bindingGeneration: 1, ownerId: "writer" }),
    (error) => error.code === "runa.workspace.schema_incompatible",
  );
});

test("local lifecycle export is path-bounded and deletion reports partial and held states truthfully", async (t) => {
  const root = await temporaryDirectory(t);
  const journalPath = join(root, "journal.dat");
  const nonEmpty = join(root, "non-empty");
  await writeFile(journalPath, "journal");
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, "child"), "retained");
  const deadline = "2026-09-08T00:00:00.000Z";
  const records = [
    { dataId: "journal", workspaceId: "w", class: "sync_journal", absoluteLocation: journalPath, policyVersion: "p", retentionDeadline: deadline },
    { dataId: "conflict", workspaceId: "w", class: "conflict_copy", absoluteLocation: nonEmpty, policyVersion: "p", retentionDeadline: deadline },
  ];
  const exported = exportSafeLocalState({ stateRoot: root, workspaceId: "w", generation: 1, records, now: new Date("2026-08-08T00:00:00Z") });
  assert.equal(exported.records[0].relativeLocation.includes(root), false);
  assert.match(exported.digest, /^[a-f0-9]{64}$/);
  const receipt = await deleteLocalState({ stateRoot: root, workspaceId: "w", requestId: "delete-1", authorized: true, records, now: new Date("2026-08-08T00:00:00Z") });
  assert.equal(receipt.state, "partially_deleted");
  assert.deepEqual(receipt.completedDataIds, ["journal"]);
  assert.deepEqual(receipt.pendingDataIds, ["conflict"]);

  const heldPath = join(root, "held.dat");
  await writeFile(heldPath, "held");
  const held = await deleteLocalState({
    stateRoot: root,
    workspaceId: "w",
    requestId: "delete-2",
    authorized: true,
    records: [{
      dataId: "held", workspaceId: "w", class: "conflict_copy", absoluteLocation: heldPath,
      policyVersion: "p", retentionDeadline: deadline,
      legalHold: { authority: "security", reasonCode: "investigation", expiresAt: "2026-08-09T00:00:00Z" },
    }],
    now: new Date("2026-08-08T00:00:00Z"),
  });
  assert.equal(held.state, "held");
  assert.deepEqual(held.pendingDataIds, ["held"]);
});
