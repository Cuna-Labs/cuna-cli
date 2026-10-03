import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { CunaError, EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { conservativeFilesystemCapabilities } from "../dist/journey/workspace-effects.js";
import {
  DurableSyncJournal,
  inspectWorkspaceSyncPolicy,
  startContinuousWorkspaceSync,
  synchronizeLocalWorkspace,
} from "../dist/sync/index.js";
import { persistWorkspaceBinding } from "../dist/workspace/binding-store.js";

// R7.3, BL-7 (LIVE_RUNTIME 2026-10-03): a folder's sync state stopped at
// recovery_required, re-attaching did not recover it, and `cuna sync` was
// reserved, so the folder stayed stuck. `cuna sync recover [PATH] --yes` brings
// it back without losing bytes on either side, or refuses with a named reason
// and changes nothing. Everything here goes through `runCli`: the parser, the
// preflight, the composition and the output writer the person and a lab
// script see. The server speaks the workspace-sync HTTP protocol and roots
// generations the way the database does.

const API_KEY = "cuna_sk_abcdefghijklmnop";
const USER = "10000000-0000-4000-8000-000000000071";
const WORKSPACE = "20000000-0000-4000-8000-000000000071";
const MACHINE = "30000000-0000-4000-8000-000000000071";
const BINDING = "40000000-0000-4000-8000-000000000071";
const PROJECT = "50000000-0000-4000-8000-000000000071";
const LOCAL_INSTANCE = "60000000-0000-4000-8000-000000000071";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const PLATFORM_KIND = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const CAPABILITIES = conservativeFilesystemCapabilities(PLATFORM_KIND);
const PROTOCOL_CAPABILITIES = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** The server's manifest root, from the database's canonical entry (0060 put_workspace_sync_manifest_page). */
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

function envelope(data) {
  return Object.freeze({ request_id: REQUEST_ID, selected_protocol: 2, capabilities: PROTOCOL_CAPABILITIES, data });
}

function session(body, id) {
  return {
    id, workspace_id: WORKSPACE, machine_id: body.machine_id, base_generation: body.base_generation,
    exclusion_policy_digest: body.exclusion_policy_digest, selected_protocol: 2, capabilities: PROTOCOL_CAPABILITIES,
    state: "staging", manifest_entry_count: 0, manifest_encoded_bytes: 0, content_bytes: 0,
    expires_at: "2026-10-04T00:00:00.000Z", created_at: "2026-10-03T00:00:00.000Z", updated_at: "2026-10-03T00:00:00.000Z",
  };
}

function changeItems(generation, before, after, policyDigest) {
  const common = { manifest_root: serverRoot(after), exclusion_policy_digest: policyDigest, committed_at: "2026-10-03T12:00:00.000Z", minimum_reader: 1, minimum_writer: 1 };
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

/** The workspace-sync HTTP surface over one namespace (test/continuous-sync-excluded-remote-paths.test.mjs). */
class HttpGenerationServer {
  authentication = "authenticated";
  credentialAuthority = "api_key";
  requests = [];
  generations = new Map([[0, Object.freeze([])]]);
  head = 0;
  chunks = new Map();
  staged = new Map();
  sessions = 0;
  policyDigest;
  /** A generation whose change items name another exclusion policy, as a Machine on a changed policy would. */
  foreignPolicyAt = new Set();
  /** The reconciliation never answers until its caller gives up, as a stalled service does. */
  reconcileStalls = false;

  publish(entries, contents) {
    for (const content of Object.values(contents)) {
      const bytes = Buffer.from(content);
      this.chunks.set(sha256(bytes), bytes);
    }
    this.head += 1;
    this.generations.set(this.head, Object.freeze([...entries]));
  }

  count(suffix) {
    return this.requests.filter((request) => request.path.endsWith(suffix)).length;
  }

  async request(request) {
    this.requests.push(Object.freeze({ method: request.method, path: request.path }));
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
      const missing = [...new Set(request.body.entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.digest)))]
        .filter((digest) => !this.chunks.has(digest));
      return envelope({
        sync: session({ machine_id: MACHINE, base_generation: this.staged.get(syncId).base, exclusion_policy_digest: this.policyDigest }, syncId),
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
        committed_at: "2026-10-03T12:00:00.000Z", minimum_reader: 1, minimum_writer: 1,
      });
    }
    if (path.endsWith("/changes")) {
      const items = [];
      for (let generation = 2; generation <= this.head; generation += 1) {
        const digest = this.foreignPolicyAt.has(generation) ? "f".repeat(64) : this.policyDigest;
        items.push(...changeItems(generation, this.generations.get(generation - 1), this.generations.get(generation), digest));
      }
      return envelope({ selected_protocol: 2, items, next_cursor: null });
    }
    if (path.endsWith("/reconcile")) {
      if (this.reconcileStalls) {
        await new Promise((_resolve, reject) => {
          if (request.signal?.aborted) reject(request.signal.reason);
          request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
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

function filePlatform(root) {
  return {
    kind: PLATFORM_KIND,
    paths: { configDirectory: join(root, "cfg"), stateDirectory: join(root, "state"), runtimeDirectory: join(root, "run") },
    async readSafeConfig() { return { exists: false }; },
  };
}

function remoteNotFound() {
  return new CunaError({
    code: "cuna.remote.not_found",
    message: "The requested Cuna resource or operation was not found.",
    exitCode: EXIT_CODES.remote,
    details: { http_status: 404, reason: "resource_not_found" },
  });
}

/** The account, Machine and WorkspaceBinding authority, answering from the server's head unless told otherwise. */
function fakeClient(fx, overrides = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async getIdentity() {
        calls.push("getIdentity");
        return { id: USER, email: "lab@example.com", workspaceAssigned: true, workspaceId: WORKSPACE };
      },
      async getMachine(id) {
        calls.push("getMachine");
        if (overrides.machineGone) throw remoteNotFound();
        return { id, name: "lab-machine", state: "running", agent: "opencode", vcpus: 1, memoryMiB: 2048 };
      },
      async getWorkspaceBinding(bindingId, identity) {
        calls.push("getWorkspaceBinding");
        assert.equal(bindingId, BINDING);
        const head = overrides.activeGeneration ?? fx.server.head;
        return {
          bindingId: BINDING, executionWorkspaceId: null, workspaceId: WORKSPACE, projectId: PROJECT,
          localInstanceId: LOCAL_INSTANCE, machineId: MACHINE, remoteRoot: `/workspace/projects/${PROJECT}`,
          exclusionPolicyDigest: identity.exclusionPolicyDigest,
          activeGeneration: head,
          activeManifestRoot: fx.server.generations.has(head) ? serverRoot(fx.server.generations.get(head)) : "0".repeat(64),
          bindingEpoch: 1, minimumReader: 1, minimumWriter: 2,
          createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
        };
      },
    },
  };
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

/** Every file under `root` with its bytes, so "changed nothing" is a comparison, not a belief. */
async function tree(root) {
  const files = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path).replaceAll("\\", "/")] = (await readFile(path)).toString("base64");
    }
  };
  await walk(root);
  return files;
}

async function persistBinding(project, generation) {
  const policy = await inspectWorkspaceSyncPolicy({ localRoot: project, filesystemCapabilities: CAPABILITIES });
  await persistWorkspaceBinding({
    root: project,
    expected: null,
    binding: {
      profileId: "default", userId: USER, workspaceId: WORKSPACE, bindingId: BINDING, projectId: PROJECT,
      localInstanceId: LOCAL_INSTANCE, machineId: MACHINE, remoteRoot: `/workspace/projects/${PROJECT}`,
      policyDigest: policy.exclusionPolicyDigest, generation,
      bindingCreatedAt: "2026-10-03T00:00:00.000Z", bindingUpdatedAt: "2026-10-03T00:00:00.000Z",
    },
  });
}

async function scratch(t) {
  const base = await mkdtemp(join(tmpdir(), "cuna-sync-recover-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const project = join(base, "project");
  await mkdir(project);
  const platform = filePlatform(base);
  await mkdir(platform.paths.stateDirectory, { recursive: true });
  return { base, project, platform, checkpointRoot: join(platform.paths.stateDirectory, "workspace-sync") };
}

async function waitFor(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(typeof message === "function" ? message() : message);
}

/**
 * The BL-7 shape through the product service: a folder bound and synced at
 * generation 1 by the journey's own path, whose sync then stopped with
 * `status`/`reason` and stayed stopped. While it was stopped the Machine
 * published generation 2 (it edited shared.txt and wrote results.csv) and the
 * folder was edited here (shared.txt and notes.md).
 */
async function stuckFolder(t, { status = "recovery_required", reason = "pending_local_intent_changed" } = {}) {
  const fx = await scratch(t);
  await writeFile(join(fx.project, "main.js"), "console.log(1);\n");
  await writeFile(join(fx.project, "shared.txt"), "base\n");
  await mkdir(fx.checkpointRoot, { recursive: true });
  const server = new HttpGenerationServer();
  fx.server = server;
  const input = {
    localRoot: fx.project, workspaceId: WORKSPACE, workspaceBindingId: BINDING, machineId: MACHINE, baseGeneration: 0,
    transport: server, checkpointRoot: fx.checkpointRoot, filesystemCapabilities: CAPABILITIES, maximumAttempts: 1,
  };
  const receipt = await synchronizeLocalWorkspace(input);
  assert.equal(receipt.generation, 1);
  const supervisor = await startContinuousWorkspaceSync({ ...input, initialReceipt: receipt });
  try {
    await waitFor(() => supervisor.snapshot.state === "live_unverified" || supervisor.snapshot.state === "converged",
      () => `the first run never synced: ${JSON.stringify(supervisor.snapshot)}`);
  } finally {
    await supervisor.stop();
  }
  await persistBinding(fx.project, 1);
  const bindingDirectory = (await readdir(fx.checkpointRoot)).find((name) => /^binding-[0-9a-f]{64}$/u.test(name));
  assert.ok(bindingDirectory, "the first run left no durable sync state");
  fx.continuousDirectory = join(fx.checkpointRoot, bindingDirectory, "continuous");
  fx.statePath = join(fx.continuousDirectory, "generation-1", "continuous-sync.state.json");
  const state = JSON.parse(await readFile(fx.statePath, "utf8"));
  await writeFile(fx.statePath, `${JSON.stringify({ ...state, status, reason, dirty: true })}\n`);

  server.publish([
    fileEntry("main.js", "console.log(1);\n"),
    fileEntry("results.csv", "condition,mean\n1x,42.0\n"),
    fileEntry("shared.txt", "edited on the Machine\n"),
  ], { "results.csv": "condition,mean\n1x,42.0\n", "shared.txt": "edited on the Machine\n" });
  await writeFile(join(fx.project, "shared.txt"), "edited here\n");
  await writeFile(join(fx.project, "notes.md"), "written while sync was stopped\n");
  return fx;
}

function sibling(path, generation) {
  return `${path}.cuna-conflict-${generation}-${sha256(`${BINDING}\0${generation}\0${path}`).slice(0, 12)}`;
}

/** `cuna sync recover ...` as a lab script runs it: no terminal, an automation key. */
async function recover(fx, argv, { client = fakeClient(fx), tty = false } = {}) {
  const streams = memoryStreams({ stdoutIsTTY: tty, stderrIsTTY: false, stdinIsTTY: false });
  let factoryCalls = 0;
  const exit = await runCli(argv, {
    streams: streams.streams,
    platform: fx.platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => { factoryCalls += 1; return client.client; },
    ...(fx.server === undefined ? {} : { workspaceSyncTransport: fx.server }),
  });
  const stdout = streams.stdout().trim();
  const stderr = streams.stderr().trim();
  return {
    exit,
    stdout,
    stderr,
    result: !tty && stdout !== "" ? JSON.parse(stdout.split("\n").at(-1)) : undefined,
    error: stderr !== "" && stderr.startsWith("{") ? JSON.parse(stderr.split("\n").at(-1)) : undefined,
    calls: client.calls,
    factoryCalls,
  };
}

// ---------------------------------------------------------------------------
// The recovery itself.

test("R7.3: `cuna sync recover PATH --yes --json` brings a stuck folder back to syncing and keeps both versions of a conflict", async (t) => {
  const fx = await stuckFolder(t);
  const run = await recover(fx, ["sync", "recover", fx.project, "--yes", "--json"]);
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.equal(run.result.type, "result");
  assert.equal(run.result.command, "sync.recover");
  const data = run.result.data;
  assert.equal(data.binding_id, BINDING);
  assert.equal(data.machine_id, MACHINE);
  assert.equal(data.server_generation, 2);
  assert.deepEqual(data.before, { generation: 1, status: "recovery_required", reason: "pending_local_intent_changed" });
  assert.equal(data.after.generation, 3, "the folder's edits were committed on top of the Machine's generation");
  assert.ok(data.after.status === "live_unverified" || data.after.status === "converged", JSON.stringify(data.after));
  assert.equal(data.after.reason, null);
  assert.deepEqual(data.conflicts, [{
    code: "cuna.workspace_sync.conflict_retained",
    resolution: "local_in_place",
    path: "shared.txt",
    sibling: sibling("shared.txt", 2),
    generation: 2,
  }]);

  // No byte lost on either side.
  assert.equal(await readFile(join(fx.project, "shared.txt"), "utf8"), "edited here\n");
  assert.equal(await readFile(join(fx.project, sibling("shared.txt", 2)), "utf8"), "edited on the Machine\n");
  assert.equal(await readFile(join(fx.project, "notes.md"), "utf8"), "written while sync was stopped\n");
  assert.equal(await readFile(join(fx.project, "results.csv"), "utf8"), "condition,mean\n1x,42.0\n");
  const committed = new Map(fx.server.generations.get(3).map((entry) => [entry.path, entry]));
  assert.deepEqual([...committed.keys()].sort(), ["main.js", "notes.md", "results.csv", "shared.txt", sibling("shared.txt", 2)].sort());
  assert.equal(committed.get("shared.txt").chunks[0].digest, sha256(Buffer.from("edited here\n")));
  assert.equal(committed.get(sibling("shared.txt", 2)).chunks[0].digest, sha256(Buffer.from("edited on the Machine\n")));

  // The supervisor was stopped: its writer lease is free for the next run.
  const lease = await DurableSyncJournal.open({
    directory: join(fx.continuousDirectory, "writer-authority"), bindingId: BINDING, bindingGeneration: 1,
    ownerId: `continuous-sync-authority:${process.pid}:${randomUUID()}`,
  });
  await lease.close();
});

test("R7.3: the human output names the generation and every kept conflict, one line each", async (t) => {
  const fx = await stuckFolder(t, { status: "conflicted", reason: "workspace_sync_generation_conflict" });
  const run = await recover(fx, ["sync", "recover", fx.project, "--yes", "--no-color"], { tty: true });
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  const lines = run.stdout.split("\n");
  assert.equal(lines[0], "Workspace sync recovered · this folder is at generation 3");
  assert.match(lines[1], /^Before: conflicted \(workspace_sync_generation_conflict\) at generation 1 · now (live_unverified|converged) · the server was at generation 2$/u);
  assert.deepEqual(lines.slice(2), [
    `Workspace conflict on shared.txt · changed here and on the Machine · your version stays in place; the Machine's version is in ${sibling("shared.txt", 2)} (cuna.workspace_sync.conflict_retained)`,
  ]);
});

// ---------------------------------------------------------------------------
// Refusals: each named, distinguishable, nonzero, and touching nothing.

async function assertRefusedUntouched(fx, argv, reason, { client, exit = undefined, before } = {}) {
  const run = await recover(fx, argv, client === undefined ? {} : { client });
  assert.notEqual(run.exit, EXIT_CODES.success);
  if (exit !== undefined) assert.equal(run.exit, exit);
  assert.equal(run.error?.type, "error", run.stderr);
  assert.equal(run.error.command, "sync.recover");
  assert.equal(run.error.error.code, "cuna.workspace_sync.recovery_refused", run.stderr);
  assert.equal(run.error.error.details.reason, reason);
  assert.equal(typeof run.error.error.hint, "string");
  assert.ok(run.error.error.hint.length > 0);
  assert.deepEqual(await tree(fx.project), before.project, "a refusal changed the folder");
  if (before.state !== undefined) assert.equal(await readFile(fx.statePath, "utf8"), before.state, "a refusal changed the folder's sync state");
  if (fx.server !== undefined) {
    assert.equal(fx.server.count("/commit"), before.commits, "a refusal sent a commit");
    assert.equal(fx.server.requests.length, before.requests, "a refusal reached the sync service");
  }
  return run;
}

async function snapshotOf(fx) {
  return {
    project: await tree(fx.project),
    ...(fx.statePath === undefined ? {} : { state: await readFile(fx.statePath, "utf8") }),
    commits: fx.server?.count("/commit") ?? 0,
    requests: fx.server?.requests.length ?? 0,
  };
}

test("R7.3 refusal binding_missing: a folder never bound is refused before any request", async (t) => {
  const fx = await scratch(t);
  await writeFile(join(fx.project, "main.js"), "console.log(1);\n");
  fx.server = new HttpGenerationServer();
  const client = fakeClient(fx);
  const run = await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "binding_missing", {
    client, exit: EXIT_CODES.policy, before: await snapshotOf(fx),
  });
  assert.deepEqual(run.calls, [], "an unbound folder needs no account read");
});

test("R7.3 refusal policy_changed: a folder whose .gitignore changed since it was bound is refused", async (t) => {
  const fx = await stuckFolder(t);
  await writeFile(join(fx.project, ".gitignore"), "*.log\n");
  await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "policy_changed", {
    exit: EXIT_CODES.policy, before: await snapshotOf(fx),
  });
});

test("R7.3 refusal machine_gone: a folder whose bound Machine no longer exists is refused", async (t) => {
  const fx = await stuckFolder(t);
  const run = await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "machine_gone", {
    client: fakeClient(fx, { machineGone: true }), exit: EXIT_CODES.conflict, before: await snapshotOf(fx),
  });
  assert.equal(run.error.error.details.bound_machine_id, MACHINE);
});

test("R7.3 refusal recovery_state_missing: a bound folder with no durable sync state is refused, not guessed", async (t) => {
  const fx = await scratch(t);
  await writeFile(join(fx.project, "main.js"), "console.log(1);\n");
  await persistBinding(fx.project, 3);
  fx.server = new HttpGenerationServer();
  fx.server.publish([fileEntry("main.js", "console.log(2);\n")], {});
  const run = await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "recovery_state_missing", {
    exit: EXIT_CODES.conflict, before: await snapshotOf(fx),
  });
  assert.match(run.error.error.message, /will not guess/u);
});

test("R7.3 refusal generation_rollback: a folder newer than the server's generation is refused", async (t) => {
  const fx = await stuckFolder(t);
  const run = await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "generation_rollback", {
    client: fakeClient(fx, { activeGeneration: 0 }), exit: EXIT_CODES.conflict, before: await snapshotOf(fx),
  });
  assert.equal(run.error.error.details.local_generation, 1);
  assert.equal(run.error.error.details.server_generation, 0);
});

test("R7.3 refusal active_writer: a folder whose sync another cuna run holds is refused, naming that process", async (t) => {
  const fx = await stuckFolder(t);
  const holder = await DurableSyncJournal.open({
    directory: join(fx.continuousDirectory, "writer-authority"), bindingId: BINDING, bindingGeneration: 1,
    ownerId: `continuous-sync-authority:${process.pid}:${randomUUID()}`,
  });
  try {
    const run = await assertRefusedUntouched(fx, ["sync", "recover", fx.project, "--yes", "--json"], "active_writer", {
      exit: EXIT_CODES.conflict, before: await snapshotOf(fx),
    });
    assert.equal(run.error.error.details.holder_pid, process.pid);
    assert.match(run.error.error.message, new RegExp(`cuna process ${process.pid} holds this folder's sync`, "u"));
  } finally {
    await holder.close();
  }
});

test("R7.3: missing --yes is refused before configuration, credentials or any request", async (t) => {
  const fx = await stuckFolder(t);
  const before = await snapshotOf(fx);
  const run = await recover(fx, ["sync", "recover", fx.project, "--json"]);
  assert.equal(run.exit, EXIT_CODES.policy);
  assert.equal(run.error.command, "sync.recover");
  assert.equal(run.error.error.code, "cuna.confirmation.required");
  assert.equal(run.factoryCalls, 0, "no client was built");
  assert.deepEqual(run.calls, []);
  assert.equal(fx.server.requests.length, before.requests);
  assert.deepEqual(await tree(fx.project), before.project);
});

// ---------------------------------------------------------------------------
// Incomplete recoveries: said, nonzero, nothing retried, bytes untouched.

test("R7.3: a recovery that stops again reports the new state and reason and leaves the folder's bytes", async (t) => {
  const fx = await stuckFolder(t);
  fx.server.foreignPolicyAt.add(2);
  const run = await recover(fx, ["sync", "recover", fx.project, "--yes", "--json"]);
  assert.equal(run.exit, EXIT_CODES.conflict, run.stderr);
  assert.equal(run.error.error.code, "cuna.workspace_sync.recovery_incomplete");
  assert.equal(run.error.error.details.reason, "stopped_again");
  assert.equal(run.error.error.details.state, "conflicted");
  assert.equal(run.error.error.details.sync_reason, "remote_policy_changed");
  assert.equal(run.error.error.details.generation, 1);
  assert.equal(run.error.error.details.before_state, "recovery_required");
  assert.equal(fx.server.count("/commit"), 1, "only the first run's commit; nothing was sent over the Machine's generation");
  assert.equal(await readFile(join(fx.project, "shared.txt"), "utf8"), "edited here\n");
  assert.equal(await readFile(join(fx.project, "notes.md"), "utf8"), "written while sync was stopped\n");
  assert.equal(await exists(join(fx.project, "results.csv")), false);
});

test("R7.3: a recovery that does not finish in time ends with recovery_timeout naming the state, generation and reason", async (t) => {
  const fx = await stuckFolder(t);
  fx.server.reconcileStalls = true;
  const started = Date.now();
  const run = await recover(fx, ["sync", "recover", fx.project, "--yes", "--json", "--timeout-ms", "2000"]);
  assert.ok(Date.now() - started < 30_000, "the wait was not bounded by --timeout-ms");
  assert.equal(run.exit, EXIT_CODES.network, run.stderr);
  assert.equal(run.error.error.code, "cuna.workspace_sync.recovery_incomplete");
  assert.equal(run.error.error.details.reason, "recovery_timeout");
  assert.equal(run.error.error.details.state, "reconciling");
  assert.equal(run.error.error.details.sync_reason, "manifest_reconciliation");
  assert.equal(run.error.error.details.generation, 1);
  assert.equal(await readFile(join(fx.project, "shared.txt"), "utf8"), "edited here\n");
  // Stopped on the way out: the next run is not refused as active_writer.
  const lease = await DurableSyncJournal.open({
    directory: join(fx.continuousDirectory, "writer-authority"), bindingId: BINDING, bindingGeneration: 1,
    ownerId: `continuous-sync-authority:${process.pid}:${randomUUID()}`,
  });
  await lease.close();
});

// CONTROL for the routing: bare `sync` stays reserved, exactly as before.
test("R7.3 control: bare `cuna sync` is still the reserved refusal", async (t) => {
  const fx = await scratch(t);
  const run = await recover(fx, ["sync", "--json"]);
  assert.equal(run.exit, EXIT_CODES.unsupported);
  assert.equal(run.error.error.code, "cuna.capability.unsupported");
});
