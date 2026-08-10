import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ContinuousWorkspaceSyncSupervisor,
} from "../dist/sync/index.js";
import {
  compileExclusionPolicy,
  createWorkspaceManifest,
} from "../dist/workspace/index.js";
import {
  manifestEntryForPublicProtocol,
} from "../dist/sync/workspace-sync-protocol.js";

const BINDING = "11111111-1111-4111-8111-111111111111";
const SYNC = "22222222-2222-4222-8222-222222222222";
const NEXT_SYNC = "33333333-3333-4333-8333-333333333333";
const capabilities = Object.freeze({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  caseSensitive: process.platform !== "win32",
  unicodeNormalization: "nfc",
  symlinks: process.platform !== "win32",
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

class WatchHarness {
  onEvent;
  onError;
  closed = false;

  factory = async ({ onEvent, onError }) => {
    this.onEvent = onEvent;
    this.onError = onError;
    return Object.freeze({ close: () => { this.closed = true; } });
  };

  change(path) { this.onEvent?.({ kind: "change", path }); }
  overflow() { this.onEvent?.({ kind: "overflow" }); }
}

class MemoryAuthority {
  generation;
  manifestRoot;
  pages = [];
  chunks = new Map();
  commits = [];
  listFailures = [];
  readFailures = [];
  reconcileFailure;
  reconcileCalls = 0;

  constructor(generation, manifestRoot) {
    this.generation = generation;
    this.manifestRoot = manifestRoot;
  }

  async commitLocalSnapshot({ baseGeneration, manifest }) {
    if (baseGeneration !== this.generation) throw conflict("workspace_sync_generation_conflict");
    this.generation += 1;
    this.manifestRoot = manifest.manifestRoot;
    this.commits.push(manifest);
    return Object.freeze({ syncId: NEXT_SYNC, generation: this.generation, manifestRoot: manifest.manifestRoot });
  }

  async listChanges({ afterGeneration }) {
    const failure = this.listFailures.shift();
    if (failure !== undefined) throw failure;
    const page = this.pages[0] ?? { selected_protocol: 2, items: [], next_cursor: null };
    return Object.freeze({
      ...page,
      items: Object.freeze(page.items.filter((item) => item.generation > afterGeneration)),
    });
  }

  async readChunk({ digest, byteLength }) {
    const failure = this.readFailures.shift();
    if (failure !== undefined) throw failure;
    const value = this.chunks.get(digest);
    if (value === undefined || value.byteLength !== byteLength) throw new Error("chunk unavailable");
    return value;
  }

  async reconcile({ generation, manifestRoot }) {
    this.reconcileCalls += 1;
    if (this.reconcileFailure !== undefined) throw this.reconcileFailure;
    return Object.freeze({
      status: generation === this.generation && manifestRoot === this.manifestRoot
        ? "converged"
        : "reconciliation_required",
      generation: this.generation,
      manifestRoot: this.manifestRoot,
    });
  }
}

async function fixture(t, files = {}) {
  const base = await mkdtemp(join(tmpdir(), "cuna-continuous-sync-"));
  const root = join(base, "workspace");
  const state = join(base, "state");
  await mkdir(root);
  await mkdir(state);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  void t;
  const policy = compileExclusionPolicy([], capabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities });
  return {
    base, root, state, policy, manifest,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

function supervisorInput(fx, authority, watchHarness, overrides = {}) {
  return {
    bindingId: BINDING,
    bindingGeneration: 1,
    syncId: SYNC,
    initialGeneration: 1,
    initialManifestRoot: fx.manifest.manifestRoot,
    initialManifest: fx.manifest,
    canonicalRoot: fx.root,
    stateDirectory: fx.state,
    policy: fx.policy,
    filesystemCapabilities: capabilities,
    authority,
    watchFactory: watchHarness.factory,
    debounceMs: 2,
    remotePollIntervalMs: 5,
    reconciliationIntervalMs: 60_000,
    ...overrides,
  };
}

function remotePage(generation, before, after) {
  const prior = new Map(before.entries.map((entry) => [entry.path, entry]));
  const current = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...prior.keys(), ...current.keys()])].sort();
  const items = [{
    generation,
    operation: "revision",
    path: null,
    entry: null,
    manifest_root: after.manifestRoot,
    exclusion_policy_digest: after.policyDigest,
    committed_at: "2026-08-09T12:00:00.000Z",
    minimum_reader: 1,
    minimum_writer: 1,
  }];
  for (const path of paths) {
    const left = prior.get(path);
    const right = current.get(path);
    if (entryIdentity(left) === entryIdentity(right)) continue;
    items.push({
      generation,
      operation: right === undefined ? "delete" : "upsert",
      path,
      entry: right === undefined ? null : manifestEntryForPublicProtocol(right),
      manifest_root: after.manifestRoot,
      exclusion_policy_digest: after.policyDigest,
      committed_at: "2026-08-09T12:00:00.000Z",
      minimum_reader: 1,
      minimum_writer: 1,
    });
  }
  return Object.freeze({ selected_protocol: 2, items: Object.freeze(items), next_cursor: null });
}

function entryIdentity(entry) {
  return entry === undefined ? undefined : JSON.stringify(manifestEntryForPublicProtocol(entry));
}

async function desiredManifest(fx, files) {
  const desired = join(fx.base, `desired-${Math.random().toString(16).slice(2)}`);
  await mkdir(desired);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(desired, path)), { recursive: true });
    await writeFile(join(desired, path), content);
  }
  return createWorkspaceManifest({ root: desired, policy: fx.policy, capabilities });
}

function loadChunks(authority, manifest, files) {
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const content = Buffer.from(files[entry.path]);
    let offset = 0;
    for (const chunk of entry.chunks) {
      const bytes = content.subarray(offset, offset + chunk.byteLength);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), chunk.digest);
      authority.chunks.set(chunk.digest, bytes);
      offset += chunk.byteLength;
    }
  }
}

async function waitFor(predicate, message, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function networkFailure() {
  const error = new Error("offline");
  error.code = "ECONNRESET";
  return error;
}

function conflict(reason) {
  const error = new Error(reason);
  error.code = "runa.remote.conflict";
  error.exitCode = 6;
  return error;
}

test("continuous supervisor uploads stable local edits and advances only an authoritative receipt", async (t) => {
  const fx = await fixture(t);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  supervisor.subscribe(() => { throw new Error("observer failure must remain isolated"); });
  await writeFile(join(fx.root, "local.txt"), "local edit");
  watcher.change("local.txt");
  await waitFor(() => supervisor.snapshot.generation === 2, "local edit was not committed");
  assert.equal(authority.commits.length, 1);
  assert.equal(supervisor.snapshot.pendingLocalOperations, 0);
  assert.equal(authority.commits[0].entries[0].path, "local.txt");
});

test("ordered remote upserts apply atomically and converge byte-for-byte", async (t) => {
  const fx = await fixture(t);
  const desiredFiles = { "remote.txt": "remote edit" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(2, desired.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  authority.pages = [remotePage(2, fx.manifest, desired)];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await waitFor(() => supervisor.snapshot.generation === 2, "remote edit was not applied");
  assert.equal(await readFile(join(fx.root, "remote.txt"), "utf8"), "remote edit");
  assert.equal(supervisor.snapshot.manifestRoot, desired.manifestRoot);
});

test("rename-as-delete-plus-create and directory delete ordering preserve the canonical tree", async (t) => {
  const fx = await fixture(t, { "old/nested.txt": "content" });
  const desiredFiles = { "new/nested.txt": "content" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(2, desired.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  authority.pages = [remotePage(2, fx.manifest, desired)];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await waitFor(() => supervisor.snapshot.generation === 2, "rename/delete generation did not apply");
  await assert.rejects(readFile(join(fx.root, "old/nested.txt")), (error) => error.code === "ENOENT");
  assert.equal(await readFile(join(fx.root, "new/nested.txt"), "utf8"), "content");
});

test("offline pause, explicit reconciliation, and reconnect resume without losing the remote edit", async (t) => {
  const fx = await fixture(t);
  const desiredFiles = { "after-reconnect.txt": "online" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  authority.listFailures.push(networkFailure());
  const watcher = new WatchHarness();
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await waitFor(() => supervisor.snapshot.state === "paused", "offline transition was not visible");
  authority.generation = 2;
  authority.manifestRoot = desired.manifestRoot;
  loadChunks(authority, desired, desiredFiles);
  authority.pages = [remotePage(2, fx.manifest, desired)];
  supervisor.requestReconciliation("network_restored");
  await waitFor(() => supervisor.snapshot.generation === 2, "reconnect did not resume");
  assert.equal(await readFile(join(fx.root, "after-reconnect.txt"), "utf8"), "online");
});

test("a crash-like dependency failure leaves a durable remote apply that resumes after restart", async (t) => {
  const fx = await fixture(t);
  const desiredFiles = { "durable.txt": "resume me" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(2, desired.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  authority.pages = [remotePage(2, fx.manifest, desired)];
  authority.readFailures.push(networkFailure());
  const first = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  await waitFor(() => first.snapshot.state === "paused" && first.snapshot.pendingRemoteChanges > 0, "pending apply was not durable");
  await first.stop();

  const second = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await second.stop(); await fx.cleanup(); });
  await waitFor(() => second.snapshot.generation === 2, "durable apply did not resume");
  assert.equal(await readFile(join(fx.root, "durable.txt"), "utf8"), "resume me");
});

test("same-path divergence retains remote bytes and never overwrites the local edit", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const desiredFiles = { "shared.txt": "remote" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await waitFor(() => supervisor.snapshot.state === "live_unverified", "initial live state was not established");
  await writeFile(join(fx.root, "shared.txt"), "local");
  authority.generation = 2;
  authority.manifestRoot = desired.manifestRoot;
  authority.pages = [remotePage(2, fx.manifest, desired)];
  await waitFor(() => supervisor.snapshot.state === "conflicted", "divergence was not classified");
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  const names = (await import("node:fs/promises")).readdir(fx.root);
  assert.ok((await names).some((name) => name.startsWith("shared.txt.cuna-conflict-2-")));
});

test("generation gaps, traversal paths, and symlink swaps fail closed", async (t) => {
  const gap = await fixture(t);
  const gapAuthority = new MemoryAuthority(3, gap.manifest.manifestRoot);
  gapAuthority.pages = [{ selected_protocol: 2, items: [{
    generation: 3, operation: "revision", path: null, entry: null,
    manifest_root: gap.manifest.manifestRoot, exclusion_policy_digest: gap.manifest.policyDigest,
    committed_at: "2026-08-09T12:00:00.000Z", minimum_reader: 1, minimum_writer: 1,
  }], next_cursor: null }];
  const gapSupervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(gap, gapAuthority, new WatchHarness()));
  t.after(async () => { await gapSupervisor.stop(); await gap.cleanup(); });
  await waitFor(() => gapSupervisor.snapshot.state === "conflicted", "generation gap did not stop apply");

  const traversal = await fixture(t);
  const traversalAuthority = new MemoryAuthority(2, traversal.manifest.manifestRoot);
  traversalAuthority.pages = [{ selected_protocol: 2, items: [{
    generation: 2, operation: "delete", path: "../escape", entry: null,
    manifest_root: traversal.manifest.manifestRoot, exclusion_policy_digest: traversal.manifest.policyDigest,
    committed_at: "2026-08-09T12:00:00.000Z", minimum_reader: 1, minimum_writer: 1,
  }], next_cursor: null }];
  const traversalSupervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(traversal, traversalAuthority, new WatchHarness()));
  t.after(async () => { await traversalSupervisor.stop(); await traversal.cleanup(); });
  await waitFor(() => traversalSupervisor.snapshot.state === "recovery_required", "traversal path did not fail closed");

  if (process.platform !== "win32") {
    const swap = await fixture(t, { "safe/file.txt": "base" });
    const outside = join(swap.base, "outside");
    await mkdir(outside);
    await rm(join(swap.root, "safe"), { recursive: true });
    await symlink(outside, join(swap.root, "safe"), "dir");
    const swapAuthority = new MemoryAuthority(2, swap.manifest.manifestRoot);
    swapAuthority.pages = [{ selected_protocol: 2, items: [{
      generation: 2, operation: "delete", path: "safe/file.txt", entry: null,
      manifest_root: swap.manifest.manifestRoot, exclusion_policy_digest: swap.manifest.policyDigest,
      committed_at: "2026-08-09T12:00:00.000Z", minimum_reader: 1, minimum_writer: 1,
    }], next_cursor: null }];
    const swapSupervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(swap, swapAuthority, new WatchHarness()));
    t.after(async () => { await swapSupervisor.stop(); await swap.cleanup(); });
    await waitFor(() => swapSupervisor.snapshot.state === "recovery_required", "symlink swap did not fail closed");
    await writeFile(join(outside, "canary"), "safe");
    assert.equal(await readFile(join(outside, "canary"), "utf8"), "safe");
  }
});

test("queue overflow, disk exhaustion, watcher overflow, and a second writer remain explicit", async (t) => {
  const fx = await fixture(t);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, { maximumPendingOperations: 1 }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "one.txt"), "1");
  await writeFile(join(fx.root, "two.txt"), "2");
  watcher.change("one.txt");
  await waitFor(() => supervisor.snapshot.state === "paused" && supervisor.snapshot.reason === "operation_limit", "operation bound did not pause admission");

  await assert.rejects(
    ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness(), { maximumPendingOperations: 1 })),
    (error) => error.code === "runa.workspace.workspace_busy",
  );

  const disk = await fixture(t);
  const diskAuthority = new MemoryAuthority(1, disk.manifest.manifestRoot);
  diskAuthority.commitLocalSnapshot = async () => {
    const error = new Error("disk full");
    error.code = "ENOSPC";
    throw error;
  };
  const diskWatcher = new WatchHarness();
  const diskSupervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(disk, diskAuthority, diskWatcher));
  t.after(async () => { await diskSupervisor.stop(); await disk.cleanup(); });
  await writeFile(join(disk.root, "disk.txt"), "full");
  diskWatcher.change("disk.txt");
  await waitFor(() => diskSupervisor.snapshot.state === "paused" && diskSupervisor.snapshot.reason === "disk_exhausted", "disk full was not classified");

  const overflow = await fixture(t);
  const overflowAuthority = new MemoryAuthority(1, overflow.manifest.manifestRoot);
  overflowAuthority.reconcileFailure = networkFailure();
  const overflowWatcher = new WatchHarness();
  const overflowSupervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(overflow, overflowAuthority, overflowWatcher));
  t.after(async () => { await overflowSupervisor.stop(); await overflow.cleanup(); });
  overflowWatcher.overflow();
  await waitFor(() => overflowAuthority.reconcileCalls > 0 && overflowSupervisor.snapshot.dirty, "watcher overflow did not force reconciliation");
});
