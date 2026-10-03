import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContinuousWorkspaceSyncSupervisor, manifestEntryForPublicProtocol } from "../dist/sync/index.js";
import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";

// Production 2026-10-03 (biotech lab, namespace b13d8558): a folder caught up
// to generation 102 still read the change feed from its read handle's base
// generation on every 750 ms poll. The Edge starts a cursorless read at that
// base (workspace-sync-authority.ts, decodeWorkspaceSyncCursor), and the CLI
// kept no cursor once a page said there was nothing more, so every idle poll
// re-read the whole history since the handle's base: 85 revisions a poll for
// that laptop, which is what pushed the old diff past its 8 s timeout.
//
// The server here behaves as the Edge does: it ignores `afterGeneration`, a
// read without a cursor starts at the handle's base, `limit` defaults to 100,
// and a cursor is an opaque token that continues after the last item of the
// page that returned it. It counts what each read returns.

const BINDING = "11111111-1111-4111-8111-111111111111";
const SYNC = "22222222-2222-4222-8222-222222222222";
const capabilities = Object.freeze({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  caseSensitive: process.platform !== "win32",
  unicodeNormalization: "nfc",
  symlinks: process.platform !== "win32",
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function serverRoot(entries) {
  return sha256([...entries]
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
    .map((entry) => sha256(JSON.stringify({
      path: entry.path, kind: entry.kind, byte_length: entry.byte_length, executable: entry.executable,
      chunks: entry.chunks.map((chunk) => ({ digest: chunk.digest, byte_length: chunk.byte_length })), link_target: entry.link_target,
    })))
    .join(""));
}

function fileEntry(path, content) {
  const bytes = Buffer.from(content);
  return { path, kind: "file", byte_length: bytes.byteLength, executable: false,
    chunks: [{ digest: sha256(bytes), byte_length: bytes.byteLength }], link_target: null };
}

class EdgeLikeFeed {
  generations = new Map();
  chunks = new Map();
  head;
  tokens = new Map();
  reads = [];

  constructor(entries, policyDigest, handleBase) {
    this.generations.set(1, entries);
    this.head = 1;
    this.policyDigest = policyDigest;
    this.handleBase = handleBase;
  }

  publish(path, content) {
    const bytes = Buffer.from(content);
    this.chunks.set(sha256(bytes), bytes);
    const previous = this.generations.get(this.head);
    const directory = path.slice(0, path.lastIndexOf("/"));
    const parents = previous.some((entry) => entry.path === directory)
      ? [] : [{ path: directory, kind: "directory", byte_length: 0, executable: false, chunks: [], link_target: null }];
    this.head += 1;
    this.generations.set(this.head, [...previous, ...parents, fileEntry(path, content)]);
  }

  /** The whole feed in the order the database pages it: generation, then path ("" for the marker). */
  feed() {
    const items = [];
    for (let generation = 1; generation <= this.head; generation += 1) {
      const after = this.generations.get(generation);
      const before = new Map((this.generations.get(generation - 1) ?? []).map((entry) => [entry.path, entry]));
      const common = { manifest_root: serverRoot(after), exclusion_policy_digest: this.policyDigest,
        committed_at: "2026-10-03T19:00:00.000Z", minimum_reader: 2, minimum_writer: 2 };
      items.push({ sort: "", item: { generation, operation: "revision", path: null, entry: null, ...common } });
      for (const entry of [...after].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))) {
        if (JSON.stringify(before.get(entry.path)) === JSON.stringify(entry)) continue;
        items.push({ sort: entry.path, item: { generation, operation: "upsert", path: entry.path, entry, ...common } });
      }
    }
    return items;
  }

  async listChanges({ cursor, limit }) {
    const position = cursor === undefined ? { generation: this.handleBase, path: null } : this.tokens.get(cursor);
    if (position === undefined) throw new Error("workspace_sync_invalid_request");
    const pageLimit = limit ?? 100;
    const after = this.feed().filter(({ item, sort }) => item.generation > position.generation ||
      (item.generation === position.generation && Buffer.from(sort).compare(Buffer.from(position.path ?? "")) > 0));
    const page = after.slice(0, pageLimit);
    const hasMore = after.length > pageLimit;
    this.reads.push(page.length);
    let next = null;
    if (hasMore) {
      next = randomUUID();
      const last = page.at(-1);
      this.tokens.set(next, { generation: last.item.generation, path: last.item.path });
    }
    return { selected_protocol: 2, items: page.map(({ item }) => item), next_cursor: next };
  }

  async readChunk({ digest }) { return this.chunks.get(digest); }
  async commitLocalSnapshot() { throw new Error("no local edits in this test"); }
  async reconcile({ generation, manifestRoot }) {
    const head = serverRoot(this.generations.get(this.head));
    return { status: generation === this.head && manifestRoot === head ? "converged" : "reconciliation_required",
      generation: this.head, manifestRoot: head };
  }
}

async function waitFor(predicate, message, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === "function" ? message() : message);
}

async function start(t, generations) {
  const base = await mkdtemp(join(tmpdir(), "cuna-feed-cursor-"));
  const root = join(base, "workspace");
  const state = join(base, "state");
  await mkdir(root);
  await mkdir(state);
  await writeFile(join(root, "README.md"), "# lab\n");
  const policy = compileExclusionPolicy([], capabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities });
  const feed = new EdgeLikeFeed(manifest.entries.map(manifestEntryForPublicProtocol), policy.digest, 0);
  for (let generation = 2; generation <= generations; generation += 1) feed.publish(`results/r${String(generation).padStart(3, "0")}.csv`, `row ${generation}\n`);
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start({
    bindingId: BINDING, bindingGeneration: 1, syncId: SYNC, initialGeneration: 1,
    initialManifestRoot: manifest.manifestRoot, initialManifest: manifest, canonicalRoot: root, stateDirectory: state,
    policy, filesystemCapabilities: capabilities, authority: feed,
    watchFactory: async () => ({ close() {} }), debounceMs: 2, remotePollIntervalMs: 5, reconciliationIntervalMs: 60_000,
  });
  // One hook, in this order: `t.after` hooks run in registration order, and a
  // folder removed under a live supervisor fails the test on cleanup.
  t.after(async () => { await supervisor.stop(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { supervisor, feed, root };
}

async function idleReads(feed, milliseconds = 3_000) {
  const before = feed.reads.length;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  const reads = feed.reads.slice(before);
  return { calls: reads.length, items: reads.reduce((total, value) => total + value, 0) };
}

test("an idle folder that caught up reads only the feed's tail on each poll, not the history since its handle's base", async (t) => {
  const { supervisor, feed, root } = await start(t, 52);
  await waitFor(() => supervisor.snapshot.generation === 52 && supervisor.snapshot.state === "live_unverified",
    () => `the folder did not catch up: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(await readFile(join(root, "results/r052.csv"), "utf8"), "row 52\n");
  const idle = await idleReads(feed);
  assert.ok(idle.calls >= 2, `the poller kept polling (${idle.calls} reads; ${feed.reads.length} in all; ${JSON.stringify(supervisor.snapshot)})`);
  // The feed holds 52 markers, 52 files and a directory. Re-read from the
  // base, every poll costs two pages, 105 items; resumed from the folder's own
  // place, about one.
  assert.ok(idle.items / idle.calls <= 2,
    `an idle poll read ${(idle.items / idle.calls).toFixed(1)} items on average (${idle.items} over ${idle.calls} reads)`);
  t.diagnostic(`idle: ${idle.items} items over ${idle.calls} reads`);
});

test("a generation published after the folder caught up arrives, and the poll after it reads the tail again", async (t) => {
  const { supervisor, feed, root } = await start(t, 40);
  await waitFor(() => supervisor.snapshot.generation === 40 && supervisor.snapshot.state === "live_unverified",
    () => `the folder did not catch up: ${JSON.stringify(supervisor.snapshot)}`);
  await idleReads(feed, 50);
  feed.publish("results/late.csv", "late row\n");
  feed.publish("results/later.csv", "later row\n");
  await waitFor(() => supervisor.snapshot.generation === 42, () => `the new generations did not arrive: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(await readFile(join(root, "results/late.csv"), "utf8"), "late row\n");
  assert.equal(await readFile(join(root, "results/later.csv"), "utf8"), "later row\n");
  const idle = await idleReads(feed);
  assert.ok(idle.items / idle.calls <= 2, `an idle poll read ${(idle.items / idle.calls).toFixed(1)} items on average`);
});

// CONTROL: a folder whose whole feed is one short page. Its first poll reads
// that page whatever the build; only what follows differs.
test("control: the first poll of a short feed reads it whole once", async (t) => {
  const { supervisor, feed } = await start(t, 3);
  await waitFor(() => supervisor.snapshot.generation === 3, () => `no catch-up: ${JSON.stringify(supervisor.snapshot)}`);
  assert.equal(feed.reads[0], 7, "generations 1-3: three markers, three files and the results directory");
});
