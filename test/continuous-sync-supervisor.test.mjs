import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
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
  /** The bases whose commit was refused: the per-base checkpoint the coordinator marks `conflicted`. */
  refusedBases = new Set();

  constructor(generation, manifestRoot) {
    this.generation = generation;
    this.manifestRoot = manifestRoot;
  }

  async commitLocalSnapshot({ baseGeneration, manifest }) {
    if (baseGeneration !== this.generation) {
      this.refusedBases.add(baseGeneration);
      throw conflict("workspace_sync_generation_conflict");
    }
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

  async commitRefused({ baseGeneration }) {
    return this.refusedBases.has(baseGeneration);
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
  assert.fail(typeof message === "function" ? message() : message);
}

function networkFailure() {
  const error = new Error("offline");
  error.code = "ECONNRESET";
  return error;
}

// The refusal exactly as the CLI's HTTP layer raises it for a 409 (api/http.ts).
// A plain Error here classified as `paused`, so the suite could never fail the
// way production failed (ws-qa 2026-09-28).
function conflict(reason) {
  return new CunaError({
    code: "cuna.remote.conflict",
    message: "Cuna could not apply the operation because current state conflicts with it.",
    exitCode: EXIT_CODES.conflict,
    details: { http_status: 409, reason },
  });
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
  // The chunk stays unreadable for the whole first run. One failure is not
  // enough: remote changes are taken in before the start-up scan, and that scan
  // leaves `paused`, so the next pass read the chunk and finished the apply —
  // on a fast host before this wait ever saw the pause (main CI, 2026-09-23).
  authority.readFailures = Array.from({ length: 10_000 }, networkFailure);
  const first = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  try {
    await waitFor(() => first.snapshot.state === "paused" && first.snapshot.pendingRemoteChanges > 0, "pending apply was not durable");
  } finally {
    await first.stop();
  }
  assert.equal(first.snapshot.generation, 1, "the first run must not have applied the generation");
  authority.readFailures = [];

  const second = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await second.stop(); await fx.cleanup(); });
  await waitFor(() => second.snapshot.generation === 2, "durable apply did not resume");
  assert.equal(await readFile(join(fx.root, "durable.txt"), "utf8"), "resume me");
});

function sibling(path, generation) {
  const suffix = createHash("sha256").update(`${BINDING}\0${generation}\0${path}`).digest("hex").slice(0, 12);
  return `${path}.cuna-conflict-${generation}-${suffix}`;
}

// The guest's rule (PRD workspace live apply 2026-09-22 §3) from this side: a
// path changed here and in the incoming generation keeps the local bytes, puts
// the incoming ones beside it, says so, and keeps synchronizing — the local
// version is then committed on top of the incoming generation. Before, the
// supervisor stopped in `conflicted` for good and said nothing.
test("same-path divergence keeps the local edit, retains remote bytes beside it, and keeps syncing", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const desiredFiles = { "shared.txt": "remote" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  // Both edits exist before the supervisor runs (a folder edited while no CLI
  // ran, re-attaching to a Machine that moved on), so the order is fixed.
  await writeFile(join(fx.root, "shared.txt"), "local");
  authority.generation = 2;
  authority.manifestRoot = desired.manifestRoot;
  authority.pages = [remotePage(2, fx.manifest, desired)];
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness(), {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await waitFor(() => supervisor.snapshot.generation === 3, () => `the local version was not committed on top of the incoming generation: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "remote");
  assert.deepEqual(conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "local_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 2),
    generation: 2,
  }]);
  assert.deepEqual(
    authority.commits.at(-1).entries.map((entry) => entry.path).sort(),
    ["shared.txt", sibling("shared.txt", 2)].sort(),
    "the commit carries the local version and the retained remote bytes",
  );
  assert.notEqual(supervisor.snapshot.state, "conflicted");
});

// ws-qa 2026-09-28. The Machine's capture commits generation 2 while this
// folder's commit on generation 1 is in flight, so the server refuses that
// commit as stale. Only the timing differs from the test above (its control).
// Before the fix the refusal was journaled `uncertain` and the supervisor
// stopped in `conflicted` for good: no pull, no copy, no word.
test("a remote generation that lands while this folder's commit is in flight is taken in and the local edit is recommitted on top", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const desiredFiles = { "shared.txt": "remote" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  const commit = authority.commitLocalSnapshot.bind(authority);
  let raced = false;
  authority.commitLocalSnapshot = async (input) => {
    if (!raced) {
      raced = true;
      authority.generation = 2;
      authority.manifestRoot = desired.manifestRoot;
      authority.pages = [remotePage(2, fx.manifest, desired)];
    }
    return commit(input);
  };
  const watcher = new WatchHarness();
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "shared.txt"), "local");
  watcher.change("shared.txt");
  await waitFor(() => supervisor.snapshot.generation === 3, () => `the refused edit was not recommitted on top of generation 2: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(raced, true, "the first commit must have lost the race");
  assert.deepEqual([...authority.refusedBases], [1], "the commit on generation 1 was refused");
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "remote");
  assert.deepEqual(conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "local_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 2),
    generation: 2,
  }]);
  assert.deepEqual(
    authority.commits.at(-1).entries.map((entry) => entry.path).sort(),
    ["shared.txt", sibling("shared.txt", 2)].sort(),
    "the recommit carries the local version and the retained remote bytes",
  );
  assert.notEqual(supervisor.snapshot.state, "conflicted");
  assert.equal(supervisor.snapshot.pendingLocalOperations, 0);
});

// The durable state ws-qa was left in: an edit on generation 1 whose commit the
// server refused (the per-base checkpoint says `conflicted`) while the journal
// still says `uncertain`, and a Machine that published generation 2 since.
// Before the fix the re-attach took generation 2 in and then stalled at
// `pending_local_intent_changed`, because the refused edit stayed pending.
test("a re-attach after a refused commit drops the refused intent and commits the local edit on top of the newer generation", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const commit = authority.commitLocalSnapshot.bind(authority);
  // A lost answer leaves the operation `uncertain` and pending, as ws-qa's was.
  authority.commitLocalSnapshot = async () => { throw networkFailure(); };
  const watcher = new WatchHarness();
  const first = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher));
  try {
    await writeFile(join(fx.root, "shared.txt"), "local");
    watcher.change("shared.txt");
    await waitFor(
      () => first.snapshot.state === "paused" && first.snapshot.pendingLocalOperations === 1,
      () => `the first run did not leave a pending operation: ${JSON.stringify(first.snapshot)}`,
    );
  } finally {
    await first.stop();
  }
  // The rest of the live shape: the refusal recorded as the terminal state and
  // in the base-1 checkpoint, and the Machine's generation 2.
  const statePath = join(fx.state, "continuous-sync.state.json");
  const durable = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(durable.pending_local.length, 1);
  await writeFile(statePath, `${JSON.stringify({ ...durable, status: "conflicted", reason: "workspace_sync_generation_conflict" })}\n`);
  authority.refusedBases.add(1);
  authority.commitLocalSnapshot = commit;
  const desiredFiles = { "shared.txt": "remote" };
  const desired = await desiredManifest(fx, desiredFiles);
  loadChunks(authority, desired, desiredFiles);
  authority.generation = 2;
  authority.manifestRoot = desired.manifestRoot;
  authority.pages = [remotePage(2, fx.manifest, desired)];

  const conflicts = [];
  const second = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness(), {
    requireDurableState: true,
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await second.stop(); await fx.cleanup(); });
  await waitFor(() => second.snapshot.generation === 3, () => `the re-attach did not converge: ${JSON.stringify(second.snapshot)}`);
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "remote");
  assert.deepEqual(conflicts.map((conflict) => conflict.resolution), ["local_in_place"]);
  assert.deepEqual(
    authority.commits.at(-1).entries.map((entry) => entry.path).sort(),
    ["shared.txt", sibling("shared.txt", 2)].sort(),
  );
  assert.equal(second.snapshot.pendingLocalOperations, 0);
});

// The bound on the recovery above: an authority that keeps refusing the base
// as stale while its change feed never shows anything newer. Retrying cannot
// settle that, so the supervisor stops after three refusals and says why.
test("stale refusals with no newer generation in sight stop after three attempts with a typed reason", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  let attempts = 0;
  authority.commitLocalSnapshot = async ({ baseGeneration }) => {
    attempts += 1;
    authority.refusedBases.add(baseGeneration);
    throw conflict("workspace_sync_generation_conflict");
  };
  const watcher = new WatchHarness();
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "shared.txt"), "local");
  watcher.change("shared.txt");
  await waitFor(() => supervisor.snapshot.state === "conflicted", () => `the refusals never stopped: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(supervisor.snapshot.reason, "remote_advanced_unobserved");
  assert.equal(attempts, 3);
  assert.equal(supervisor.snapshot.pendingLocalOperations, 0, "a refused edit is not left pending");
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  watcher.change("shared.txt");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, 3, "a stopped supervisor sends nothing more");
});

// A sibling is written once: a replay that finds the same name holding the
// same bytes is done, and a name holding other bytes is never overwritten.
async function divergedWithExistingSibling(t, existing) {
  const fx = await fixture(t, { "shared.txt": "base" });
  const desiredFiles = { "shared.txt": "remote" };
  const desired = await desiredManifest(fx, desiredFiles);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  loadChunks(authority, desired, desiredFiles);
  await writeFile(join(fx.root, "shared.txt"), "local");
  await writeFile(join(fx.root, sibling("shared.txt", 2)), existing);
  authority.generation = 2;
  authority.manifestRoot = desired.manifestRoot;
  authority.pages = [remotePage(2, fx.manifest, desired)];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  return { fx, supervisor };
}

test("a replayed conflict sibling holding the same bytes is accepted and syncing continues", async (t) => {
  const { fx, supervisor } = await divergedWithExistingSibling(t, "remote");
  await waitFor(() => supervisor.snapshot.generation === 3, () => `the replayed sibling stopped synchronization: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "remote");
});

test("a conflict sibling name holding other bytes is never overwritten", async (t) => {
  const { fx, supervisor } = await divergedWithExistingSibling(t, "someone else's");
  await waitFor(() => supervisor.snapshot.state === "conflicted", () => `the collision was not refused: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(supervisor.snapshot.reason, "conflict_retention_collision");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "someone else's");
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "local");
});

// qa6 witness 2026-09-22, step 4. This folder commits README (gen N); the
// Machine held its own unsaved edit, kept it (the guest rule), and captured it
// as gen N+1. Taking N+1 is right — it is the Machine's resolution — but it
// replaced the folder's bytes with no copy and no word. Now they are kept
// beside the file and the conflict is announced.
test("a Machine-resolved conflict returning right after this folder's commit keeps the local bytes beside the file", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "shared.txt"), "local");
  watcher.change("shared.txt");
  await waitFor(() => supervisor.snapshot.generation === 2, "the local edit was not committed");
  const committed = authority.commits.at(-1);

  const machineFiles = { "shared.txt": "machine" };
  const machine = await desiredManifest(fx, machineFiles);
  loadChunks(authority, machine, machineFiles);
  authority.generation = 3;
  authority.manifestRoot = machine.manifestRoot;
  authority.pages = [remotePage(3, committed, machine)];
  await waitFor(() => supervisor.snapshot.generation >= 3, "the Machine generation was not taken in");

  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "machine", "the Machine's resolution is accepted");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "local", "the folder's bytes are kept");
  assert.deepEqual(conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "remote_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 2),
    generation: 3,
  }]);
});

// Control: the same incoming replacement, after a commit of this folder that
// did not carry the path, is an ordinary remote edit. No copy, no notice.
test("control: a remote edit to a path this folder's last commit did not carry replaces it without a sibling", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "other.txt"), "local");
  watcher.change("other.txt");
  await waitFor(() => supervisor.snapshot.generation === 2, "the local edit was not committed");
  const committed = authority.commits.at(-1);

  const machineFiles = { "shared.txt": "machine", "other.txt": "local" };
  const machine = await desiredManifest(fx, machineFiles);
  loadChunks(authority, machine, machineFiles);
  authority.generation = 3;
  authority.manifestRoot = machine.manifestRoot;
  authority.pages = [remotePage(3, committed, machine)];
  await waitFor(() => supervisor.snapshot.generation === 3, "the Machine generation was not taken in");

  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "machine");
  const names = await (await import("node:fs/promises")).readdir(fx.root);
  assert.deepEqual(names.filter((name) => name.includes(".cuna-conflict-")), []);
  assert.deepEqual(conflicts, []);
  assert.equal(authority.commits.length, 1, "an ordinary remote edit commits nothing back");
});

// Live apply PRD R-3 (ws-qa report Q2). This folder commits shared.txt as
// generation 2 and another path as generation 3 before the Machine captures.
// The Machine applies both (a capture on an older base is refused), keeps its
// own shared.txt against generation 2, and captures it as generation 4. Before
// the fix only the directly preceding commit (3) was consulted, so the folder's
// shared.txt was replaced with no copy and no word.
test("a Machine-resolved conflict against an earlier one of this folder's consecutive commits keeps the local bytes beside the file", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base", "other.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "shared.txt"), "local");
  watcher.change("shared.txt");
  await waitFor(() => supervisor.snapshot.generation === 2, "the first local edit was not committed");
  await writeFile(join(fx.root, "other.txt"), "local other");
  watcher.change("other.txt");
  await waitFor(() => supervisor.snapshot.generation === 3, "the second local edit was not committed");
  const committed = authority.commits.at(-1);

  const machineFiles = { "shared.txt": "machine", "other.txt": "local other" };
  const machine = await desiredManifest(fx, machineFiles);
  loadChunks(authority, machine, machineFiles);
  authority.generation = 4;
  authority.manifestRoot = machine.manifestRoot;
  authority.pages = [remotePage(4, committed, machine)];
  await waitFor(() => supervisor.snapshot.generation >= 4, "the Machine generation was not taken in");

  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "machine", "the Machine's resolution is accepted");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 3)), "utf8"), "local", "the folder's bytes are kept");
  assert.deepEqual(conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "remote_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 3),
    generation: 4,
  }]);
});

// Control for the rule above: a Machine generation taken in closes the record
// of this folder's commits (its capture already returned every conflict against
// them), so a later Machine edit of shared.txt is an ordinary remote edit even
// though this folder committed shared.txt earlier. No copy, no notice.
test("control: once a Machine generation was taken in, a later replacement of a path this folder committed before it is an ordinary remote edit", async (t) => {
  const fx = await fixture(t, { "shared.txt": "base", "other.txt": "base" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const watcher = new WatchHarness();
  const conflicts = [];
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, watcher, {
    onConflict: (conflict) => conflicts.push(conflict),
  }));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  await writeFile(join(fx.root, "shared.txt"), "local");
  watcher.change("shared.txt");
  await waitFor(() => supervisor.snapshot.generation === 2, "the local edit was not committed");

  const machine3Files = { "shared.txt": "local", "other.txt": "machine other" };
  const machine3 = await desiredManifest(fx, machine3Files);
  loadChunks(authority, machine3, machine3Files);
  authority.generation = 3;
  authority.manifestRoot = machine3.manifestRoot;
  authority.pages = [remotePage(3, authority.commits.at(-1), machine3)];
  await waitFor(() => supervisor.snapshot.generation === 3, "the first Machine generation was not taken in");

  await writeFile(join(fx.root, "third.txt"), "local third");
  watcher.change("third.txt");
  await waitFor(() => supervisor.snapshot.generation === 4, "the later local edit was not committed");
  const committed = authority.commits.at(-1);
  const machine5Files = { "shared.txt": "machine", "other.txt": "machine other", "third.txt": "local third" };
  const machine5 = await desiredManifest(fx, machine5Files);
  loadChunks(authority, machine5, machine5Files);
  authority.generation = 5;
  authority.manifestRoot = machine5.manifestRoot;
  authority.pages = [remotePage(5, committed, machine5)];
  await waitFor(() => supervisor.snapshot.generation === 5, "the second Machine generation was not taken in");

  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "machine");
  const names = await (await import("node:fs/promises")).readdir(fx.root);
  assert.deepEqual(names.filter((name) => name.includes(".cuna-conflict-")), []);
  assert.deepEqual(conflicts, []);
});

test("a start that must resume from durable state refuses to create one", async (t) => {
  const fx = await fixture(t);
  t.after(() => fx.cleanup());
  // A build that ignores the option starts a live supervisor; stop it so the
  // failure is this assertion rather than a process that never exits.
  const started = ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, new MemoryAuthority(1, fx.manifest.manifestRoot), new WatchHarness(), {
    requireDurableState: true,
  })).then(async (supervisor) => { await supervisor.stop(); return supervisor; });
  await assert.rejects(started, (error) => error.details?.reason === "durable_state_missing");
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
    (error) => error.code === "cuna.workspace.workspace_busy",
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
