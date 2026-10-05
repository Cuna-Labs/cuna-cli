import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CunaError, EXIT_CODES } from "../dist/core/errors.js";
import { ContinuousWorkspaceSyncSupervisor, DurableSyncJournal } from "../dist/sync/index.js";
import { manifestEntryForPublicProtocol } from "../dist/sync/workspace-sync-protocol.js";
import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";

// R7.3, BL-7 (LIVE_RUNTIME 2026-10-03): a folder's sync state stopped at
// recovery_required, re-attaching did not move it, and the CLI had no way to.
// These drive the real supervisor with the explicit recovery input
// (`recoverStop`) against folders left stopped the ways a run leaves them; each
// control is the same folder started without it, which keeps the stop.

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
  factory = async ({ onEvent }) => {
    this.onEvent = onEvent;
    return Object.freeze({ close: () => undefined });
  };

  change(path) { this.onEvent?.({ kind: "change", path }); }
}

/** The authority of test/continuous-sync-supervisor.test.mjs: commits on the head only, reconciles honestly. */
class MemoryAuthority {
  generation;
  manifestRoot;
  pages = [];
  chunks = new Map();
  commits = [];
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
    const page = this.pages[0] ?? { selected_protocol: 2, items: [], next_cursor: null };
    return Object.freeze({ ...page, items: Object.freeze(page.items.filter((item) => item.generation > afterGeneration)) });
  }

  async readChunk({ digest, byteLength }) {
    const value = this.chunks.get(digest);
    if (value === undefined || value.byteLength !== byteLength) throw new Error("chunk unavailable");
    return value;
  }

  async commitRefused({ baseGeneration }) {
    return this.refusedBases.has(baseGeneration);
  }

  async reconcile({ generation, manifestRoot }) {
    return Object.freeze({
      status: generation === this.generation && manifestRoot === this.manifestRoot ? "converged" : "reconciliation_required",
      generation: this.generation,
      manifestRoot: this.manifestRoot,
    });
  }
}

function conflict(reason) {
  return new CunaError({
    code: "cuna.remote.conflict",
    message: "Cuna could not apply the operation because current state conflicts with it.",
    exitCode: EXIT_CODES.conflict,
    details: { http_status: 409, reason },
  });
}

async function fixture(t, files = {}) {
  const base = await mkdtemp(join(tmpdir(), "cuna-sync-recovery-"));
  const root = join(base, "workspace");
  const state = join(base, "state");
  await mkdir(root);
  await mkdir(state);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const policy = compileExclusionPolicy([], capabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities });
  const fx = { base, root, state, policy, manifest, supervisors: [] };
  // One hook: `t.after` runs hooks in registration order, so a directory
  // removed by an earlier hook would still be written by a running supervisor.
  t.after(async () => {
    for (const supervisor of fx.supervisors) await supervisor.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return fx;
}

function supervisorInput(fx, authority, watcher, overrides = {}) {
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
    watchFactory: watcher.factory,
    debounceMs: 2,
    remotePollIntervalMs: 5,
    reconciliationIntervalMs: 60_000,
    ...overrides,
  };
}

/** Starts a supervisor the fixture stops before its directory is removed. */
async function started(fx, input) {
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(input);
  fx.supervisors.push(supervisor);
  return supervisor;
}

async function waitFor(predicate, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === "function" ? message() : message);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sibling(path, generation) {
  return `${path}.cuna-conflict-${generation}-${sha256(`${BINDING}\0${generation}\0${path}`).slice(0, 12)}`;
}

function statePath(fx) {
  return join(fx.state, "continuous-sync.state.json");
}

/**
 * A folder whose last run synced, then stopped with `status`/`reason` as the
 * loop records a stop, and ended. `patch` adds the rest of what that run left.
 */
async function folderLeftStopped(fx, authority, status, reason, patch = {}) {
  const run = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, authority, new WatchHarness()));
  try {
    await waitFor(() => run.snapshot.state === "live_unverified", () => `never live: ${JSON.stringify(run.snapshot)}`);
  } finally {
    await run.stop();
  }
  const state = JSON.parse(await readFile(statePath(fx), "utf8"));
  await writeFile(statePath(fx), `${JSON.stringify({ ...state, status, dirty: true, reason, ...patch })}\n`);
}

function remotePage(generation, before, after) {
  const prior = new Map(before.entries.map((entry) => [entry.path, entry]));
  const current = new Map(after.entries.map((entry) => [entry.path, entry]));
  const shared = {
    manifest_root: after.manifestRoot,
    exclusion_policy_digest: after.policyDigest,
    committed_at: "2026-10-03T12:00:00.000Z",
    minimum_reader: 1,
    minimum_writer: 1,
  };
  const items = [{ generation, operation: "revision", path: null, entry: null, ...shared }];
  for (const path of [...new Set([...prior.keys(), ...current.keys()])].sort()) {
    const left = prior.get(path);
    const right = current.get(path);
    if (JSON.stringify(left && manifestEntryForPublicProtocol(left)) === JSON.stringify(right && manifestEntryForPublicProtocol(right))) continue;
    items.push({ generation, operation: right === undefined ? "delete" : "upsert", path, entry: right === undefined ? null : manifestEntryForPublicProtocol(right), ...shared });
  }
  return Object.freeze({ selected_protocol: 2, items: Object.freeze(items), next_cursor: null });
}

/** The Machine's generation `generation`: `files` as its tree, with their bytes readable. */
async function machineGeneration(fx, authority, generation, files) {
  const directory = join(fx.base, `machine-${generation}`);
  await mkdir(directory);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const manifest = await createWorkspaceManifest({ root: directory, policy: fx.policy, capabilities });
  for (const [, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    authority.chunks.set(sha256(bytes), bytes);
  }
  authority.generation = generation;
  authority.manifestRoot = manifest.manifestRoot;
  authority.pages = [remotePage(generation, fx.manifest, manifest)];
  return manifest;
}

// ---------------------------------------------------------------------------
// 1. A stop the Machine's refusal left. `test/continuous-sync-supervisor.test.mjs`
//    ("control: a new run keeps a stop the Machine's refusal left") shows a
//    plain restart keeps it; nothing took it up before this.

test("R7.3: an explicit recovery takes up a folder left conflicted by the Machine's refusal and syncs it again", async (t) => {
  const fx = await fixture(t);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  await folderLeftStopped(fx, authority, "conflicted", "workspace_sync_generation_conflict");
  const watcher = new WatchHarness();
  const seen = [];
  const next = await started(fx, supervisorInput(fx, authority, watcher, { requireDurableState: true, recoverStop: true }));
  next.subscribe((snapshot) => seen.push(snapshot.state));
  await writeFile(join(fx.root, "after-recovery.txt"), "written after recovery");
  watcher.change("after-recovery.txt");
  await waitFor(() => next.snapshot.generation === 2 && next.snapshot.state === "live_unverified",
    () => `the recovered folder never synced: ${JSON.stringify(next.snapshot)}`);
  assert.deepEqual(authority.commits.at(-1).entries.map((entry) => entry.path), ["after-recovery.txt"]);
  assert.equal(seen.includes("conflicted"), false, "the old stop was announced as the recovered run's own");
});

test("R7.3 control: the same conflicted folder started without the recovery flag stays stopped", async (t) => {
  const fx = await fixture(t);
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  await folderLeftStopped(fx, authority, "conflicted", "workspace_sync_generation_conflict");
  const watcher = new WatchHarness();
  const next = await started(fx, supervisorInput(fx, authority, watcher, { requireDurableState: true }));
  await writeFile(join(fx.root, "after-recovery.txt"), "written after recovery");
  watcher.change("after-recovery.txt");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(next.snapshot.state, "conflicted");
  assert.equal(next.snapshot.reason, "workspace_sync_generation_conflict");
  assert.equal(authority.commits.length, 0);
});

// ---------------------------------------------------------------------------
// 2. recovery_required / pending_local_intent_changed with a queued operation:
//    the run recorded an edit (journal `queued`, never sent), the folder was
//    edited again, and every later scan refused the changed intent.

async function folderWithStaleQueuedIntent(t) {
  const fx = await fixture(t, { "main.js": "console.log(1);\n" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  const operationId = randomUUID();
  const first = Buffer.from("first edit\n");
  await folderLeftStopped(fx, authority, "recovery_required", "pending_local_intent_changed", {
    pending_local: [{
      operationId, path: "notes.md", kind: "create", baseGeneration: 1, fingerprint: sha256(first), byteLength: first.byteLength,
    }],
  });
  const journal = await DurableSyncJournal.open({
    directory: join(fx.state, "operation-journal"), bindingId: BINDING, bindingGeneration: 1,
    ownerId: `continuous-sync:${process.pid}:${randomUUID()}`,
  });
  try {
    await journal.append({ operationId, baseGeneration: 1, digest: sha256(first), byteLength: first.byteLength });
  } finally {
    await journal.close();
  }
  // The folder's edit as it stands now: not what the queued intent recorded.
  await writeFile(join(fx.root, "notes.md"), "second edit\n");
  return { fx, authority, operationId };
}

async function latestJournalState(fx, operationId) {
  const journal = await DurableSyncJournal.open({
    directory: join(fx.state, "operation-journal"), bindingId: BINDING, bindingGeneration: 1,
    ownerId: `continuous-sync:${process.pid}:${randomUUID()}`,
  });
  try {
    return journal.records.filter((record) => record.operationId === operationId).at(-1)?.state;
  } finally {
    await journal.close();
  }
}

test("R7.3: a folder left at recovery_required with a queued, changed intent recovers and commits the folder's current edit", async (t) => {
  const { fx, authority, operationId } = await folderWithStaleQueuedIntent(t);
  const next = await started(fx, supervisorInput(fx, authority, new WatchHarness(), { requireDurableState: true, recoverStop: true }));
  await waitFor(() => next.snapshot.generation === 2 && next.snapshot.state === "live_unverified" && !next.snapshot.dirty,
    () => `the stuck folder never committed: ${JSON.stringify(next.snapshot)}`);
  const committed = authority.commits.at(-1).entries.find((entry) => entry.path === "notes.md");
  assert.ok(committed, "the folder's edit was not committed");
  assert.equal(committed.chunks[0].digest, sha256(Buffer.from("second edit\n")), "the commit carries the folder's bytes, not the stale intent");
  assert.equal(await readFile(join(fx.root, "notes.md"), "utf8"), "second edit\n");
  assert.equal(next.snapshot.pendingLocalOperations, 0);
  await next.stop();
  assert.equal(await latestJournalState(fx, operationId), "conflicted", "the unsent intent is closed, never sent later");
});

test("R7.3 control: the same folder started without the recovery flag stays at recovery_required and sends nothing", async (t) => {
  const { fx, authority, operationId } = await folderWithStaleQueuedIntent(t);
  const next = await started(fx, supervisorInput(fx, authority, new WatchHarness(), { requireDurableState: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(next.snapshot.state, "recovery_required");
  assert.equal(next.snapshot.reason, "pending_local_intent_changed");
  assert.equal(next.snapshot.pendingLocalOperations, 1);
  assert.equal(authority.commits.length, 0);
  await next.stop();
  assert.equal(await latestJournalState(fx, operationId), "queued");
});

// ---------------------------------------------------------------------------
// 3. Both sides changed one file while the folder was stopped. Recovery keeps
//    both: the local bytes in place, the Machine's beside them.

async function folderStoppedWhileBothSidesEdited(t) {
  const fx = await fixture(t, { "shared.txt": "base\n", "main.js": "console.log(1);\n" });
  const authority = new MemoryAuthority(1, fx.manifest.manifestRoot);
  await folderLeftStopped(fx, authority, "conflicted", "workspace_sync_generation_conflict");
  await writeFile(join(fx.root, "shared.txt"), "edited here\n");
  await machineGeneration(fx, authority, 2, { "shared.txt": "edited on the Machine\n", "main.js": "console.log(1);\n" });
  return { fx, authority };
}

test("R7.3: recovery of a path changed on both sides keeps the local bytes in place and the Machine's beside them", async (t) => {
  const { fx, authority } = await folderStoppedWhileBothSidesEdited(t);
  const conflicts = [];
  const next = await started(fx, supervisorInput(fx, authority, new WatchHarness(), {
    requireDurableState: true, recoverStop: true, onConflict: (conflict) => conflicts.push(conflict),
  }));
  await waitFor(() => next.snapshot.generation === 3 && next.snapshot.state === "live_unverified",
    () => `the recovered folder never committed on top of generation 2: ${JSON.stringify(next.snapshot)}`);
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "edited here\n", "the local bytes were overwritten");
  assert.equal(await readFile(join(fx.root, sibling("shared.txt", 2)), "utf8"), "edited on the Machine\n");
  assert.deepEqual(conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "local_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 2),
    generation: 2,
  }]);
  assert.deepEqual(
    authority.commits.at(-1).entries.map((entry) => entry.path).sort(),
    ["main.js", "shared.txt", sibling("shared.txt", 2)].sort(),
    "the commit carries both versions",
  );
});

test("R7.3 control: the same both-sides folder started without the recovery flag stays stopped and writes nothing", async (t) => {
  const { fx, authority } = await folderStoppedWhileBothSidesEdited(t);
  const next = await started(fx, supervisorInput(fx, authority, new WatchHarness(), { requireDurableState: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(next.snapshot.state, "conflicted");
  assert.equal(next.snapshot.generation, 1);
  assert.equal(await readFile(join(fx.root, "shared.txt"), "utf8"), "edited here\n");
  assert.equal(await exists(join(fx.root, sibling("shared.txt", 2))), false);
  assert.equal(authority.commits.length, 0);
});
