import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, CunaError } from "../core/errors.js";
import { assertCanonicalUuid } from "../core/validation.js";
import { assertLexicallyInsideRoot } from "../workspace/paths.js";
import type { WorkspaceManifest } from "../workspace/manifest.js";
import type { WorkspaceSyncClient } from "./workspace-sync-client.js";
import {
  WORKSPACE_SYNC_LIMITS,
  WORKSPACE_SYNC_PROTOCOL,
  iterateWorkspaceManifestPages,
  sha256,
  type WorkspaceSyncChangePage,
  type WorkspaceSyncCommitReceipt,
  type WorkspaceSyncReconcileReceipt,
} from "./workspace-sync-protocol.js";

export type WorkspaceSyncPhase = "begin_pending" | "staging" | "commit_pending" | "committed" | "conflicted";

export interface WorkspaceSyncCheckpoint {
  readonly schema_version: 2;
  readonly workspace_id: string;
  readonly workspace_binding_id: string;
  readonly machine_id: string;
  readonly base_generation: number;
  readonly exclusion_policy_digest: string;
  readonly manifest_root: string;
  readonly phase: WorkspaceSyncPhase;
  readonly sync_id: string | null;
  readonly selected_protocol: 1 | 2 | null;
  readonly committed_generation: number | null;
  readonly updated_at: string;
}

export interface WorkspaceSyncCheckpointStore {
  load(): Promise<WorkspaceSyncCheckpoint | undefined>;
  withLease<T>(operation: (transaction: WorkspaceSyncCheckpointTransaction) => Promise<T>): Promise<T>;
}

export interface WorkspaceSyncCheckpointTransaction {
  load(): Promise<WorkspaceSyncCheckpoint | undefined>;
  save(checkpoint: WorkspaceSyncCheckpoint): Promise<void>;
}

interface CheckpointRecord {
  readonly checkpoint: WorkspaceSyncCheckpoint;
  readonly revision: number;
  readonly fence: number;
}

interface WorkspaceSyncLease {
  readonly schema_version: 1;
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly fence: number;
  readonly created_at: string;
}

export interface WorkspaceChunkSource {
  read(digest: string, expectedLength: number): Promise<Uint8Array>;
}

export interface WorkspaceSyncCoordinatorOptions {
  readonly client: WorkspaceSyncClient;
  readonly checkpointStore: WorkspaceSyncCheckpointStore;
  readonly chunkSource: WorkspaceChunkSource;
  readonly maximumConcurrentUploads?: number;
  readonly maximumAttempts?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
}

export interface SynchronizeWorkspaceInput {
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly machineId: string;
  readonly baseGeneration: number;
  readonly manifest: WorkspaceManifest;
  readonly signal?: AbortSignal;
}

export class WorkspaceSyncCoordinator {
  readonly #client: WorkspaceSyncClient;
  readonly #checkpointStore: WorkspaceSyncCheckpointStore;
  readonly #chunkSource: WorkspaceChunkSource;
  readonly #maximumConcurrentUploads: number;
  readonly #maximumAttempts: number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: WorkspaceSyncCoordinatorOptions) {
    this.#client = options.client;
    this.#checkpointStore = options.checkpointStore;
    this.#chunkSource = options.chunkSource;
    this.#maximumConcurrentUploads = boundedInteger(
      options.maximumConcurrentUploads ?? 4,
      1,
      WORKSPACE_SYNC_LIMITS.concurrentChunkUploads,
      "upload_concurrency",
    );
    this.#maximumAttempts = boundedInteger(options.maximumAttempts ?? 3, 1, 5, "attempt_limit");
    this.#sleep = options.sleep ?? abortableSleep;
    this.#now = options.now ?? (() => new Date());
  }

  async synchronize(input: SynchronizeWorkspaceInput): Promise<WorkspaceSyncCommitReceipt> {
    assertCanonicalUuid(input.workspaceId, "workspace ID");
    assertCanonicalUuid(input.workspaceBindingId, "workspace binding ID");
    if (input.workspaceBindingId === input.workspaceId) throw invalid("workspace_binding_id_domain");
    assertCanonicalUuid(input.machineId, "machine ID");
    if (!Number.isSafeInteger(input.baseGeneration) || input.baseGeneration < 0) throw invalid("base_generation");
    digest(input.manifest.policyDigest, "policy_digest");
    digest(input.manifest.manifestRoot, "manifest_root");
    return this.#checkpointStore.withLease((transaction) => this.#synchronizeWithLease(input, transaction));
  }

  async #synchronizeWithLease(
    input: SynchronizeWorkspaceInput,
    transaction: WorkspaceSyncCheckpointTransaction,
  ): Promise<WorkspaceSyncCommitReceipt> {
    const identity = Object.freeze({
      workspace_id: input.workspaceId,
      workspace_binding_id: input.workspaceBindingId,
      machine_id: input.machineId,
      base_generation: input.baseGeneration,
      exclusion_policy_digest: digest(input.manifest.policyDigest, "policy_digest"),
      manifest_root: digest(input.manifest.manifestRoot, "manifest_root"),
    });
    let checkpoint = await transaction.load();
    if (checkpoint !== undefined && !sameIntent(checkpoint, identity)) throw conflict("checkpoint_intent_mismatch");
    checkpoint ??= await this.#persist(transaction, { ...identity, phase: "begin_pending", sync_id: null, selected_protocol: null, committed_generation: null });
    if (checkpoint.phase === "committed") {
      if (checkpoint.sync_id === null || checkpoint.selected_protocol === null || checkpoint.committed_generation === null) throw invalidCheckpoint();
      return Object.freeze({
        selected_protocol: checkpoint.selected_protocol,
        state: "committed",
        generation: checkpoint.committed_generation,
        manifest_root: checkpoint.manifest_root,
        committed_at: checkpoint.updated_at,
        minimum_reader: 1,
        minimum_writer: 1,
      });
    }
    if (checkpoint.phase === "conflicted") throw conflict("checkpoint_conflicted");

    if (checkpoint.sync_id === null) {
      const beginRequest = Object.freeze({
        workspace_binding_id: input.workspaceBindingId,
        machine_id: input.machineId,
        base_generation: input.baseGeneration,
        exclusion_policy_digest: input.manifest.policyDigest,
        protocol: WORKSPACE_SYNC_PROTOCOL,
        minimum_reader: 1,
        minimum_writer: 1,
      });
      const begin = await this.#idempotent(
        () => this.#client.begin(input.workspaceId, beginRequest, stableKey("begin", identity), input.signal),
        input.signal,
      );
      checkpoint = await this.#persist(transaction, { ...identity, phase: "staging", sync_id: begin.data.id, selected_protocol: begin.selected_protocol, committed_generation: null });
    }
    const syncId = checkpoint.sync_id;
    const selectedProtocol = checkpoint.selected_protocol;
    if (syncId === null || selectedProtocol === null) throw invalidCheckpoint();

    try {
      for (const page of iterateWorkspaceManifestPages(input.manifest)) {
        const manifestReceipt = await this.#idempotent(
          () => this.#client.manifest(syncId, page, stableKey("manifest", { syncId, root: input.manifest.manifestRoot, page: page.page_index }), input.signal),
          input.signal,
        );
        if (manifestReceipt.selected_protocol !== selectedProtocol) throw contractMismatch("protocol_changed");
        const lengths = chunkLengths(page);
        const missing = new Set<string>();
        for (const missingDigest of manifestReceipt.data.missing_digests) {
          if (missing.has(missingDigest) || !lengths.has(missingDigest)) {
            throw contractMismatch(
              missing.has(missingDigest) ? "duplicate_missing_digest" : "unexpected_missing_digest",
            );
          }
          missing.add(missingDigest);
        }
        for (let offset = 0; offset < manifestReceipt.data.missing_digests.length; offset += this.#maximumConcurrentUploads) {
          const batch = manifestReceipt.data.missing_digests.slice(offset, offset + this.#maximumConcurrentUploads);
          const outcomes = await Promise.allSettled(batch.map(async (missingDigest) => {
            const expectedLength = lengths.get(missingDigest);
            if (expectedLength === undefined) throw contractMismatch("unexpected_missing_digest");
            const bytes = await this.#chunkSource.read(missingDigest, expectedLength);
            if (bytes.byteLength !== expectedLength || sha256(bytes) !== missingDigest) throw conflict("chunk_source_changed");
            const uploaded = await this.#idempotent(
              () => this.#client.chunk(syncId, missingDigest, bytes, stableKey("chunk", { syncId, digest: missingDigest }), input.signal),
              input.signal,
            );
            if (uploaded.selected_protocol !== selectedProtocol) throw contractMismatch("protocol_changed");
            return uploaded;
          }));
          const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
          if (failure !== undefined) throw failure.reason;
        }
      }
      checkpoint = await this.#persist(transaction, { ...identity, phase: "commit_pending", sync_id: syncId, selected_protocol: selectedProtocol, committed_generation: null });
      const commitRequest = Object.freeze({
        expected_generation: input.baseGeneration,
        exclusion_policy_digest: input.manifest.policyDigest,
        manifest_root: input.manifest.manifestRoot,
        minimum_reader: 1,
        minimum_writer: 1,
      });
      const committed = await this.#idempotent(
        () => this.#client.commit(syncId, commitRequest, stableKey("commit", { syncId, root: input.manifest.manifestRoot }), input.signal),
        input.signal,
      );
      if (committed.selected_protocol !== selectedProtocol) throw contractMismatch("protocol_changed");
      await this.#persist(transaction, { ...identity, phase: "committed", sync_id: syncId, selected_protocol: selectedProtocol, committed_generation: committed.data.generation });
      return committed.data;
    } catch (error) {
      if (isAuthoritativeConflict(error)) {
        await this.#persist(transaction, { ...identity, phase: "conflicted", sync_id: syncId, selected_protocol: selectedProtocol, committed_generation: null });
      }
      throw error;
    }
  }

  async reconcile(input: {
    readonly workspaceId: string;
    readonly workspaceBindingId: string;
    readonly machineId: string;
    readonly observedGeneration: number;
    readonly exclusionPolicyDigest: string;
    readonly manifestRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceSyncReconcileReceipt> {
    assertCanonicalUuid(input.workspaceId, "workspace ID");
    assertCanonicalUuid(input.workspaceBindingId, "workspace binding ID");
    if (input.workspaceBindingId === input.workspaceId) throw invalid("workspace_binding_id_domain");
    assertCanonicalUuid(input.machineId, "machine ID");
    const request = Object.freeze({
      workspace_binding_id: input.workspaceBindingId,
      machine_id: input.machineId,
      observed_generation: boundedInteger(input.observedGeneration, 0, Number.MAX_SAFE_INTEGER, "observed_generation"),
      exclusion_policy_digest: digest(input.exclusionPolicyDigest, "policy_digest"),
      manifest_root: digest(input.manifestRoot, "manifest_root"),
      protocol: WORKSPACE_SYNC_PROTOCOL,
    });
    const response = await this.#idempotent(
      () => this.#client.reconcile(input.workspaceId, request, stableKey("reconcile", { workspaceId: input.workspaceId, ...request }), input.signal),
      input.signal,
    );
    return response.data;
  }

  async consumeChanges(input: {
    readonly syncId: string;
    readonly cursor?: string;
    readonly readerVersion?: number;
    readonly maximumPages?: number;
    readonly onPage: (page: WorkspaceSyncChangePage) => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<string | null> {
    assertCanonicalUuid(input.syncId, "workspace sync ID");
    const maximumPages = boundedInteger(input.maximumPages ?? 256, 1, 1_024, "change_page_limit");
    let cursor = input.cursor;
    for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
      const response = await this.#client.changes(input.syncId, {
        ...(cursor === undefined ? {} : { cursor }),
        readerVersion: input.readerVersion ?? 2,
        limit: WORKSPACE_SYNC_LIMITS.changePageEntries,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await input.onPage(response.data);
      if (response.data.next_cursor === null) return null;
      if (response.data.next_cursor === cursor) throw contractMismatch("cursor_did_not_advance");
      cursor = response.data.next_cursor;
    }
    return cursor ?? null;
  }

  async #persist(
    transaction: WorkspaceSyncCheckpointTransaction,
    input: Omit<WorkspaceSyncCheckpoint, "schema_version" | "updated_at">,
  ): Promise<WorkspaceSyncCheckpoint> {
    const checkpoint = Object.freeze({ schema_version: 2 as const, ...input, updated_at: this.#now().toISOString() });
    await transaction.save(checkpoint);
    return checkpoint;
  }

  async #idempotent<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let failure: unknown;
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        failure = error;
        if (!isAmbiguousOrRetryable(error) || attempt === this.#maximumAttempts || signal?.aborted === true) throw error;
        await this.#sleep(Math.min(1_000, 50 * 2 ** (attempt - 1)), signal);
      }
    }
    throw failure;
  }
}

export class FileWorkspaceSyncCheckpointStore implements WorkspaceSyncCheckpointStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #leasePath: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#path = join(directory, "workspace-sync.checkpoint.json");
    this.#leasePath = join(directory, "workspace-sync.lease.json");
  }

  async load(): Promise<WorkspaceSyncCheckpoint | undefined> {
    return (await this.#readRecord())?.checkpoint;
  }

  async withLease<T>(operation: (transaction: WorkspaceSyncCheckpointTransaction) => Promise<T>): Promise<T> {
    const lease = await this.#acquireLease();
    let loaded = false;
    let expectedRevision = 0;
    let cached: WorkspaceSyncCheckpoint | undefined;
    const transaction: WorkspaceSyncCheckpointTransaction = Object.freeze({
      load: async () => {
        await this.#assertLease(lease);
        if (!loaded) {
          const record = await this.#readRecord();
          expectedRevision = record?.revision ?? 0;
          cached = record?.checkpoint;
          loaded = true;
        }
        return cached;
      },
      save: async (checkpoint: WorkspaceSyncCheckpoint) => {
        if (!loaded) throw staleCheckpoint("transaction_not_loaded");
        const persisted = await this.#compareAndSwap(lease, expectedRevision, checkpoint);
        expectedRevision = persisted.revision;
        cached = persisted.checkpoint;
      },
    });
    try {
      return await operation(transaction);
    } finally {
      await this.#releaseLease(lease);
    }
  }

  async #readRecord(): Promise<CheckpointRecord | undefined> {
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) throw invalidCheckpoint();
      return decodeCheckpointRecord(JSON.parse(await readFile(this.#path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof CunaError) throw error;
      throw invalidCheckpoint(error);
    }
  }

  async #compareAndSwap(
    lease: WorkspaceSyncLease,
    expectedRevision: number,
    checkpoint: WorkspaceSyncCheckpoint,
  ): Promise<CheckpointRecord> {
    const value = decodeCheckpoint(checkpoint);
    await this.#assertLease(lease);
    const observed = await this.#readRecord();
    const observedRevision = observed?.revision ?? 0;
    if (observedRevision !== expectedRevision || (observed?.fence ?? 0) > lease.fence) {
      throw staleCheckpoint("checkpoint_revision_changed");
    }
    if (observed?.checkpoint.phase === "committed" && value.phase !== "committed") {
      throw staleCheckpoint("committed_checkpoint_is_terminal");
    }
    const next = Object.freeze({ checkpoint: value, revision: expectedRevision + 1, fence: lease.fence });
    const document = Object.freeze({ ...value, storage_revision: next.revision, fence: next.fence });
    const temp = await this.#writePrivateTemporary("checkpoint", document);
    try {
      await this.#assertLease(lease);
      const latest = await this.#readRecord();
      if ((latest?.revision ?? 0) !== expectedRevision || (latest?.fence ?? 0) > lease.fence) {
        throw staleCheckpoint("checkpoint_revision_changed");
      }
      await rename(temp, this.#path);
      await chmod(this.#path, 0o600).catch(platformModeFailure);
      return next;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async #acquireLease(): Promise<WorkspaceSyncLease> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(this.#directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw invalidCheckpoint();
    await chmod(this.#directory, 0o700).catch(platformModeFailure);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claim = Object.freeze({
        schema_version: 1 as const,
        token: randomUUID(),
        pid: process.pid,
        host: hostname(),
        fence: 0,
        created_at: new Date().toISOString(),
      });
      const temp = await this.#writePrivateTemporary("lease-claim", claim);
      let claimed = false;
      try {
        await link(temp, this.#leasePath);
        claimed = true;
        await unlink(temp);
        const prior = await this.#readRecord();
        if ((prior?.fence ?? 0) >= Number.MAX_SAFE_INTEGER) throw invalidCheckpoint();
        const lease = Object.freeze({ ...claim, fence: (prior?.fence ?? 0) + 1 });
        await this.#replaceLease(claim, lease);
        return lease;
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (claimed) {
          await this.#removeOwnedLease(claim.token);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const incumbent = await this.#readLease();
        if (incumbent.host !== hostname() || processIsAlive(incumbent.pid)) {
          throw leaseBusy();
        }
        const stale = join(this.#directory, `.workspace-sync.lease.stale.${incumbent.token}.${randomUUID()}`);
        try {
          await rename(this.#leasePath, stale);
          await unlink(stale);
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
        }
      }
    }
    throw leaseBusy();
  }

  async #replaceLease(previous: WorkspaceSyncLease, next: WorkspaceSyncLease): Promise<void> {
    await this.#assertLease(previous);
    const temp = await this.#writePrivateTemporary("lease", next);
    try {
      await rename(temp, this.#leasePath);
      await chmod(this.#leasePath, 0o600).catch(platformModeFailure);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async #releaseLease(lease: WorkspaceSyncLease): Promise<void> {
    await this.#assertLease(lease);
    await unlink(this.#leasePath);
  }

  async #removeOwnedLease(token: string): Promise<void> {
    try {
      const observed = await this.#readLease();
      if (observed.token === token) await unlink(this.#leasePath);
    } catch {
      // The lease may already be absent or replaced. Never remove a lease that
      // cannot be proven to belong to this failed acquisition.
    }
  }

  async #assertLease(expected: WorkspaceSyncLease): Promise<void> {
    const observed = await this.#readLease();
    if (
      observed.token !== expected.token || observed.pid !== expected.pid ||
      observed.host !== expected.host || observed.fence !== expected.fence
    ) {
      throw leaseLost();
    }
  }

  async #readLease(): Promise<WorkspaceSyncLease> {
    try {
      const metadata = await lstat(this.#leasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw leaseLost();
      return decodeLease(JSON.parse(await readFile(this.#leasePath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof CunaError) throw error;
      throw leaseLost();
    }
  }

  async #writePrivateTemporary(domain: string, value: unknown): Promise<string> {
    const temp = join(this.#directory, `.workspace-sync.${domain}.${randomUUID()}.tmp`);
    const handle = await open(temp, fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      return temp;
    } finally {
      await handle.close();
    }
  }
}

export async function createFilesystemChunkSource(root: string, manifest: WorkspaceManifest): Promise<WorkspaceChunkSource> {
  const canonicalRoot = await realpath(root);
  const locations = new Map<string, Readonly<{ path: string; offset: number; length: number }>>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    let offset = 0;
    for (const chunk of entry.chunks ?? []) {
      const existing = locations.get(chunk.digest);
      if (existing !== undefined && existing.length !== chunk.byteLength) throw conflict("digest_length_conflict");
      locations.set(chunk.digest, Object.freeze({ path: entry.path, offset, length: chunk.byteLength }));
      offset += chunk.byteLength;
    }
  }
  const source: WorkspaceChunkSource = {
    async read(chunkDigest, expectedLength) {
      const location = locations.get(chunkDigest);
      if (location === undefined || location.length !== expectedLength) throw conflict("chunk_unavailable");
      const physical = assertLexicallyInsideRoot(canonicalRoot, join(canonicalRoot, location.path));
      const handle = await open(physical, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      try {
        const bytes = new Uint8Array(expectedLength);
        let position = 0;
        while (position < expectedLength) {
          const result = await handle.read(bytes, position, expectedLength - position, location.offset + position);
          if (result.bytesRead === 0) break;
          position += result.bytesRead;
        }
        if (position !== expectedLength || sha256(bytes) !== chunkDigest) throw conflict("chunk_source_changed");
        return bytes;
      } finally {
        await handle.close();
      }
    },
  };
  return Object.freeze(source);
}

function chunkLengths(page: { readonly entries: readonly { readonly chunks: readonly { readonly digest: string; readonly byte_length: number }[] }[] }): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const entry of page.entries) {
    for (const chunk of entry.chunks) {
      const prior = lengths.get(chunk.digest);
      if (prior !== undefined && prior !== chunk.byte_length) throw contractMismatch("digest_length_conflict");
      lengths.set(chunk.digest, chunk.byte_length);
    }
  }
  return lengths;
}

function stableKey(domain: string, value: unknown): string {
  return `runa-sync-${domain}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sameIntent(checkpoint: WorkspaceSyncCheckpoint, identity: Omit<WorkspaceSyncCheckpoint, "schema_version" | "phase" | "sync_id" | "selected_protocol" | "committed_generation" | "updated_at">): boolean {
  return checkpoint.workspace_id === identity.workspace_id && checkpoint.workspace_binding_id === identity.workspace_binding_id && checkpoint.machine_id === identity.machine_id && checkpoint.base_generation === identity.base_generation && checkpoint.exclusion_policy_digest === identity.exclusion_policy_digest && checkpoint.manifest_root === identity.manifest_root;
}

function decodeCheckpoint(value: unknown): WorkspaceSyncCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidCheckpoint();
  const source = value as Record<string, unknown>;
  const allowed = ["schema_version", "workspace_id", "workspace_binding_id", "machine_id", "base_generation", "exclusion_policy_digest", "manifest_root", "phase", "sync_id", "selected_protocol", "committed_generation", "updated_at"];
  if (Object.keys(source).length !== allowed.length || Object.keys(source).some((key) => !allowed.includes(key)) || source.schema_version !== 2) throw invalidCheckpoint();
  const phase = source.phase;
  if (phase !== "begin_pending" && phase !== "staging" && phase !== "commit_pending" && phase !== "committed" && phase !== "conflicted") throw invalidCheckpoint();
  const syncId = source.sync_id === null ? null : canonicalUuid(source.sync_id);
  const selectedProtocol = source.selected_protocol === null
    ? null
    : source.selected_protocol === 1 || source.selected_protocol === 2
      ? source.selected_protocol
      : (() => { throw invalidCheckpoint(); })();
  const committedGeneration = source.committed_generation === null ? null : boundedInteger(source.committed_generation, 1, Number.MAX_SAFE_INTEGER, "committed_generation");
  if ((phase === "begin_pending") !== (syncId === null) || (syncId === null) !== (selectedProtocol === null) || (phase === "committed") !== (committedGeneration !== null)) throw invalidCheckpoint();
  if (typeof source.updated_at !== "string" || !Number.isFinite(Date.parse(source.updated_at))) throw invalidCheckpoint();
  return Object.freeze({
    schema_version: 2,
    workspace_id: canonicalUuid(source.workspace_id), workspace_binding_id: canonicalUuid(source.workspace_binding_id), machine_id: canonicalUuid(source.machine_id),
    base_generation: boundedInteger(source.base_generation, 0, Number.MAX_SAFE_INTEGER, "base_generation"),
    exclusion_policy_digest: digest(source.exclusion_policy_digest, "policy_digest"),
    manifest_root: digest(source.manifest_root, "manifest_root"), phase, sync_id: syncId, selected_protocol: selectedProtocol,
    committed_generation: committedGeneration, updated_at: source.updated_at,
  });
}

function decodeCheckpointRecord(value: unknown): CheckpointRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidCheckpoint();
  const source = value as Record<string, unknown>;
  const hasRevision = Object.hasOwn(source, "storage_revision");
  const hasFence = Object.hasOwn(source, "fence");
  if (hasRevision !== hasFence) throw invalidCheckpoint();
  const checkpointSource = { ...source };
  delete checkpointSource.storage_revision;
  delete checkpointSource.fence;
  return Object.freeze({
    checkpoint: decodeCheckpoint(checkpointSource),
    revision: hasRevision ? boundedStorageInteger(source.storage_revision) : 0,
    fence: hasFence ? boundedStorageInteger(source.fence) : 0,
  });
}

function decodeLease(value: unknown): WorkspaceSyncLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw leaseLost();
  const source = value as Record<string, unknown>;
  const allowed = ["schema_version", "token", "pid", "host", "fence", "created_at"];
  if (
    source.schema_version !== 1 || Object.keys(source).length !== allowed.length ||
    Object.keys(source).some((key) => !allowed.includes(key)) ||
    typeof source.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(source.token) ||
    typeof source.pid !== "number" || !Number.isSafeInteger(source.pid) || source.pid < 1 ||
    typeof source.host !== "string" || source.host.length < 1 || source.host.length > 255 || /[\p{Cc}\p{Cf}]/u.test(source.host) ||
    typeof source.created_at !== "string" || !Number.isFinite(Date.parse(source.created_at))
  ) {
    throw leaseLost();
  }
  return Object.freeze({
    schema_version: 1,
    token: source.token,
    pid: source.pid,
    host: source.host,
    fence: boundedStorageInteger(source.fence),
    created_at: source.created_at,
  });
}

function boundedStorageInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidCheckpoint();
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw invalidCheckpoint();
  return value;
}

function digest(value: unknown, reason: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid(reason);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, reason: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(reason);
  return value;
}

function isAmbiguousOrRetryable(error: unknown): boolean {
  return error instanceof CunaError && (error.retryable || error.code === "cuna.network.failed" || error.code === "cuna.network.timeout" || error.code === "cuna.network.service_unavailable");
}

function isAuthoritativeConflict(error: unknown): boolean {
  if (!(error instanceof CunaError)) return false;
  const reason = error.details?.reason;
  return error.code === "cuna.remote.conflict" || reason === "workspace_sync_generation_conflict" || reason === "workspace_sync_policy_conflict" || reason === "workspace_sync_manifest_conflict" || reason === "workspace_sync_idempotency_conflict";
}

function invalid(reason: string): CunaError {
  return new CunaError({ code: "cuna.workspace_sync.invalid", message: "Workspace synchronization input is invalid.", exitCode: EXIT_CODES.usage, details: { reason } });
}

function conflict(reason: string): CunaError {
  return new CunaError({ code: "cuna.workspace_sync.conflict", message: "Workspace synchronization requires explicit reconciliation.", exitCode: EXIT_CODES.conflict, details: { reason } });
}

function contractMismatch(reason: string): CunaError {
  return new CunaError({ code: "cuna.workspace_sync.contract_mismatch", message: "Workspace synchronization authority contradicted the admitted manifest.", exitCode: EXIT_CODES.remote, details: { reason } });
}

function invalidCheckpoint(cause?: unknown): CunaError {
  return new CunaError({ code: "cuna.workspace_sync.checkpoint_invalid", message: "The durable workspace synchronization checkpoint cannot be used safely.", exitCode: EXIT_CODES.conflict, cause });
}

function leaseBusy(): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.checkpoint_busy",
    message: "Another local process is synchronizing this workspace binding.",
    exitCode: EXIT_CODES.conflict,
    retryable: true,
  });
}

function leaseLost(): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.checkpoint_lease_lost",
    message: "The workspace synchronization checkpoint lease is no longer authoritative.",
    exitCode: EXIT_CODES.conflict,
  });
}

function staleCheckpoint(reason: string): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.checkpoint_stale",
    message: "A stale workspace synchronization writer was fenced from durable state.",
    exitCode: EXIT_CODES.conflict,
    details: { reason },
  });
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function platformModeFailure(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (process.platform !== "win32" || (code !== "EPERM" && code !== "ENOSYS")) throw error;
}
