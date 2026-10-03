import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContinuousWorkspaceSyncSupervisor, manifestEntryForPublicProtocol } from "../dist/sync/index.js";
import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";

// An empty file is one chunk of zero bytes on every other side of the
// protocol: the Edge refuses a file entry without a chunk (422
// workspace_sync_invalid_request, workspace-sync-protocol.ts prepareManifestEntry),
// the database refuses it too (0060, jsonb_array_length(entry_chunks) < 1),
// and the Machine's capture writes one zero-length chunk. The CLI wrote none,
// so a folder holding an empty `__init__.py` or `.gitkeep` could not be sent,
// and an empty file the Machine captured never matched this folder's copy
// (remote_apply_manifest_mismatch). Found with the BL-7 harness, 2026-10-03.

const EMPTY = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const capabilities = Object.freeze({
  platform: process.platform === "win32" ? "windows" : "linux", caseSensitive: false, unicodeNormalization: "nfc",
  symlinks: false, atomicRename: false, maximumComponentBytes: 255, maximumPathBytes: 4_096,
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

async function folder(t, files) {
  const base = await mkdtemp(join(tmpdir(), "cuna-empty-file-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const root = join(base, "workspace");
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { base, root };
}

test("an empty file is sent as one chunk of zero bytes, the encoding the Edge and the Machine use", async (t) => {
  const { root } = await folder(t, { "pkg/__init__.py": "", "keep/.gitkeep": "", "data.txt": "x" });
  const policy = compileExclusionPolicy([], capabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities });
  for (const path of ["pkg/__init__.py", "keep/.gitkeep"]) {
    const entry = manifestEntryForPublicProtocol(manifest.entries.find((candidate) => candidate.path === path));
    assert.deepEqual(entry.chunks, [{ digest: EMPTY, byte_length: 0 }], path);
    assert.equal(entry.byte_length, 0);
  }
  // Control: a non-empty file is unchanged, one chunk per 4 MiB of bytes.
  const data = manifestEntryForPublicProtocol(manifest.entries.find((candidate) => candidate.path === "data.txt"));
  assert.deepEqual(data.chunks, [{ digest: sha256("x"), byte_length: 1 }]);
  assert.equal(manifest.manifestRoot, serverRoot(manifest.entries.map(manifestEntryForPublicProtocol)));
});

test("an empty file the Machine captured is held here and sync stays live", async (t) => {
  const { base, root } = await folder(t, { "README.md": "# lab\n" });
  const state = join(base, "state");
  await mkdir(state);
  const policy = compileExclusionPolicy([], capabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities });
  const gen1 = manifest.entries.map(manifestEntryForPublicProtocol);
  // What the Machine's capture commits for an empty file it found.
  const captured = { path: "src/__init__.py", kind: "file", byte_length: 0, executable: false, chunks: [{ digest: EMPTY, byte_length: 0 }], link_target: null };
  const gen2 = [...gen1, { path: "src", kind: "directory", byte_length: 0, executable: false, chunks: [], link_target: null }, captured];
  const common = (generation, entries) => ({ manifest_root: serverRoot(entries), exclusion_policy_digest: policy.digest,
    committed_at: "2026-10-03T02:02:28.733Z", minimum_reader: 2, minimum_writer: 2, generation });
  const items = [
    { operation: "revision", path: null, entry: null, ...common(2, gen2) },
    { operation: "upsert", path: "src", entry: gen2.at(-2), ...common(2, gen2) },
    { operation: "upsert", path: "src/__init__.py", entry: captured, ...common(2, gen2) },
  ];
  const commits = [];
  const authority = {
    async commitLocalSnapshot({ manifest: proposed }) {
      // The folder holds exactly generation 2, so any commit here is the
      // folder re-encoding the Machine's empty file as a change of its own.
      commits.push(proposed.entries.map(manifestEntryForPublicProtocol));
      throw new Error("nothing to commit");
    },
    async listChanges({ afterGeneration }) {
      return { selected_protocol: 2, items: items.filter((item) => item.generation > afterGeneration), next_cursor: null };
    },
    async readChunk({ digest, byteLength }) {
      assert.equal(digest, EMPTY);
      assert.equal(byteLength, 0);
      return Buffer.alloc(0);
    },
    async reconcile({ generation, manifestRoot }) {
      return { status: generation === 2 && manifestRoot === serverRoot(gen2) ? "converged" : "reconciliation_required", generation: 2, manifestRoot: serverRoot(gen2) };
    },
  };
  const supervisor = await ContinuousWorkspaceSyncSupervisor.start({
    bindingId: "11111111-1111-4111-8111-111111111111", bindingGeneration: 1, syncId: "22222222-2222-4222-8222-222222222222",
    initialGeneration: 1, initialManifestRoot: manifest.manifestRoot, initialManifest: manifest, canonicalRoot: root,
    stateDirectory: state, policy, filesystemCapabilities: capabilities, authority,
    watchFactory: async () => ({ close() {} }), debounceMs: 2, remotePollIntervalMs: 5, reconciliationIntervalMs: 60_000,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(supervisor.snapshot.generation === 2 && supervisor.snapshot.state === "live_unverified") &&
      !["conflicted", "recovery_required"].includes(supervisor.snapshot.state)) {
      await new Promise((settle) => setTimeout(settle, 5));
    }
    assert.equal(supervisor.snapshot.generation, 2, JSON.stringify(supervisor.snapshot));
    assert.deepEqual(await readFile(join(root, "src/__init__.py")), Buffer.alloc(0));
    // Settled, not passing through: the folder holds the generation, so it
    // proposes nothing and stays live.
    supervisor.requestScan();
    await new Promise((settle) => setTimeout(settle, 300));
    assert.deepEqual(commits, [], "the folder re-proposed the Machine's empty file as its own change");
    assert.equal(supervisor.snapshot.state, "live_unverified", JSON.stringify(supervisor.snapshot));
    assert.equal(supervisor.snapshot.dirty, false);
    assert.equal(supervisor.snapshot.manifestRoot, serverRoot(gen2));
  } finally {
    await supervisor.stop();
  }
});
