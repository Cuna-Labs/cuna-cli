import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ContinuousWorkspaceSyncSupervisor,
  computeWorkspaceManifestRoot,
  manifestEntryForPublicProtocol,
  resumeContinuousWorkspaceSync,
  startContinuousWorkspaceSync,
  synchronizeLocalWorkspace,
} from "../dist/sync/index.js";
import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";

// BL-7, 2026-10-03, Machine 45eebce7: a pytest run on the Machine wrote
// `__pycache__` and `.pytest_cache` next to the results it produced. The
// Machine's capture committed them as generation 3; the CLI refused that
// generation as `remote_excluded_path` and stopped syncing in both directions,
// so the results never came back. These tests drive the CLI's real supervisor
// against a server whose generations carry exactly such paths.

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The server's manifest root, written from the database's canonical entry
 * (0060 put_workspace_sync_manifest_page) rather than taken from the CLI, so a
 * root the CLI computes and this one agreeing is evidence, not a tautology.
 */
function serverRoot(entries) {
  return sha256([...entries]
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
    .map((entry) => sha256(JSON.stringify({
      path: entry.path,
      kind: entry.kind,
      byte_length: entry.byte_length,
      executable: entry.executable,
      chunks: entry.chunks.map((chunk) => ({ digest: chunk.digest, byte_length: chunk.byte_length })),
      link_target: entry.link_target,
    })))
    .join(""));
}

function fileEntry(path, content) {
  const bytes = Buffer.from(content);
  return Object.freeze({
    path, kind: "file", byte_length: bytes.byteLength, executable: false,
    chunks: Object.freeze([Object.freeze({ digest: sha256(bytes), byte_length: bytes.byteLength })]), link_target: null,
  });
}

function directoryEntry(path) {
  return Object.freeze({ path, kind: "directory", byte_length: 0, executable: false, chunks: Object.freeze([]), link_target: null });
}

/**
 * A server holding generations as wire entries. Each commit is refused unless
 * its manifest roots the way the server roots it, as the database refuses a
 * page whose digest it cannot reproduce.
 */
class GenerationServer {
  generations = new Map();
  chunks = new Map();
  head;
  policyDigest;
  carriedAtCommit = [];

  constructor(generation, entries, policyDigest) {
    this.policyDigest = policyDigest;
    this.generations.set(generation, Object.freeze([...entries]));
    this.head = generation;
  }

  publish(entries, contents = {}) {
    for (const [path, content] of Object.entries(contents)) {
      const bytes = Buffer.from(content);
      this.chunks.set(sha256(bytes), bytes);
      void path;
    }
    this.head += 1;
    this.generations.set(this.head, Object.freeze([...entries]));
    return this.head;
  }

  rootOf(generation) {
    return serverRoot(this.generations.get(generation));
  }

  async commitLocalSnapshot({ baseGeneration, manifest, carried }) {
    if (baseGeneration !== this.head) {
      const error = new Error("stale");
      error.code = "stale";
      throw error;
    }
    const entries = manifest.entries.map(manifestEntryForPublicProtocol);
    assert.equal(manifest.manifestRoot, serverRoot(entries), "the server refuses a root it cannot reproduce");
    this.carriedAtCommit.push(carried.map((entry) => entry.path));
    this.head += 1;
    this.generations.set(this.head, Object.freeze(entries));
    return Object.freeze({ syncId: NEXT_SYNC, generation: this.head, manifestRoot: manifest.manifestRoot });
  }

  async listChanges({ afterGeneration }) {
    const items = [];
    for (let generation = afterGeneration + 1; generation <= this.head; generation += 1) {
      items.push(...changeItems(generation, this.generations.get(generation - 1), this.generations.get(generation), this.policyDigest));
    }
    return Object.freeze({ selected_protocol: 2, items: Object.freeze(items), next_cursor: null });
  }

  async readChunk({ digest, byteLength }) {
    const bytes = this.chunks.get(digest);
    if (bytes === undefined || bytes.byteLength !== byteLength) throw new Error("chunk unavailable");
    return bytes;
  }

  async reconcile({ generation, manifestRoot }) {
    const head = this.rootOf(this.head);
    return Object.freeze({
      status: generation === this.head && manifestRoot === head ? "converged" : "reconciliation_required",
      generation: this.head,
      manifestRoot: head,
    });
  }
}

function changeItems(generation, before, after, policyDigest) {
  const manifestRoot = serverRoot(after);
  const common = { manifest_root: manifestRoot, exclusion_policy_digest: policyDigest, committed_at: "2026-10-03T02:02:28.733Z", minimum_reader: 2, minimum_writer: 2 };
  const prior = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const items = [{ generation, operation: "revision", path: null, entry: null, ...common }];
  for (const path of [...new Set([...prior.keys(), ...current.keys()])].sort()) {
    const left = prior.get(path);
    const right = current.get(path);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    items.push({ generation, operation: right === undefined ? "delete" : "upsert", path, entry: right ?? null, ...common });
  }
  return items;
}

class WatchHarness {
  onEvent;
  factory = async ({ onEvent }) => {
    this.onEvent = onEvent;
    return Object.freeze({ close: () => undefined });
  };

  change(path) { this.onEvent?.({ kind: "change", path }); }
}

async function folder(files) {
  const base = await mkdtemp(join(tmpdir(), "cuna-excluded-remote-"));
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
  return {
    base, root, state, policy, manifest,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

function supervisorInput(fx, server, watcher, overrides = {}) {
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
    authority: server,
    watchFactory: watcher.factory,
    debounceMs: 2,
    remotePollIntervalMs: 5,
    reconciliationIntervalMs: 60_000,
    ...overrides,
  };
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

const LOCAL_FILES = Object.freeze({
  "src/pkg/mod.py": "def f():\n    return 1\n",
  "tests/test_x.py": "from pkg.mod import f\n\ndef test_f():\n    assert f() == 1\n",
  // The laptop's own interpreter cache: excluded here, never the Machine's to replace.
  "src/pkg/__pycache__/mod.cpython-313.pyc": "local 3.13 cache",
});

// What the Machine's run wrote: real results and the caches pytest left beside them.
const RESULTS = Object.freeze({
  "results/table.csv": "condition,mean\n1x,42.0\n",
  "results/fig.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]),
  "runs/run.log": "begin\n31 passed in 7.68s\nend\n",
});
const CACHES = Object.freeze({
  "src/pkg/__pycache__/mod.cpython-312.pyc": "remote 3.12 cache",
  "tests/__pycache__/test_x.cpython-312-pytest-8.3.3.pyc": "remote pytest cache",
  ".pytest_cache/README.md": "# pytest cache directory #\n",
  ".pytest_cache/v/cache/nodeids": "[\"tests/test_x.py::test_f\"]",
});
const CACHE_DIRECTORIES = Object.freeze([
  "src/pkg/__pycache__", "tests/__pycache__", ".pytest_cache", ".pytest_cache/v", ".pytest_cache/v/cache",
]);

function machineRun(gen1, { withCaches }) {
  return [
    ...gen1,
    directoryEntry("results"), directoryEntry("runs"),
    ...Object.entries(RESULTS).map(([path, content]) => fileEntry(path, content)),
    ...(withCaches
      ? [...CACHE_DIRECTORIES.map(directoryEntry), ...Object.entries(CACHES).map(([path, content]) => fileEntry(path, content))]
      : []),
  ];
}

async function assertResultsCameBack(root) {
  for (const [path, content] of Object.entries(RESULTS)) {
    assert.deepEqual(await readFile(join(root, path)), Buffer.from(content), `${path} is not byte-identical`);
  }
}

test("BL-7: a Machine generation carrying excluded caches next to results brings the results in and keeps syncing both ways", async (t) => {
  const fx = await folder(LOCAL_FILES);
  const gen1 = fx.manifest.entries.map(manifestEntryForPublicProtocol);
  assert.equal(serverRoot(gen1), fx.manifest.manifestRoot, "the oracle roots the CLI's own generation as the CLI does");
  const server = new GenerationServer(1, gen1, fx.policy.digest);
  const watcher = new WatchHarness();
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, server, watcher));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });

  server.publish(machineRun(gen1, { withCaches: true }), { ...RESULTS, ...CACHES });
  await waitFor(() => supervisor.snapshot.generation === 2 && supervisor.snapshot.state === "live_unverified",
    () => `the results never arrived: ${JSON.stringify(supervisor.snapshot)}`);
  await assertResultsCameBack(fx.root);
  // Nothing of the Machine's caches was written here, and the folder's own cache was not touched.
  assert.equal(await exists(join(fx.root, "src/pkg/__pycache__/mod.cpython-312.pyc")), false);
  assert.equal(await exists(join(fx.root, ".pytest_cache")), false);
  assert.equal(await exists(join(fx.root, "tests/__pycache__")), false);
  assert.equal(await readFile(join(fx.root, "src/pkg/__pycache__/mod.cpython-313.pyc"), "utf8"), "local 3.13 cache");
  assert.equal(supervisor.snapshot.manifestRoot, server.rootOf(2));

  // Local to remote still works, and the commit keeps the Machine's caches:
  // leaving them out would tell the Machine to delete them.
  await writeFile(join(fx.root, "notes.md"), "results look right\n");
  watcher.change("notes.md");
  await waitFor(() => supervisor.snapshot.generation === 3, () => `the local edit was not committed: ${JSON.stringify(supervisor.snapshot)}`);
  const committed = server.generations.get(3).map((entry) => entry.path);
  for (const path of [...Object.keys(CACHES), ...CACHE_DIRECTORIES]) assert.ok(committed.includes(path), `${path} was dropped`);
  assert.ok(committed.includes("notes.md"));
  assert.deepEqual(server.carriedAtCommit.at(-1).sort(), [...Object.keys(CACHES), ...CACHE_DIRECTORIES].sort());

  // A Machine whose capture follows the policy drops them from the next
  // generation. Their removal is the Machine's alone: the folder's own cache stays.
  server.publish(server.generations.get(3).filter((entry) =>
    !CACHE_DIRECTORIES.some((directory) => entry.path === directory || entry.path.startsWith(`${directory}/`))));
  await waitFor(() => supervisor.snapshot.generation === 4 && supervisor.snapshot.state === "live_unverified",
    () => `the cleanup generation was not taken in: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(await readFile(join(fx.root, "src/pkg/__pycache__/mod.cpython-313.pyc"), "utf8"), "local 3.13 cache");
  await writeFile(join(fx.root, "notes.md"), "results look right, twice\n");
  watcher.change("notes.md");
  await waitFor(() => supervisor.snapshot.generation === 5, () => `the second local edit was not committed: ${JSON.stringify(supervisor.snapshot)}`);
  assert.deepEqual(server.carriedAtCommit.at(-1), []);
  const state = JSON.parse(await readFile(join(fx.state, "continuous-sync.state.json"), "utf8"));
  assert.equal(state.schema_version, 3);
  assert.deepEqual(state.remote_only, []);
});

// A Machine whose capture predates the policy carries whatever the run left,
// and `npm install` or `python -m venv .venv` inside the workspace leaves
// thousands of entries. Two limits met there: a generation's changes are
// recorded as one list and were admitted with the one-page decoder (1,000
// items), so a longer one failed as `malformed_change_page` the moment it was
// recorded; and one durable write per excluded entry grows with the square of
// their number. 1,501 entries cross the page and must still arrive promptly.
test("a Machine generation carrying more excluded entries than one change page is taken in promptly", async (t) => {
  const fx = await folder(LOCAL_FILES);
  const gen1 = fx.manifest.entries.map(manifestEntryForPublicProtocol);
  const server = new GenerationServer(1, gen1, fx.policy.digest);
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, server, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  const modules = [directoryEntry("node_modules")];
  for (let index = 0; index < 750; index += 1) {
    modules.push(directoryEntry(`node_modules/pkg-${index}`), fileEntry(`node_modules/pkg-${index}/index.js`, `module.exports = ${index};\n`));
  }
  server.publish([...machineRun(gen1, { withCaches: false }), ...modules], RESULTS);
  const started = Date.now();
  await waitFor(() => supervisor.snapshot.generation === 2 && supervisor.snapshot.state === "live_unverified",
    () => `1,501 excluded entries were not taken in within 10 s: ${JSON.stringify(supervisor.snapshot)}`, 10_000);
  await assertResultsCameBack(fx.root);
  assert.equal(await exists(join(fx.root, "node_modules")), false);
  const state = JSON.parse(await readFile(join(fx.state, "continuous-sync.state.json"), "utf8"));
  assert.equal(state.remote_only.length, 1_501);
  t.diagnostic(`taken in after ${Date.now() - started} ms`);
});

// CONTROL: the same run on the Machine without the caches. It syncs on any
// build, so the only variable the test above adds is the excluded paths.
test("control: the same Machine run without caches brings the results in", async (t) => {
  const fx = await folder(LOCAL_FILES);
  const gen1 = fx.manifest.entries.map(manifestEntryForPublicProtocol);
  const server = new GenerationServer(1, gen1, fx.policy.digest);
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, server, new WatchHarness()));
  t.after(async () => { await supervisor.stop(); await fx.cleanup(); });
  server.publish(machineRun(gen1, { withCaches: false }), RESULTS);
  await waitFor(() => supervisor.snapshot.generation === 2, () => `the results never arrived: ${JSON.stringify(supervisor.snapshot)}`);
  await assertResultsCameBack(fx.root);
  assert.equal(supervisor.snapshot.manifestRoot, server.rootOf(2));
});

// The folder BL-7 left behind: its state says recovery_required /
// remote_excluded_path with generation 3 half taken in (only its revision
// item done), written by the build that refused it. Removing the caches on
// the Machine and re-attaching did not move it.
test("a folder an earlier build stopped on remote_excluded_path takes the rest of that generation in on the next run", async (t) => {
  const fx = await folder(LOCAL_FILES);
  const gen1 = fx.manifest.entries.map(manifestEntryForPublicProtocol);
  const server = new GenerationServer(1, gen1, fx.policy.digest);
  const first = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, server, new WatchHarness()));
  await first.stop();
  server.publish(machineRun(gen1, { withCaches: true }), { ...RESULTS, ...CACHES });
  const statePath = join(fx.state, "continuous-sync.state.json");
  const written = JSON.parse(await readFile(statePath, "utf8"));
  const items = (await server.listChanges({ afterGeneration: 1 })).items;
  const ordered = [
    items.find((item) => item.operation === "revision"),
    ...items.filter((item) => item.entry?.kind === "directory").sort((left, right) => left.path.split("/").length - right.path.split("/").length),
    ...items.filter((item) => item.entry?.kind === "file"),
  ];
  const { remote_only: _dropped, ...schemaTwo } = written;
  await writeFile(statePath, `${JSON.stringify({
    ...schemaTwo,
    schema_version: 2,
    status: "recovery_required",
    reason: "remote_excluded_path",
    dirty: true,
    pending_remote: { generation: 2, manifestRoot: server.rootOf(2), cursor: null, items: ordered, nextIndex: 1 },
  })}\n`);

  const next = await ContinuousWorkspaceSyncSupervisor.start(supervisorInput(fx, server, new WatchHarness()));
  t.after(async () => { await next.stop(); await fx.cleanup(); });
  await waitFor(() => next.snapshot.generation === 2 && next.snapshot.state === "live_unverified",
    () => `the stopped folder did not resume: ${JSON.stringify(next.snapshot)}`);
  await assertResultsCameBack(fx.root);
  assert.equal(await exists(join(fx.root, ".pytest_cache")), false);
});

// ---------------------------------------------------------------------------
// The same generation seen through the product service: a re-attach that
// commits nothing, and a re-attach after a local edit, against a server that
// speaks the HTTP protocol.

const workspaceId = "44444444-4444-4444-8444-444444444444";
const workspaceBindingId = "55555555-5555-4555-8555-555555555555";
const machineId = "66666666-6666-4666-8666-666666666666";
const requestId = "77777777-7777-4777-8777-777777777777";
const protocolCapabilities = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
]);

function envelope(data) {
  return Object.freeze({ request_id: requestId, selected_protocol: 2, capabilities: protocolCapabilities, data });
}

function session(body, id) {
  return {
    id, workspace_id: workspaceId, machine_id: body.machine_id, base_generation: body.base_generation,
    exclusion_policy_digest: body.exclusion_policy_digest, selected_protocol: 2, capabilities: protocolCapabilities,
    state: "staging", manifest_entry_count: 0, manifest_encoded_bytes: 0, content_bytes: 0,
    expires_at: "2026-10-04T00:00:00.000Z", created_at: "2026-10-03T00:00:00.000Z", updated_at: "2026-10-03T00:00:00.000Z",
  };
}

/** The workspace-sync HTTP surface over one namespace: every chunk it stores is readable through any committed session. */
class HttpGenerationServer {
  authentication = "authenticated";
  credentialAuthority = "interactive";
  requests = [];
  generations = new Map([[0, Object.freeze([])]]);
  head = 0;
  chunks = new Map();
  staged = new Map();
  sessions = 0;

  publish(entries, contents) {
    for (const content of Object.values(contents)) {
      const bytes = Buffer.from(content);
      this.chunks.set(sha256(bytes), bytes);
    }
    this.head += 1;
    this.generations.set(this.head, Object.freeze([...entries]));
  }

  async request(request) {
    this.requests.push(request);
    const path = request.path;
    if (path.endsWith("/sync-sessions")) {
      this.sessions += 1;
      const id = `00000000-0000-4000-8000-${String(this.sessions).padStart(12, "0")}`;
      this.policyDigest = request.body.exclusion_policy_digest;
      this.staged.set(id, { base: request.body.base_generation, entries: [] });
      return envelope(session(request.body, id));
    }
    const syncId = path.split("/")[3];
    if (path.endsWith("/manifests")) {
      this.staged.get(syncId).entries.push(...request.body.entries);
      // Only what this namespace does not hold, as the database answers.
      const missing = [...new Set(request.body.entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.digest)))]
        .filter((digest) => !this.chunks.has(digest));
      return envelope({
        sync: session({ machine_id: machineId, base_generation: this.staged.get(syncId).base, exclusion_policy_digest: this.policyDigest }, syncId),
        page_index: request.body.page_index, page_digest: "a".repeat(64), missing_digests: missing,
      });
    }
    if (request.method === "PUT" && path.includes("/chunks/")) {
      const digest = path.split("/").at(-1);
      this.chunks.set(digest, Buffer.from(request.body));
      return envelope({ selected_protocol: 2, digest, byte_length: request.body.byteLength, stored: true });
    }
    if (request.method === "GET" && path.includes("/chunks/")) {
      const digest = path.split("/").at(-1);
      const bytes = this.chunks.get(digest);
      if (bytes === undefined) throw new Error("chunk unavailable");
      return envelope({ selected_protocol: 2, digest, byte_length: bytes.byteLength, minimum_reader: 1, content_base64: bytes.toString("base64") });
    }
    if (path.endsWith("/commit")) {
      const staged = this.staged.get(syncId);
      assert.equal(request.body.expected_generation, this.head, "a commit names the head as its base");
      const entries = staged.entries.map(({ entry_digest: _digest, ...entry }) => entry);
      assert.equal(request.body.manifest_root, serverRoot(entries), "the server refuses a root it cannot reproduce");
      for (const entry of entries) for (const chunk of entry.chunks) assert.ok(this.chunks.has(chunk.digest), `chunk of ${entry.path} missing at commit`);
      this.head += 1;
      this.generations.set(this.head, Object.freeze(entries));
      return envelope({
        selected_protocol: 2, state: "committed", generation: this.head, manifest_root: request.body.manifest_root,
        committed_at: "2026-10-03T02:00:00.000Z", minimum_reader: 1, minimum_writer: 1,
      });
    }
    if (path.endsWith("/changes")) {
      const after = Number(request.query?.after_generation ?? 0);
      void after;
      const items = [];
      for (let generation = 2; generation <= this.head; generation += 1) {
        items.push(...changeItems(generation, this.generations.get(generation - 1), this.generations.get(generation), this.policyDigest));
      }
      return envelope({ selected_protocol: 2, items, next_cursor: null });
    }
    if (path.endsWith("/reconcile")) {
      const head = serverRoot(this.generations.get(this.head));
      return envelope({
        selected_protocol: 2,
        status: request.body.observed_generation === this.head && request.body.manifest_root === head ? "converged" : "reconciliation_required",
        active_generation: this.head, active_manifest_root: head, exclusion_policy_digest: request.body.exclusion_policy_digest,
      });
    }
    throw new Error(`Unexpected workspace sync operation ${request.method} ${path}.`);
  }
}

const productCapabilities = Object.freeze({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  caseSensitive: process.platform !== "win32",
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

test("a re-attach to a generation that carries excluded caches commits nothing, and a later commit keeps them", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "cuna-excluded-product-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const root = join(base, "workspace");
  const checkpointRoot = join(base, "state");
  await mkdir(checkpointRoot);
  for (const [path, content] of Object.entries(LOCAL_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const server = new HttpGenerationServer();
  const input = {
    localRoot: root, workspaceId, workspaceBindingId, machineId, baseGeneration: 0, transport: server,
    checkpointRoot, filesystemCapabilities: productCapabilities, maximumAttempts: 1,
  };
  const receipt = await synchronizeLocalWorkspace(input);
  assert.equal(receipt.generation, 1);
  const supervisor = await startContinuousWorkspaceSync({ ...input, initialReceipt: receipt });
  let stopped = false;
  try {
    server.publish(machineRun(server.generations.get(1), { withCaches: true }), { ...RESULTS, ...CACHES });
    await waitFor(() => supervisor.snapshot.generation === 2 && supervisor.snapshot.state === "live_unverified",
      () => `the Machine generation was not taken in: ${JSON.stringify(supervisor.snapshot)}`);
    await supervisor.stop();
    stopped = true;
  } finally {
    if (!stopped) await supervisor.stop();
  }
  await assertResultsCameBack(root);
  const headRoot = serverRoot(server.generations.get(2));
  const { baseGeneration: _unused, ...resume } = input;

  // The re-attach measures the folder as the generation holds it.
  const comparedWith = { workspaceId, workspaceBindingId, machineId, checkpointRoot, generation: 2 };
  assert.equal(await computeWorkspaceManifestRoot({ localRoot: root, filesystemCapabilities: productCapabilities, comparedWith }), headRoot);
  assert.notEqual(await computeWorkspaceManifestRoot({ localRoot: root, filesystemCapabilities: productCapabilities }), headRoot,
    "control: the folder alone does not reproduce a generation that carries the Machine's caches");
  const commitsBefore = server.requests.filter((request) => request.path.endsWith("/commit")).length;
  const resumed = await resumeContinuousWorkspaceSync({ ...resume, activeGeneration: 2, activeManifestRoot: headRoot });
  try {
    assert.equal(resumed.snapshot.generation, 2);
  } finally {
    await resumed.stop();
  }
  assert.equal(server.requests.filter((request) => request.path.endsWith("/commit")).length, commitsBefore,
    "an unchanged folder commits no generation");

  // A local edit while detached is committed on top, with the caches still in it.
  await writeFile(join(root, "notes.md"), "written while detached\n");
  // The server lost the bytes of one cache: the commit reads them back
  // through the namespace instead of from a folder that never held them.
  const lost = fileEntry(".pytest_cache/v/cache/nodeids", CACHES[".pytest_cache/v/cache/nodeids"]).chunks[0].digest;
  const lostBytes = server.chunks.get(lost);
  server.chunks.delete(lost);
  const readBack = server.request.bind(server);
  server.request = async (request) => {
    if (request.method === "PUT" && request.path.endsWith(`/chunks/${lost}`)) {
      assert.deepEqual(Buffer.from(request.body), lostBytes, "the carried bytes were re-sent unchanged");
    }
    if (request.method === "GET" && request.path.endsWith(`/chunks/${lost}`)) {
      return envelope({ selected_protocol: 2, digest: lost, byte_length: lostBytes.byteLength, minimum_reader: 1, content_base64: lostBytes.toString("base64") });
    }
    return readBack(request);
  };
  const edited = await synchronizeLocalWorkspace({ ...input, baseGeneration: 2 });
  assert.equal(edited.generation, 3);
  const paths = server.generations.get(3).map((entry) => entry.path);
  for (const path of [...Object.keys(CACHES), ...CACHE_DIRECTORIES, "notes.md", ...Object.keys(RESULTS)]) {
    assert.ok(paths.includes(path), `${path} is missing from the committed generation`);
  }
  assert.equal(paths.includes("src/pkg/__pycache__/mod.cpython-313.pyc"), false, "the folder's own excluded cache never leaves it");
  assert.ok(server.requests.some((request) => request.method === "PUT" && request.path.endsWith(`/chunks/${lost}`)));
  const listed = await readdir(join(root, "src/pkg/__pycache__"));
  assert.deepEqual(listed, ["mod.cpython-313.pyc"]);
});
