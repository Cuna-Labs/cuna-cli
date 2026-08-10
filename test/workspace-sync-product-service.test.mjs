import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";

import { startContinuousWorkspaceSync, synchronizeLocalWorkspace } from "../dist/sync/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const workspaceBindingId = "55555555-5555-4555-8555-555555555555";
const machineId = "22222222-2222-4222-8222-222222222222";
const syncId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const protocolCapabilities = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
]);
const filesystemCapabilities = Object.freeze({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  caseSensitive: process.platform !== "win32",
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return directory;
}

class RecordingAuthority {
  authentication = "authenticated";
  credentialAuthority = "interactive";

  constructor() {
    this.requests = [];
    this.policyDigest = undefined;
    this.manifestRoot = undefined;
  }

  async request(request) {
    this.requests.push(request);
    if (request.path.endsWith("/sync-sessions")) {
      this.policyDigest = request.body.exclusion_policy_digest;
      return envelope(session(request.body));
    }
    if (request.path.endsWith("/manifests")) {
      const missing = request.body.entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.digest));
      return envelope({
        sync: session({
          machine_id: machineId,
          base_generation: 7,
          exclusion_policy_digest: this.policyDigest,
        }),
        page_index: request.body.page_index,
        page_digest: "a".repeat(64),
        missing_digests: missing,
      });
    }
    if (request.method === "PUT") {
      return envelope({
        selected_protocol: 2,
        digest: request.path.split("/").at(-1),
        byte_length: request.body.byteLength,
        stored: true,
      });
    }
    if (request.path.endsWith("/commit")) {
      this.manifestRoot = request.body.manifest_root;
      return envelope({
        selected_protocol: 2,
        state: "committed",
        generation: request.body.expected_generation + 1,
        manifest_root: this.manifestRoot,
        committed_at: "2026-08-09T12:00:00.000Z",
        minimum_reader: 1,
        minimum_writer: 1,
      });
    }
    if (request.path.endsWith("/changes")) {
      return envelope({ selected_protocol: 2, items: [], next_cursor: null });
    }
    if (request.path.endsWith("/reconcile")) {
      return envelope({
        selected_protocol: 2,
        status: "converged",
        active_generation: request.body.observed_generation,
        active_manifest_root: request.body.manifest_root,
        exclusion_policy_digest: request.body.exclusion_policy_digest,
      });
    }
    throw new Error("Unexpected workspace sync operation.");
  }
}

function envelope(data) {
  return Object.freeze({
    request_id: requestId,
    selected_protocol: 2,
    capabilities: protocolCapabilities,
    data,
  });
}

function session(request) {
  return {
    id: syncId,
    workspace_id: workspaceId,
    machine_id: request.machine_id,
    base_generation: request.base_generation,
    exclusion_policy_digest: request.exclusion_policy_digest,
    selected_protocol: 2,
    capabilities: protocolCapabilities,
    state: "staging",
    manifest_entry_count: 0,
    manifest_encoded_bytes: 0,
    content_bytes: 0,
    expires_at: "2026-08-10T00:00:00.000Z",
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

function productInput(root, checkpointRoot, transport, overrides = {}) {
  return {
    localRoot: root,
    workspaceId,
    workspaceBindingId,
    machineId,
    baseGeneration: 7,
    transport,
    checkpointRoot,
    filesystemCapabilities,
    maximumAttempts: 1,
    ...overrides,
  };
}

test("product service applies project exclusions and returns only committed receipt facts", async (t) => {
  const root = await temporaryDirectory(t, "runa-product-root-");
  const checkpointRoot = await temporaryDirectory(t, "runa-product-state-");
  const excludedSecret = "DO_NOT_TRANSMIT_THIS_SECRET_92834";
  await mkdir(join(root, "private"));
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, ".runaignore"), "private/**\n");
  await writeFile(join(root, "keep.txt"), "hello from runa\n");
  await writeFile(join(root, "ignored.txt"), excludedSecret);
  await writeFile(join(root, "private", "secret.txt"), excludedSecret);
  const authority = new RecordingAuthority();

  const receipt = await synchronizeLocalWorkspace(productInput(root, checkpointRoot, authority));

  assert.deepEqual(Object.keys(receipt).sort(), [
    "bytes",
    "entries",
    "exclusion_policy_digest",
    "files",
    "generation",
    "manifest_root",
    "phase",
    "selected_protocol",
  ]);
  assert.equal(receipt.phase, "committed");
  assert.equal(receipt.generation, 8);
  assert.equal(receipt.selected_protocol, 2);
  assert.equal(receipt.manifest_root, authority.manifestRoot);
  assert.equal(receipt.files, 3);
  assert.equal(receipt.entries, 4);
  assert.equal(receipt.bytes, Buffer.byteLength("ignored.txt\nprivate/**\nhello from runa\n"));
  assert.equal(Object.hasOwn(receipt, "percentage"), false);
  assert.equal(authority.requests[0].body.workspace_binding_id, workspaceBindingId);

  const serializedRequests = JSON.stringify(authority.requests);
  assert.equal(serializedRequests.includes(root), false);
  assert.equal(serializedRequests.includes(checkpointRoot), false);
  assert.equal(serializedRequests.includes(excludedSecret), false);
  assert.equal(serializedRequests.includes("ignored.txt"), false);
  assert.equal(serializedRequests.includes("private/secret.txt"), false);

  const bindingEntries = await readdir(checkpointRoot);
  assert.equal(bindingEntries.length, 1);
  assert.match(bindingEntries[0], /^binding-[0-9a-f]{64}-generation-7$/u);
  const checkpoint = await readFile(join(checkpointRoot, bindingEntries[0], "workspace-sync.checkpoint.json"), "utf8");
  assert.equal(checkpoint.includes(root), false);
  assert.equal(checkpoint.includes(excludedSecret), false);
  assert.equal(JSON.parse(checkpoint).phase, "committed");
});

test("continuous product lifecycle starts only from the durable initial commit and uploads a later local edit", async (t) => {
  const root = await temporaryDirectory(t, "cuna-continuous-root-");
  const checkpointRoot = await temporaryDirectory(t, "cuna-continuous-state-");
  await writeFile(join(root, "first.txt"), "one\n");
  const authority = new RecordingAuthority();
  const input = productInput(root, checkpointRoot, authority);
  const initialReceipt = await synchronizeLocalWorkspace(input);
  const supervisor = await startContinuousWorkspaceSync({ ...input, initialReceipt });
  t.after(() => supervisor.stop());

  await writeFile(join(root, "second.txt"), "two\n");
  supervisor.requestScan();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("continuous commit timeout"));
    }, 5_000);
    const unsubscribe = supervisor.subscribe((snapshot) => {
      if (snapshot.generation !== 9) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
  assert.equal(supervisor.snapshot.generation, 9);
  const restartedInput = { ...input, baseGeneration: 9 };
  const restartedReceipt = await synchronizeLocalWorkspace(restartedInput);
  await assert.rejects(
    startContinuousWorkspaceSync({ ...restartedInput, initialReceipt: restartedReceipt }),
    (error) => error.code === "runa.workspace.workspace_busy" && error.details.reason === "active_writer",
  );
  await supervisor.stop();
  const restarted = await startContinuousWorkspaceSync({ ...restartedInput, initialReceipt: restartedReceipt });
  t.after(() => restarted.stop());
  assert.equal(restarted.snapshot.generation, 10);
  await restarted.stop();
  assert.ok(authority.requests.filter((request) => request.path.endsWith("/commit")).length >= 3);
});

test("identity, generation, and authenticated authority fail before local filesystem or network effects", async () => {
  const nonexistentRoot = join(tmpdir(), `runa-must-not-read-${Date.now()}`);
  const noCalls = { authentication: "authenticated", credentialAuthority: "api_key", async request() { throw new Error("network must not run"); } };
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(nonexistentRoot, nonexistentRoot, noCalls, { workspaceId: "NOT-A-UUID" })),
    (error) => error.code === "runa.usage.invalid",
  );
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(nonexistentRoot, nonexistentRoot, noCalls, { workspaceBindingId: "NOT-A-UUID" })),
    (error) => error.code === "runa.usage.invalid",
  );
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(nonexistentRoot, nonexistentRoot, noCalls, { workspaceBindingId: workspaceId })),
    (error) => error.code === "runa.workspace_sync.invalid" && error.details.reason === "workspace_binding_id_domain",
  );
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(nonexistentRoot, nonexistentRoot, noCalls, { baseGeneration: undefined })),
    (error) => error.code === "runa.workspace_sync.invalid" && error.details.reason === "base_generation",
  );
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(nonexistentRoot, nonexistentRoot, { async request() { throw new Error("network must not run"); } })),
    (error) => error.code === "runa.auth.required",
  );
});

test("unsafe storage boundaries are rejected before exclusion parsing or network dispatch", async (t) => {
  const root = await temporaryDirectory(t, "runa-product-boundary-");
  await writeFile(join(root, ".gitignore"), new Uint8Array([0xff, 0xfe, 0xfd]));
  const authority = new RecordingAuthority();
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(root, root, authority)),
    (error) => error.code === "runa.workspace_sync.unsafe_root" && error.details.reason === "checkpoint_inside_workspace",
  );
  assert.equal(authority.requests.length, 0);

  await assert.rejects(
    synchronizeLocalWorkspace(productInput(parse(root).root, root, authority)),
    (error) => error.code === "runa.workspace_sync.unsafe_root" && error.details.reason === "filesystem_root",
  );
  assert.equal(authority.requests.length, 0);
});

test("unexpected lower-level failures cannot disclose local paths or secret values", async (t) => {
  const root = await temporaryDirectory(t, "runa-product-sanitize-");
  const checkpointRoot = await temporaryDirectory(t, "runa-product-sanitize-state-");
  const secret = "LOCAL_ONLY_SECRET_650294";
  await writeFile(join(root, "keep.txt"), "safe content\n");
  const authority = {
    authentication: "authenticated",
    credentialAuthority: "api_key",
    async request() {
      throw new Error(`unexpected failure at ${root}: ${secret}`);
    },
  };
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(root, checkpointRoot, authority)),
    (error) =>
      error.code === "runa.workspace_sync.failed" &&
      !error.message.includes(root) &&
      !error.message.includes(secret) &&
      error.cause === undefined,
  );
});

test("unsafe policy input is not followed or decoded and cannot leak external content", async (t) => {
  const root = await temporaryDirectory(t, "runa-product-policy-");
  const checkpointRoot = await temporaryDirectory(t, "runa-product-policy-state-");
  const external = join(await temporaryDirectory(t, "runa-product-external-"), "external-policy");
  await writeFile(external, "SENSITIVE_EXTERNAL_POLICY_CONTENT\n");
  try {
    await symlink(external, join(root, ".runaignore"), "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      // Windows often requires an elevated token to create symlinks. Invalid
      // UTF-8 still proves that unsafe policy bytes fail before any dispatch.
      await writeFile(join(root, ".runaignore"), new Uint8Array([0xff, 0xfe, 0xfd]));
    } else {
      throw error;
    }
  }
  const authority = new RecordingAuthority();
  await assert.rejects(
    synchronizeLocalWorkspace(productInput(root, checkpointRoot, authority)),
    (error) => error.code === "runa.workspace_sync.policy_unavailable",
  );
  assert.equal(authority.requests.length, 0);
});
