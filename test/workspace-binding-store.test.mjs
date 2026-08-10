import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  discoverWorkspaceBindingMarker,
  loadWorkspaceBinding,
  persistWorkspaceBinding,
  workspaceBindingCompareAndSwap,
} from "../dist/workspace/index.js";

const policyDigest = "a".repeat(64);
const bindingCreatedAt = "2026-08-09T00:00:00.000Z";
const bindingUpdatedAt = "2026-08-09T00:00:00.000Z";

function draft(overrides = {}) {
  return Object.freeze({
    profileId: "default",
    userId: "user_1",
    workspaceId: "workspace_1",
    bindingId: "binding_1",
    projectId: "project_1",
    localInstanceId: "local_1",
    machineId: "machine_1",
    remoteRoot: "/workspace/projects/project_1",
    policyDigest,
    generation: 0,
    bindingCreatedAt,
    bindingUpdatedAt,
    ...overrides,
  });
}

function expectations(overrides = {}) {
  return Object.freeze({
    profileId: "default",
    userId: "user_1",
    workspaceId: "workspace_1",
    machineId: "machine_1",
    remoteRoot: "/workspace/projects/project_1",
    policyDigest,
    generation: 0,
    bindingCreatedAt,
    bindingUpdatedAt,
    bindingId: "binding_1",
    ...overrides,
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "runa-binding-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

test("nearest-marker discovery stays inside an explicit physical boundary", async (t) => {
  const parent = await temporaryDirectory(t);
  const project = join(parent, "project");
  const nested = join(project, "src", "feature");
  await mkdir(nested, { recursive: true });
  const parentRecord = await persistWorkspaceBinding({
    root: parent,
    binding: draft({
      bindingId: "parent_binding",
      projectId: "parent_project",
      remoteRoot: "/workspace/projects/parent_project",
    }),
    expected: null,
  });
  assert.equal(parentRecord.bindingId, "parent_binding");
  assert.equal(
    await discoverWorkspaceBindingMarker({ startPath: nested, boundaryPath: project }),
    undefined,
  );

  await persistWorkspaceBinding({ root: project, binding: draft(), expected: null });
  const marker = await discoverWorkspaceBindingMarker({ startPath: nested, boundaryPath: project });
  assert.equal(marker?.workspaceRoot.path, project);
  assert.equal(marker?.recordPath, join(project, ".runa", "workspace.json"));
});

test("a record is returned only when profile, user, workspace, machine, policy, generation, and binding all match", async (t) => {
  const root = await temporaryDirectory(t);
  const record = await persistWorkspaceBinding({
    root,
    binding: draft(),
    expected: null,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(record.recordRevision, 1);
  assert.equal(record.remoteRoot, "/workspace/projects/project_1");
  const loaded = await loadWorkspaceBinding({ startPath: root, expected: expectations() });
  assert.equal(loaded?.record.integrityDigest, record.integrityDigest);
  assert.equal(loaded?.relocationRequired, false);

  for (const mismatch of [
    { profileId: "other" },
    { userId: "user_2" },
    { workspaceId: "workspace_2" },
    { machineId: "machine_2" },
    { remoteRoot: "/workspace/projects/other_project" },
    { policyDigest: "b".repeat(64) },
    { generation: 1 },
    { bindingId: "binding_2" },
  ]) {
    await assert.rejects(
      loadWorkspaceBinding({ startPath: root, expected: expectations(mismatch) }),
      (error) => error.code === "runa.workspace.identity_unproven" &&
        error.details?.reason === "binding_owner_mismatch",
    );
  }
});

test("concurrent creation and update use a kernel writer lock plus revision, generation, and digest CAS", async (t) => {
  const root = await temporaryDirectory(t);
  const attempts = await Promise.allSettled([
    persistWorkspaceBinding({ root, binding: draft({ bindingId: "binding_a" }), expected: null }),
    persistWorkspaceBinding({ root, binding: draft({ bindingId: "binding_b" }), expected: null }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  const first = attempts.find((result) => result.status === "fulfilled").value;
  const winningDraft = draft({ bindingId: first.bindingId });
  const expected = workspaceBindingCompareAndSwap(first);
  const updates = await Promise.allSettled([
    persistWorkspaceBinding({
      root,
      binding: draft({ ...winningDraft, policyDigest: "b".repeat(64), generation: 1 }),
      expected,
    }),
    persistWorkspaceBinding({
      root,
      binding: draft({ ...winningDraft, policyDigest: "c".repeat(64), generation: 1 }),
      expected,
    }),
  ]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  const stale = updates.find((result) => result.status === "rejected");
  assert.ok([
    "runa.workspace.binding_stale",
    "runa.workspace.workspace_busy",
  ].includes(stale.reason.code));

  const admitted = updates.find((result) => result.status === "fulfilled").value;
  await assert.rejects(
    persistWorkspaceBinding({
      root,
      binding: draft({ ...winningDraft, policyDigest: "d".repeat(64), generation: 1 }),
      expected,
    }),
    (error) => error.code === "runa.workspace.binding_stale",
  );
  await assert.rejects(
    persistWorkspaceBinding({
      root,
      binding: draft({ ...winningDraft, policyDigest: admitted.policyDigest, generation: 0 }),
      expected: workspaceBindingCompareAndSwap(admitted),
    }),
    (error) => error.code === "runa.workspace.identity_unproven",
  );
});

test("corruption, ambiguous fields, copied metadata, and hardlinked metadata fail closed", async (t) => {
  const root = await temporaryDirectory(t);
  const record = await persistWorkspaceBinding({ root, binding: draft(), expected: null });
  const recordPath = join(root, ".runa", "workspace.json");
  const original = await readFile(recordPath, "utf8");
  const source = JSON.parse(original);
  await writeFile(recordPath, JSON.stringify({ ...source, unexpected_authority: true }), { mode: 0o600 });
  await assert.rejects(
    loadWorkspaceBinding({ startPath: root, expected: expectations() }),
    (error) => error.code === "runa.workspace.binding_corrupt",
  );

  await writeFile(recordPath, original, { mode: 0o600 });
  const copy = await temporaryDirectory(t);
  await mkdir(join(copy, ".runa"), { mode: 0o700 });
  await writeFile(join(copy, ".runa", "workspace.json"), original, { mode: 0o600 });
  await assert.rejects(
    loadWorkspaceBinding({ startPath: copy, expected: expectations() }),
    (error) => error.code === "runa.workspace.identity_unproven",
  );

  const outside = join(await temporaryDirectory(t), "outside.json");
  await writeFile(outside, original, { mode: 0o600 });
  await unlink(recordPath);
  await link(outside, recordPath);
  await assert.rejects(
    loadWorkspaceBinding({ startPath: root, expected: expectations() }),
    (error) => error.code === "runa.workspace.binding_store_unsafe",
  );
  assert.equal(await readFile(outside, "utf8"), original);
  assert.equal(record.integrityDigest.length, 64);
});

test("a physical directory move preserves identity and requires an explicit CAS relocation write", async (t) => {
  const container = await temporaryDirectory(t);
  const originalRoot = join(container, "before");
  const movedRoot = join(container, "after");
  await mkdir(originalRoot);
  const first = await persistWorkspaceBinding({ root: originalRoot, binding: draft(), expected: null });
  await rename(originalRoot, movedRoot);
  const moved = await loadWorkspaceBinding({ startPath: movedRoot, expected: expectations() });
  assert.equal(moved?.relocationRequired, true);
  assert.equal(moved?.record.localInstanceId, first.localInstanceId);
  const relocated = await persistWorkspaceBinding({
    root: movedRoot,
    binding: draft(),
    expected: workspaceBindingCompareAndSwap(first),
  });
  assert.equal(relocated.recordRevision, 2);
  assert.equal(relocated.canonicalLocalRoot, movedRoot);
  assert.equal(
    (await loadWorkspaceBinding({ startPath: movedRoot, expected: expectations() }))?.relocationRequired,
    false,
  );
});

test("interrupted private temporary records are recovered before the next atomic commit", async (t) => {
  const root = await temporaryDirectory(t);
  const first = await persistWorkspaceBinding({ root, binding: draft(), expected: null });
  const metadataDirectory = join(root, ".runa");
  const orphan = join(metadataDirectory, ".workspace.json.999.11111111-1111-4111-8111-111111111111.tmp");
  await writeFile(orphan, "interrupted", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(orphan, 0o600);
  await assert.rejects(
    loadWorkspaceBinding({ startPath: root, expected: expectations() }),
    (error) => error.code === "runa.workspace.binding_recovery_required",
  );
  await assert.rejects(
    persistWorkspaceBinding({
      root,
      binding: draft({ generation: 1 }),
      expected: { ...workspaceBindingCompareAndSwap(first), recordRevision: 999 },
    }),
    (error) => error.code === "runa.workspace.binding_stale",
  );
  assert.equal((await lstat(orphan)).isFile(), true);
  const updated = await persistWorkspaceBinding({
    root,
    binding: draft({ generation: 1 }),
    expected: workspaceBindingCompareAndSwap(first),
  });
  await assert.rejects(lstat(orphan), (error) => error.code === "ENOENT");
  assert.equal(updated.generation, 1);
  assert.equal(updated.recordRevision, 2);
  if (process.platform !== "win32") {
    assert.equal((await lstat(metadataDirectory)).mode & 0o077, 0);
    assert.equal((await lstat(join(metadataDirectory, "workspace.json"))).mode & 0o077, 0);
  }
});

test("clock rollback is rejected before replacing the admitted record", async (t) => {
  const root = await temporaryDirectory(t);
  const first = await persistWorkspaceBinding({
    root,
    binding: draft(),
    expected: null,
    now: new Date("2026-08-09T00:00:01.000Z"),
  });
  await assert.rejects(
    persistWorkspaceBinding({
      root,
      binding: draft({ generation: 1 }),
      expected: workspaceBindingCompareAndSwap(first),
      now: new Date("2026-08-09T00:00:00.000Z"),
    }),
    (error) => error.code === "runa.workspace.binding_corrupt" && error.details?.reason === "clock_rollback",
  );
  const retained = await loadWorkspaceBinding({ startPath: root, expected: expectations() });
  assert.equal(retained?.record.integrityDigest, first.integrityDigest);
  assert.equal(retained?.record.recordRevision, 1);
});

test("symlink or junction roots and marker paths are rejected instead of followed", async (t) => {
  const container = await temporaryDirectory(t);
  const physical = join(container, "physical");
  const alias = join(container, "alias");
  await mkdir(physical);
  await persistWorkspaceBinding({ root: physical, binding: draft(), expected: null });
  try {
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("This Windows host does not permit junction creation.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    discoverWorkspaceBindingMarker({ startPath: alias }),
    (error) => error.code === "runa.workspace.binding_store_unsafe" ||
      error.code === "runa.workspace.root_unsafe",
  );

  const separate = await temporaryDirectory(t);
  const linkedRecord = join(separate, "workspace.json");
  await writeFile(linkedRecord, await readFile(join(physical, ".runa", "workspace.json")), { mode: 0o600 });
  await unlink(join(physical, ".runa", "workspace.json"));
  try {
    await symlink(linkedRecord, join(physical, ".runa", "workspace.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("This Windows host permits junctions but not file symlinks; marker-link coverage is exercised on Unix.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    loadWorkspaceBinding({ startPath: physical, expected: expectations() }),
    (error) => error.code === "runa.workspace.binding_store_unsafe",
  );
});

test("persistence rejects a linked metadata directory without writing into or chmodding its target", async (t) => {
  const container = await temporaryDirectory(t);
  const root = join(container, "root");
  const outside = join(container, "outside");
  await mkdir(root);
  await mkdir(outside, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(outside, 0o755);
  try {
    await symlink(outside, join(root, ".runa"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("This Windows host does not permit junction creation.");
      return;
    }
    throw error;
  }
  const modeBefore = (await lstat(outside)).mode & 0o777;
  await assert.rejects(
    persistWorkspaceBinding({ root, binding: draft(), expected: null }),
    (error) => error.code === "runa.workspace.binding_store_unsafe",
  );
  await assert.rejects(lstat(join(outside, "workspace.json")), (error) => error.code === "ENOENT");
  if (process.platform !== "win32") assert.equal((await lstat(outside)).mode & 0o777, modeBefore);
});

test("an incompatible durable record is rejected before any mutation", async (t) => {
  const root = await temporaryDirectory(t);
  const first = await persistWorkspaceBinding({ root, binding: draft(), expected: null });
  const recordPath = join(root, ".runa", "workspace.json");
  const future = { ...JSON.parse(await readFile(recordPath, "utf8")), schemaVersion: 3, minimumReaderVersion: 3 };
  await writeFile(recordPath, JSON.stringify(future), { mode: 0o600 });
  await assert.rejects(
    persistWorkspaceBinding({
      root,
      binding: draft({ generation: 1 }),
      expected: workspaceBindingCompareAndSwap(first),
    }),
    (error) => error.code === "runa.workspace.binding_corrupt",
  );
  assert.equal(JSON.parse(await readFile(recordPath, "utf8")).schemaVersion, 3);
  assert.equal(dirname(recordPath), join(root, ".runa"));
});
