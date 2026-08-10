import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, watch, type FSWatcher } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { EXIT_CODES, RunaError } from "../core/errors.js";
import type { ExclusionPolicy } from "../workspace/exclusion.js";
import { createWorkspaceManifest, type ManifestEntry, type WorkspaceManifest } from "../workspace/manifest.js";
import {
  assertLexicallyInsideRoot,
  normalizeWirePath,
  type FilesystemCapabilities,
} from "../workspace/paths.js";
import { DurableSyncJournal, type JournalOperationState } from "./journal.js";
import type {
  WorkspaceSyncChangeItem,
  WorkspaceSyncChangePage,
} from "./workspace-sync-protocol.js";
import { decodeChangePage } from "./workspace-sync-protocol.js";

const STATE_SCHEMA = 1;
const ZERO_DIGEST = "0".repeat(64);
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_RECONCILE_MS = 60_000;
const DEFAULT_REMOTE_POLL_MS = 750;
const DEFAULT_OPERATION_LIMIT = 10_000;
const DEFAULT_BYTE_LIMIT = 256 * 1024 * 1024;

export type ContinuousSyncState =
  | "recovering"
  | "reconciling"
  | "catching_up"
  | "live_unverified"
  | "converged"
  | "conflicted"
  | "paused"
  | "recovery_required"
  | "unknown"
  | "stopped";

export interface ContinuousSyncSnapshot {
  readonly state: ContinuousSyncState;
  readonly generation: number;
  readonly manifestRoot: string;
  readonly dirty: boolean;
  readonly pendingLocalOperations: number;
  readonly pendingRemoteChanges: number;
  readonly reason?: string;
  readonly observedAt: string;
}

export interface ContinuousSyncCommitReceipt {
  readonly syncId: string;
  readonly generation: number;
  readonly manifestRoot: string;
}

export interface ContinuousSyncReconcileReceipt {
  readonly status: "converged" | "reconciliation_required";
  readonly generation: number;
  readonly manifestRoot: string;
}

/**
 * The remote authority is deliberately content-explicit. A change entry only
 * carries digests; applying it requires independently authorized chunk reads.
 * Callers must not synthesize missing bytes or treat a manifest as content.
 */
export interface ContinuousSyncAuthority {
  commitLocalSnapshot(input: {
    readonly baseGeneration: number;
    readonly manifest: WorkspaceManifest;
    readonly signal: AbortSignal;
  }): Promise<ContinuousSyncCommitReceipt>;
  listChanges(input: {
    readonly syncId: string;
    readonly cursor?: string;
    readonly afterGeneration: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceSyncChangePage>;
  readChunk(input: {
    readonly syncId: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly signal: AbortSignal;
  }): Promise<Uint8Array>;
  reconcile(input: {
    readonly generation: number;
    readonly manifestRoot: string;
    readonly signal: AbortSignal;
  }): Promise<ContinuousSyncReconcileReceipt>;
}

export interface WorkspaceWatchSubscription {
  close(): Promise<void> | void;
}

export interface WorkspaceWatchEvent {
  readonly kind: "change" | "overflow";
  readonly path?: string;
}

export type WorkspaceWatchFactory = (input: {
  readonly root: string;
  readonly onEvent: (event: WorkspaceWatchEvent) => void;
  readonly onError: (error: unknown) => void;
}) => Promise<WorkspaceWatchSubscription>;

interface EntryProjection {
  readonly path: string;
  readonly kind: ManifestEntry["kind"];
  readonly fingerprint: string;
  readonly byteLength: number;
}

interface PendingLocalOperation {
  readonly operationId: string;
  readonly path: string;
  readonly kind: "create" | "update" | "delete";
  readonly baseGeneration: number;
  readonly fingerprint: string;
  readonly byteLength: number;
}

interface PendingRemoteApply {
  readonly generation: number;
  readonly manifestRoot: string;
  readonly cursor: string | null;
  readonly items: readonly WorkspaceSyncChangeItem[];
  readonly nextIndex: number;
}

interface DurableSupervisorState {
  readonly schema_version: 1;
  readonly binding_id: string;
  readonly binding_generation: number;
  readonly policy_digest: string;
  readonly sync_id: string;
  readonly generation: number;
  readonly manifest_root: string;
  readonly cursor: string | null;
  readonly dirty: boolean;
  readonly status: Exclude<ContinuousSyncState, "stopped">;
  readonly reason: string | null;
  readonly baseline: readonly EntryProjection[];
  readonly pending_local: readonly PendingLocalOperation[];
  readonly pending_remote: PendingRemoteApply | null;
  readonly updated_at: string;
}

export interface ContinuousWorkspaceSyncSupervisorInput {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly syncId: string;
  readonly initialGeneration: number;
  readonly initialManifestRoot: string;
  readonly canonicalRoot: string;
  readonly stateDirectory: string;
  /** Stable per-binding authority shared by every generation-specific state directory. */
  readonly writerLeaseDirectory?: string;
  readonly policy: ExclusionPolicy;
  readonly filesystemCapabilities: FilesystemCapabilities;
  readonly authority: ContinuousSyncAuthority;
  readonly initialManifest?: WorkspaceManifest;
  readonly watchFactory?: WorkspaceWatchFactory;
  readonly debounceMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly remotePollIntervalMs?: number;
  readonly maximumPendingOperations?: number;
  readonly maximumPendingBytes?: number;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly manifestBuilder?: typeof createWorkspaceManifest;
}

/**
 * One foreground supervisor owns one WorkspaceBinding writer lease. It keeps
 * synchronization on an independent asynchronous control path: terminal I/O
 * never enters this queue, and every scan/poll batch yields before continuing.
 */
export class ContinuousWorkspaceSyncSupervisor {
  readonly #input: ContinuousWorkspaceSyncSupervisorInput;
  readonly #clock: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #manifestBuilder: typeof createWorkspaceManifest;
  readonly #listeners = new Set<(snapshot: ContinuousSyncSnapshot) => void>();
  readonly #controller = new AbortController();
  readonly #statePath: string;
  readonly #journalDirectory: string;
  #state: DurableSupervisorState;
  #journal?: DurableSyncJournal;
  #writerLease?: DurableSyncJournal;
  #watcher?: WorkspaceWatchSubscription;
  #loop?: Promise<void>;
  #wake: (() => void) | undefined;
  #scanRequested = false;
  #reconcileRequested = false;
  #closed = false;

  private constructor(input: ContinuousWorkspaceSyncSupervisorInput, state: DurableSupervisorState) {
    this.#input = input;
    this.#clock = input.clock ?? Date.now;
    this.#sleep = input.sleep ?? abortableSleep;
    this.#manifestBuilder = input.manifestBuilder ?? createWorkspaceManifest;
    this.#state = state;
    this.#statePath = join(input.stateDirectory, "continuous-sync.state.json");
    this.#journalDirectory = join(input.stateDirectory, "operation-journal");
  }

  static async start(input: ContinuousWorkspaceSyncSupervisorInput): Promise<ContinuousWorkspaceSyncSupervisor> {
    validateInput(input);
    const root = await canonicalPlainDirectory(input.canonicalRoot);
    const stateDirectory = await preparePrivateDirectory(input.stateDirectory, root);
    const normalizedInput = Object.freeze({ ...input, canonicalRoot: root, stateDirectory });
    const initialManifest = input.initialManifest ?? await (input.manifestBuilder ?? createWorkspaceManifest)({
      root,
      policy: input.policy,
      capabilities: input.filesystemCapabilities,
    });
    if (
      initialManifest.policyDigest !== input.policy.digest ||
      initialManifest.manifestRoot !== input.initialManifestRoot
    ) {
      throw syncFailure("initial_manifest_unproven", EXIT_CODES.conflict);
    }
    const statePath = join(stateDirectory, "continuous-sync.state.json");
    const loaded = await loadState(statePath);
    const state = loaded === undefined
      ? createInitialState(normalizedInput, initialManifest)
      : admitState(loaded, normalizedInput);
    if (loaded === undefined) await atomicWriteState(statePath, state);
    const supervisor = new ContinuousWorkspaceSyncSupervisor(normalizedInput, state);
    try {
      await supervisor.#open();
      return supervisor;
    } catch (error) {
      try {
        await supervisor.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Continuous synchronization startup cleanup was incomplete.");
      }
      throw error;
    }
  }

  get snapshot(): ContinuousSyncSnapshot {
    return Object.freeze({
      state: this.#closed ? "stopped" : this.#state.status,
      generation: this.#state.generation,
      manifestRoot: this.#state.manifest_root,
      dirty: this.#state.dirty,
      pendingLocalOperations: this.#state.pending_local.length,
      pendingRemoteChanges: this.#state.pending_remote === null
        ? 0
        : this.#state.pending_remote.items.length - this.#state.pending_remote.nextIndex,
      ...(this.#state.reason === null ? {} : { reason: this.#state.reason }),
      observedAt: this.#state.updated_at,
    });
  }

  subscribe(listener: (snapshot: ContinuousSyncSnapshot) => void): () => void {
    this.#listeners.add(listener);
    try { listener(this.snapshot); } catch { /* Projection observers cannot own sync correctness. */ }
    return () => this.#listeners.delete(listener);
  }

  requestScan(): void {
    if (this.#closed) return;
    this.#scanRequested = true;
    this.#wake?.();
  }

  requestReconciliation(reason = "explicit_reconciliation"): void {
    if (this.#closed) return;
    this.#reconcileRequested = true;
    // The run loop is the sole durable-state writer. Publishing an optimistic
    // transition here would race a concurrent apply/checkpoint write.
    void reason;
    this.#wake?.();
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort(syncFailure("cancelled", EXIT_CODES.network));
    this.#wake?.();
    const failures: unknown[] = [];
    try { await this.#watcher?.close(); } catch (error) { failures.push(error); }
    try { await this.#loop; } catch (error) {
      if (!isAbort(error)) failures.push(error);
    }
    try { await this.#journal?.close(); } catch (error) { failures.push(error); }
    try { await this.#writerLease?.close(); } catch (error) { failures.push(error); }
    this.#publish();
    if (failures.length > 0) throw new AggregateError(failures, "Continuous synchronization cleanup was incomplete.");
  }

  async waitForStop(): Promise<void> {
    await this.#loop;
  }

  async #open(): Promise<void> {
    if (this.#input.writerLeaseDirectory !== undefined) {
      this.#writerLease = await DurableSyncJournal.open({
        directory: this.#input.writerLeaseDirectory,
        bindingId: this.#input.bindingId,
        // This journal is only the stable per-binding writer authority; its
        // metadata generation deliberately does not follow content revisions.
        bindingGeneration: 1,
        ownerId: `continuous-sync-authority:${process.pid}:${randomUUID()}`,
        clock: this.#clock,
      });
    }
    try {
      this.#journal = await DurableSyncJournal.open({
        directory: this.#journalDirectory,
        bindingId: this.#input.bindingId,
        bindingGeneration: this.#input.bindingGeneration,
        ownerId: `continuous-sync:${process.pid}:${randomUUID()}`,
        clock: this.#clock,
      });
    } catch (error) {
      await this.#writerLease?.close();
      throw error;
    }
    if (this.#state.pending_remote !== null) await this.#resumeRemoteApply();
    await this.#recoverPendingLocal();
    const watchFactory = this.#input.watchFactory ?? createNodeWorkspaceWatcher;
    this.#watcher = await watchFactory({
      root: this.#input.canonicalRoot,
      onEvent: (event) => {
        if (event.kind === "overflow" || event.path === undefined) {
          this.requestReconciliation("watcher_overflow");
          return;
        }
        try {
          const path = normalizeWirePath(event.path.replaceAll("\\", "/"), this.#input.filesystemCapabilities);
          const decision = this.#input.policy.decide(path);
          if (!decision.excluded) this.requestScan();
        } catch {
          this.requestReconciliation("watcher_path_untrusted");
        }
      },
      onError: () => this.requestReconciliation("watcher_failed"),
    });
    this.#scanRequested = true;
    this.#loop = this.#runLoop();
  }

  async #runLoop(): Promise<void> {
    const signal = this.#controller.signal;
    let lastReconciliation = this.#clock();
    while (!signal.aborted) {
      try {
        if (this.#reconcileRequested || this.#clock() - lastReconciliation >= (this.#input.reconciliationIntervalMs ?? DEFAULT_RECONCILE_MS)) {
          this.#reconcileRequested = false;
          await this.#reconcile(signal);
          lastReconciliation = this.#clock();
        }
        if (this.#scanRequested && this.#state.status !== "conflicted" && this.#state.status !== "recovery_required") {
          this.#scanRequested = false;
          await this.#sleep(this.#input.debounceMs ?? DEFAULT_DEBOUNCE_MS, signal);
          await this.#scanAndCommit(signal);
        }
        if (this.#state.status !== "conflicted" && this.#state.status !== "recovery_required" && this.#state.status !== "paused") {
          await this.#consumeRemote(signal);
        }
        await this.#journal?.renew();
        await this.#waitForWake(this.#input.remotePollIntervalMs ?? DEFAULT_REMOTE_POLL_MS, signal);
      } catch (error) {
        if (signal.aborted) break;
        const classification = classifyFailure(error);
        await this.#transition({
          status: classification.status,
          dirty: true,
          reason: classification.reason,
        });
        if (classification.status === "recovery_required" || classification.status === "conflicted") break;
        await this.#waitForWake(this.#input.remotePollIntervalMs ?? DEFAULT_REMOTE_POLL_MS, signal);
      }
    }
  }

  async #scanAndCommit(signal: AbortSignal): Promise<void> {
    await this.#transition({ status: "catching_up", reason: null });
    const manifest = await this.#buildManifest();
    if (manifest.manifestRoot === this.#state.manifest_root) {
      if (!this.#state.dirty) await this.#transition({ status: "live_unverified", reason: null });
      else this.#reconcileRequested = true;
      return;
    }
    const observedOperations = diffManifest(this.#state.baseline, manifest, this.#state.generation);
    const operations = this.#state.pending_local.length === 0
      ? observedOperations
      : samePendingIntent(this.#state.pending_local, observedOperations)
        ? this.#state.pending_local
        : (() => { throw syncFailure("pending_local_intent_changed", EXIT_CODES.conflict); })();
    const maximumOperations = this.#input.maximumPendingOperations ?? DEFAULT_OPERATION_LIMIT;
    const maximumBytes = this.#input.maximumPendingBytes ?? DEFAULT_BYTE_LIMIT;
    const bytes = operations.reduce((total, operation) => total + operation.byteLength, 0);
    if (operations.length > maximumOperations || bytes > maximumBytes) {
      await this.#transition({ status: "paused", dirty: true, reason: operations.length > maximumOperations ? "operation_limit" : "byte_limit" });
      return;
    }
    if (this.#state.pending_local.length === 0) {
      for (const operation of operations) {
        await this.#journal?.append({
          operationId: operation.operationId,
          baseGeneration: operation.baseGeneration,
          digest: operation.fingerprint,
          byteLength: operation.byteLength,
        });
      }
      await this.#replaceState({ pending_local: operations, status: "catching_up", dirty: this.#state.dirty, reason: null });
    }
    for (const operation of operations) await transitionIfQueued(this.#journal, operation.operationId);
    let receipt: ContinuousSyncCommitReceipt;
    try {
      receipt = await this.#input.authority.commitLocalSnapshot({
        baseGeneration: this.#state.generation,
        manifest,
        signal,
      });
    } catch (error) {
      for (const operation of operations) await transitionIfPossible(this.#journal, operation.operationId, "uncertain");
      throw error;
    }
    if (
      receipt.generation !== this.#state.generation + 1 ||
      receipt.manifestRoot !== manifest.manifestRoot ||
      !isUuid(receipt.syncId)
    ) {
      throw syncFailure("commit_receipt_mismatch", EXIT_CODES.remote);
    }
    for (const operation of operations) {
      await this.#journal?.transition(operation.operationId, "acknowledged");
      await this.#journal?.transition(operation.operationId, "applied");
    }
    await this.#replaceState({
      sync_id: receipt.syncId,
      generation: receipt.generation,
      manifest_root: receipt.manifestRoot,
      baseline: projectManifest(manifest),
      pending_local: [],
      cursor: null,
      status: "live_unverified",
      dirty: false,
      reason: null,
    });
  }

  async #consumeRemote(signal: AbortSignal): Promise<void> {
    const items: WorkspaceSyncChangeItem[] = [];
    let cursor = this.#state.cursor ?? undefined;
    let terminalCursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
      const page = await this.#input.authority.listChanges({
        syncId: this.#state.sync_id,
        ...(cursor === undefined ? {} : { cursor }),
        afterGeneration: this.#state.generation,
        signal,
      });
      items.push(...page.items.filter((item) => item.generation > this.#state.generation));
      terminalCursor = page.next_cursor;
      if (page.next_cursor === null) break;
      if (page.next_cursor === cursor) throw syncFailure("remote_cursor_stalled", EXIT_CODES.conflict);
      cursor = page.next_cursor;
      if (pageIndex === 255) throw syncFailure("remote_page_limit", EXIT_CODES.conflict);
    }
    const unseen = items;
    if (unseen.length === 0) {
      if (!this.#state.dirty && this.#state.status !== "converged") {
        await this.#transition({ status: "live_unverified", reason: null });
      }
      return;
    }
    let offset = 0;
    while (offset < unseen.length) {
      const generation = unseen[offset]?.generation;
      if (generation === undefined || generation !== this.#state.generation + 1) {
        throw syncFailure("remote_sequence_gap", EXIT_CODES.conflict);
      }
      const items: WorkspaceSyncChangeItem[] = [];
      while (offset < unseen.length && unseen[offset]?.generation === generation) {
        const item = unseen[offset];
        if (item !== undefined) items.push(item);
        offset += 1;
      }
      const manifestRoot = commonRemoteField(items, "manifest_root");
      const policyDigest = commonRemoteField(items, "exclusion_policy_digest");
      if (policyDigest !== this.#input.policy.digest) throw syncFailure("remote_policy_changed", EXIT_CODES.conflict);
      await this.#replaceState({
        status: "catching_up",
        pending_remote: Object.freeze({
          generation,
          manifestRoot,
          cursor: offset === unseen.length ? terminalCursor : this.#state.cursor,
          items: Object.freeze(items),
          nextIndex: 0,
        }),
        reason: null,
      });
      await this.#resumeRemoteApply();
    }
  }

  async #resumeRemoteApply(): Promise<void> {
    const pending = this.#state.pending_remote;
    if (pending === null) return;
    const signal = this.#controller.signal;
    const current = await this.#buildManifest();
    const currentEntries = new Map(projectManifest(current).map((entry) => [entry.path, entry]));
    const baseline = new Map(this.#state.baseline.map((entry) => [entry.path, entry]));
    const ordered = orderRemoteItems(pending.items);
    for (let index = pending.nextIndex; index < ordered.length; index += 1) {
      const item = ordered[index];
      if (item === undefined) continue;
      if (item.operation !== "revision") {
        const path = item.path;
        if (path === null) throw syncFailure("remote_change_shape", EXIT_CODES.remote);
        const prior = baseline.get(path);
        const observed = currentEntries.get(path);
        if (!sameProjection(prior, observed)) {
          await this.#retainConflict(item, signal);
          await this.#replaceState({
            pending_remote: Object.freeze({ ...pending, items: Object.freeze(ordered), nextIndex: index + 1 }),
            status: "conflicted",
            dirty: true,
            reason: "same_path_diverged",
          });
          throw syncFailure("same_path_diverged", EXIT_CODES.conflict);
        }
        await this.#applyRemoteItem(item, signal);
      }
      await this.#replaceState({
        pending_remote: Object.freeze({ ...pending, items: Object.freeze(ordered), nextIndex: index + 1 }),
      });
    }
    const manifest = await this.#buildManifest();
    if (manifest.manifestRoot !== pending.manifestRoot) {
      throw syncFailure("remote_apply_manifest_mismatch", EXIT_CODES.conflict);
    }
    await this.#replaceState({
      generation: pending.generation,
      manifest_root: pending.manifestRoot,
      baseline: projectManifest(manifest),
      cursor: pending.cursor,
      pending_remote: null,
      dirty: false,
      status: "live_unverified",
      reason: null,
    });
  }

  async #applyRemoteItem(item: WorkspaceSyncChangeItem, signal: AbortSignal): Promise<void> {
    if (item.path === null) return;
    const path = normalizeWirePath(item.path, this.#input.filesystemCapabilities);
    const physical = assertLexicallyInsideRoot(this.#input.canonicalRoot, join(this.#input.canonicalRoot, path));
    if (item.operation === "delete") {
      await safeDelete(this.#input.canonicalRoot, physical);
      return;
    }
    const entry = item.entry;
    if (entry === null) throw syncFailure("remote_change_shape", EXIT_CODES.remote);
    const decision = this.#input.policy.decide(path, entry.kind);
    if (decision.excluded) throw syncFailure("remote_excluded_path", EXIT_CODES.policy);
    if (entry.kind === "symlink") throw syncFailure("remote_symlink_unsupported", EXIT_CODES.policy);
    if (entry.kind === "directory") {
      await ensureSafeDirectory(this.#input.canonicalRoot, physical);
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const chunk of entry.chunks) {
      const bytes = await this.#input.authority.readChunk({
        syncId: this.#state.sync_id,
        digest: chunk.digest,
        byteLength: chunk.byte_length,
        signal,
      });
      if (bytes.byteLength !== chunk.byte_length || sha256(bytes) !== chunk.digest) {
        throw syncFailure("remote_chunk_mismatch", EXIT_CODES.policy);
      }
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    if (total !== entry.byte_length) throw syncFailure("remote_content_length_mismatch", EXIT_CODES.remote);
    await atomicReplaceFile(this.#input.canonicalRoot, physical, chunks, entry.executable);
  }

  async #retainConflict(item: WorkspaceSyncChangeItem, signal: AbortSignal): Promise<void> {
    if (item.operation !== "upsert" || item.entry === null || item.path === null || item.entry.kind !== "file") return;
    const suffix = createHash("sha256")
      .update(`${this.#input.bindingId}\0${item.generation}\0${item.path}`)
      .digest("hex")
      .slice(0, 12);
    const retained = `${item.path}.cuna-conflict-${item.generation}-${suffix}`;
    const physical = assertLexicallyInsideRoot(this.#input.canonicalRoot, join(this.#input.canonicalRoot, retained));
    const chunks: Uint8Array[] = [];
    for (const chunk of item.entry.chunks) {
      const bytes = await this.#input.authority.readChunk({
        syncId: this.#state.sync_id,
        digest: chunk.digest,
        byteLength: chunk.byte_length,
        signal,
      });
      if (bytes.byteLength !== chunk.byte_length || sha256(bytes) !== chunk.digest) {
        throw syncFailure("remote_chunk_mismatch", EXIT_CODES.policy);
      }
      chunks.push(bytes);
    }
    await atomicReplaceFile(this.#input.canonicalRoot, physical, chunks, item.entry.executable, true);
  }

  async #reconcile(signal: AbortSignal): Promise<void> {
    await this.#transition({ status: "reconciling", dirty: true, reason: "manifest_reconciliation" });
    const manifest = await this.#buildManifest();
    const receipt = await this.#input.authority.reconcile({
      generation: this.#state.generation,
      manifestRoot: manifest.manifestRoot,
      signal,
    });
    if (receipt.status === "converged") {
      if (receipt.generation !== this.#state.generation || receipt.manifestRoot !== manifest.manifestRoot) {
        throw syncFailure("reconcile_receipt_mismatch", EXIT_CODES.remote);
      }
      await this.#replaceState({
        manifest_root: manifest.manifestRoot,
        baseline: projectManifest(manifest),
        dirty: false,
        status: "converged",
        reason: null,
      });
      return;
    }
    if (receipt.generation < this.#state.generation) throw syncFailure("remote_generation_rollback", EXIT_CODES.policy);
    if (
      this.#state.pending_local.length > 0 &&
      receipt.generation === this.#state.generation + 1 &&
      receipt.manifestRoot === manifest.manifestRoot
    ) {
      for (const operation of this.#state.pending_local) {
        await transitionToApplied(this.#journal, operation.operationId);
      }
      await this.#replaceState({
        generation: receipt.generation,
        manifest_root: receipt.manifestRoot,
        baseline: projectManifest(manifest),
        pending_local: [],
        cursor: null,
        dirty: false,
        status: "converged",
        reason: null,
      });
      return;
    }
    await this.#replaceState({ status: "reconciling", dirty: true, reason: "canonical_divergence" });
  }

  async #recoverPendingLocal(): Promise<void> {
    if (this.#state.pending_local.length === 0) return;
    const latest = latestJournalStates(this.#journal?.records ?? []);
    const uncertain = this.#state.pending_local.some((operation) => {
      const state = latest.get(operation.operationId);
      return state === "sending" || state === "uncertain" || state === "acknowledged";
    });
    if (uncertain) {
      await this.#transition({ status: "reconciling", dirty: true, reason: "uncertain_local_commit" });
      this.#reconcileRequested = true;
      return;
    }
    this.#scanRequested = true;
  }

  async #buildManifest(): Promise<WorkspaceManifest> {
    return this.#manifestBuilder({
      root: this.#input.canonicalRoot,
      policy: this.#input.policy,
      capabilities: this.#input.filesystemCapabilities,
    });
  }

  async #transition(input: {
    readonly status: DurableSupervisorState["status"];
    readonly dirty?: boolean;
    readonly reason: string | null;
  }): Promise<void> {
    await this.#replaceState({
      status: input.status,
      ...(input.dirty === undefined ? {} : { dirty: input.dirty }),
      reason: input.reason,
    });
  }

  async #replaceState(patch: Partial<DurableSupervisorState>): Promise<void> {
    const next = Object.freeze({
      ...this.#state,
      ...patch,
      schema_version: STATE_SCHEMA as 1,
      updated_at: new Date(this.#clock()).toISOString(),
    });
    this.#state = admitState(next, this.#input);
    await atomicWriteState(this.#statePath, this.#state);
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* Projection observers cannot own sync correctness. */ }
    }
  }

  async #waitForWake(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (this.#scanRequested || this.#reconcileRequested) return;
    await new Promise<void>((resolveWake, rejectWake) => {
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => finish(signal.reason);
      const wake = () => finish();
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (this.#wake === wake) this.#wake = undefined;
        if (error === undefined) resolveWake();
        else rejectWake(error);
      };
      timer = setTimeout(finish, milliseconds);
      this.#wake = wake;
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function createInitialState(input: ContinuousWorkspaceSyncSupervisorInput, manifest: WorkspaceManifest): DurableSupervisorState {
  return Object.freeze({
    schema_version: 1,
    binding_id: input.bindingId,
    binding_generation: input.bindingGeneration,
    policy_digest: input.policy.digest,
    sync_id: input.syncId,
    generation: input.initialGeneration,
    manifest_root: input.initialManifestRoot,
    cursor: null,
    dirty: false,
    status: "recovering",
    reason: null,
    baseline: projectManifest(manifest),
    pending_local: Object.freeze([]),
    pending_remote: null,
    updated_at: new Date(input.clock?.() ?? Date.now()).toISOString(),
  });
}

function projectManifest(manifest: WorkspaceManifest): readonly EntryProjection[] {
  return Object.freeze(manifest.entries.map((entry) => Object.freeze({
    path: entry.path,
    kind: entry.kind,
    fingerprint: entryFingerprint(entry),
    byteLength: entry.byteLength,
  })));
}

function diffManifest(
  baselineEntries: readonly EntryProjection[],
  manifest: WorkspaceManifest,
  baseGeneration: number,
): readonly PendingLocalOperation[] {
  const baseline = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const current = new Map(projectManifest(manifest).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return Object.freeze(paths.flatMap((path) => {
    const before = baseline.get(path);
    const after = current.get(path);
    if (sameProjection(before, after)) return [];
    const kind = before === undefined ? "create" : after === undefined ? "delete" : "update";
    const fingerprint = after?.fingerprint ?? ZERO_DIGEST;
    return [Object.freeze({
      operationId: randomUUID(),
      path,
      kind,
      baseGeneration,
      fingerprint,
      byteLength: after?.byteLength ?? 0,
    })];
  }));
}

function entryFingerprint(entry: ManifestEntry): string {
  return createHash("sha256").update(JSON.stringify({
    path: entry.path,
    kind: entry.kind,
    byte_length: entry.kind === "symlink" ? 0 : entry.byteLength,
    executable: entry.executable,
    chunks: entry.chunks?.map((chunk) => ({ digest: chunk.digest, byte_length: chunk.byteLength })) ?? [],
    link_target: entry.linkTarget ?? null,
  })).digest("hex");
}

function sameProjection(left: EntryProjection | undefined, right: EntryProjection | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.fingerprint === right.fingerprint && left.kind === right.kind;
}

function orderRemoteItems(items: readonly WorkspaceSyncChangeItem[]): readonly WorkspaceSyncChangeItem[] {
  const revisions = items.filter((item) => item.operation === "revision");
  const directoryCreates = items.filter((item) => item.operation === "upsert" && item.entry?.kind === "directory")
    .sort((left, right) => depth(left.path) - depth(right.path));
  const upserts = items.filter((item) => item.operation === "upsert" && item.entry?.kind !== "directory");
  const deletes = items.filter((item) => item.operation === "delete")
    .sort((left, right) => depth(right.path) - depth(left.path));
  return Object.freeze([...revisions, ...directoryCreates, ...upserts, ...deletes]);
}

function depth(path: string | null): number {
  return path?.split("/").length ?? 0;
}

function commonRemoteField<K extends "manifest_root" | "exclusion_policy_digest">(
  items: readonly WorkspaceSyncChangeItem[],
  field: K,
): WorkspaceSyncChangeItem[K] {
  const first = items[0]?.[field];
  if (first === undefined || items.some((item) => item[field] !== first)) {
    throw syncFailure("remote_generation_inconsistent", EXIT_CODES.remote);
  }
  return first;
}

async function atomicReplaceFile(
  root: string,
  path: string,
  chunks: readonly Uint8Array[],
  executable: boolean,
  requireMissing = false,
): Promise<void> {
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeAncestors(root, dirname(path));
  if (requireMissing && await pathExists(path)) throw syncFailure("conflict_retention_collision", EXIT_CODES.conflict);
  await assertReplaceTarget(path);
  const temporary = join(dirname(path), `.${basename(path)}.cuna-apply-${randomUUID()}.tmp`);
  const handle = await open(temporary, fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY | noFollowFlag(), 0o600);
  try {
    for (const bytes of chunks) await handle.write(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await chmod(temporary, executable ? 0o700 : 0o600);
    await assertSafeAncestors(root, dirname(path));
    await assertReplaceTarget(path);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function safeDelete(root: string, path: string): Promise<void> {
  await assertSafeAncestors(root, dirname(path));
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()) || (metadata.isFile() && metadata.nlink !== 1)) {
      throw syncFailure("delete_target_untrusted", EXIT_CODES.policy);
    }
    if (metadata.isDirectory()) await rmdir(path);
    else await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ensureSafeDirectory(root: string, requested: string): Promise<void> {
  const target = assertLexicallyInsideRoot(root, requested);
  const difference = relative(root, target);
  let current = root;
  for (const component of difference.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw syncFailure("ancestor_untrusted", EXIT_CODES.policy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw syncFailure("ancestor_untrusted", EXIT_CODES.policy);
    }
  }
  await assertSafeAncestors(root, target);
}

async function assertSafeAncestors(root: string, directory: string): Promise<void> {
  const target = assertLexicallyInsideRoot(root, directory);
  const canonical = await realpath(target);
  const difference = relative(root, canonical);
  if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw syncFailure("ancestor_escape", EXIT_CODES.policy);
  }
  let current = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw syncFailure("ancestor_untrusted", EXIT_CODES.policy);
  }
}

async function assertReplaceTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw syncFailure("replace_target_untrusted", EXIT_CODES.policy);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fileConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function canonicalPlainDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw syncFailure("root_untrusted", EXIT_CODES.policy);
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw syncFailure("root_untrusted", EXIT_CODES.policy);
  return canonical;
}

async function preparePrivateDirectory(path: string, workspaceRoot: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw syncFailure("state_directory_untrusted", EXIT_CODES.policy);
  const requested = resolve(path);
  if (isSameOrInside(workspaceRoot, requested)) throw syncFailure("state_inside_workspace", EXIT_CODES.policy);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const canonical = await realpath(requested);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || isSameOrInside(workspaceRoot, canonical)) {
    throw syncFailure("state_directory_untrusted", EXIT_CODES.policy);
  }
  await chmod(canonical, 0o700).catch((error) => {
    if (process.platform !== "win32") throw error;
  });
  return canonical;
}

async function loadState(path: string): Promise<unknown | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) {
      throw syncFailure("state_file_untrusted", EXIT_CODES.policy);
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWriteState(path: string, state: DurableSupervisorState): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Windows rejects FlushFileBuffers on a read-only handle. Open the private
    // temporary read/write solely for durability; no bytes are changed here.
    const handle = await open(temporary, fileConstants.O_RDWR | noFollowFlag());
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await chmod(path, 0o600).catch((error) => { if (process.platform !== "win32") throw error; });
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function admitState(value: unknown, input: ContinuousWorkspaceSyncSupervisorInput): DurableSupervisorState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const source = value as Record<string, unknown>;
  const keys = [
    "baseline", "binding_generation", "binding_id", "cursor", "dirty", "generation",
    "manifest_root", "pending_local", "pending_remote", "policy_digest", "reason",
    "schema_version", "status", "sync_id", "updated_at",
  ];
  if (Object.keys(source).sort().join("\0") !== keys.sort().join("\0") || source.schema_version !== STATE_SCHEMA) {
    throw syncFailure("state_schema_incompatible", EXIT_CODES.conflict);
  }
  if (
    source.binding_id !== input.bindingId ||
    source.binding_generation !== input.bindingGeneration ||
    source.policy_digest !== input.policy.digest
  ) throw syncFailure("state_identity_mismatch", EXIT_CODES.policy);
  const statusValues = new Set(["recovering", "reconciling", "catching_up", "live_unverified", "converged", "conflicted", "paused", "recovery_required", "unknown"]);
  if (
    !isUuid(source.sync_id) ||
    !Number.isSafeInteger(source.generation) || (source.generation as number) < 0 ||
    !isDigest(source.manifest_root) ||
    (source.cursor !== null && (typeof source.cursor !== "string" || source.cursor.length < 1 || source.cursor.length > 1_024)) ||
    typeof source.dirty !== "boolean" ||
    typeof source.status !== "string" || !statusValues.has(source.status) ||
    (source.reason !== null && (typeof source.reason !== "string" || source.reason.length < 1 || source.reason.length > 128)) ||
    typeof source.updated_at !== "string" || !Number.isFinite(Date.parse(source.updated_at)) ||
    !Array.isArray(source.baseline) || !Array.isArray(source.pending_local)
  ) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const baseline = Object.freeze(source.baseline.map(decodeEntryProjection));
  const pendingLocal = Object.freeze(source.pending_local.map(decodePendingLocal));
  const pendingRemote = source.pending_remote === null ? null : decodePendingRemote(source.pending_remote);
  return Object.freeze({
    schema_version: 1,
    binding_id: input.bindingId,
    binding_generation: input.bindingGeneration,
    policy_digest: input.policy.digest,
    sync_id: source.sync_id as string,
    generation: source.generation as number,
    manifest_root: source.manifest_root as string,
    cursor: source.cursor as string | null,
    dirty: source.dirty,
    status: source.status as DurableSupervisorState["status"],
    reason: source.reason as string | null,
    baseline,
    pending_local: pendingLocal,
    pending_remote: pendingRemote,
    updated_at: source.updated_at,
  });
}

function decodeEntryProjection(value: unknown): EntryProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).sort().join("\0") !== ["byteLength", "fingerprint", "kind", "path"].join("\0") ||
    typeof source.path !== "string" || !isDigest(source.fingerprint) ||
    !["directory", "file", "symlink"].includes(source.kind as string) ||
    !Number.isSafeInteger(source.byteLength) || (source.byteLength as number) < 0
  ) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  return Object.freeze(source as unknown as EntryProjection);
}

function decodePendingLocal(value: unknown): PendingLocalOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const source = value as Record<string, unknown>;
  const expected = ["baseGeneration", "byteLength", "fingerprint", "kind", "operationId", "path"];
  if (
    Object.keys(source).sort().join("\0") !== expected.join("\0") || !isUuid(source.operationId) ||
    typeof source.path !== "string" || !["create", "update", "delete"].includes(source.kind as string) ||
    !Number.isSafeInteger(source.baseGeneration) || (source.baseGeneration as number) < 0 ||
    !Number.isSafeInteger(source.byteLength) || (source.byteLength as number) < 0 || !isDigest(source.fingerprint)
  ) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  return Object.freeze(source as unknown as PendingLocalOperation);
}

function decodePendingRemote(value: unknown): PendingRemoteApply {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const source = value as Record<string, unknown>;
  const expected = ["cursor", "generation", "items", "manifestRoot", "nextIndex"];
  if (
    Object.keys(source).sort().join("\0") !== expected.join("\0") ||
    !Number.isSafeInteger(source.generation) || (source.generation as number) < 1 || !isDigest(source.manifestRoot) ||
    (source.cursor !== null && (typeof source.cursor !== "string" || source.cursor.length < 1 || source.cursor.length > 1_024)) ||
    !Array.isArray(source.items) || !Number.isSafeInteger(source.nextIndex) || (source.nextIndex as number) < 0 ||
    (source.nextIndex as number) > source.items.length
  ) throw syncFailure("state_invalid", EXIT_CODES.conflict);
  const decodedItems = decodeChangePage({
    selected_protocol: 1,
    items: source.items,
    next_cursor: null,
  }).items;
  return Object.freeze({
    generation: source.generation as number,
    manifestRoot: source.manifestRoot as string,
    cursor: source.cursor as string | null,
    items: decodedItems,
    nextIndex: source.nextIndex as number,
  });
}

async function createNodeWorkspaceWatcher(input: {
  readonly root: string;
  readonly onEvent: (event: WorkspaceWatchEvent) => void;
  readonly onError: (error: unknown) => void;
}): Promise<WorkspaceWatchSubscription> {
  let watcher: FSWatcher;
  try {
    watcher = watch(input.root, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename === null) input.onEvent({ kind: "overflow" });
      else input.onEvent({ kind: "change", path: filename.toString() });
    });
  } catch (error) {
    throw syncFailure("watcher_unavailable", EXIT_CODES.unsupported, error);
  }
  watcher.on("error", input.onError);
  return Object.freeze({ close: () => watcher.close() });
}

function validateInput(input: ContinuousWorkspaceSyncSupervisorInput): void {
  if (
    !isUuid(input.bindingId) || !isUuid(input.syncId) ||
    !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 1 ||
    !Number.isSafeInteger(input.initialGeneration) || input.initialGeneration < 1 ||
    !isDigest(input.initialManifestRoot) || !isDigest(input.policy.digest)
  ) throw syncFailure("input_invalid", EXIT_CODES.usage);
  for (const value of [
    input.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    input.reconciliationIntervalMs ?? DEFAULT_RECONCILE_MS,
    input.remotePollIntervalMs ?? DEFAULT_REMOTE_POLL_MS,
    input.maximumPendingOperations ?? DEFAULT_OPERATION_LIMIT,
    input.maximumPendingBytes ?? DEFAULT_BYTE_LIMIT,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw syncFailure("limit_invalid", EXIT_CODES.usage);
  }
}

function latestJournalStates(records: readonly { readonly operationId: string; readonly state: JournalOperationState }[]): Map<string, JournalOperationState> {
  const result = new Map<string, JournalOperationState>();
  for (const record of records) result.set(record.operationId, record.state);
  return result;
}

function samePendingIntent(
  durable: readonly PendingLocalOperation[],
  observed: readonly PendingLocalOperation[],
): boolean {
  if (durable.length !== observed.length) return false;
  return durable.every((operation, index) => {
    const candidate = observed[index];
    return candidate !== undefined &&
      operation.path === candidate.path &&
      operation.kind === candidate.kind &&
      operation.baseGeneration === candidate.baseGeneration &&
      operation.fingerprint === candidate.fingerprint &&
      operation.byteLength === candidate.byteLength;
  });
}

async function transitionIfQueued(journal: DurableSyncJournal | undefined, operationId: string): Promise<void> {
  const latest = [...(journal?.records ?? [])].reverse().find((record) => record.operationId === operationId);
  if (latest?.state === "queued") await journal?.transition(operationId, "sending");
  else if (latest?.state !== "sending" && latest?.state !== "uncertain") {
    throw syncFailure("journal_operation_state_invalid", EXIT_CODES.conflict);
  }
}

async function transitionToApplied(journal: DurableSyncJournal | undefined, operationId: string): Promise<void> {
  let latest = [...(journal?.records ?? [])].reverse().find((record) => record.operationId === operationId)?.state;
  if (latest === "queued") {
    await journal?.transition(operationId, "sending");
    latest = "sending";
  }
  if (latest === "sending") {
    await journal?.transition(operationId, "uncertain");
    latest = "uncertain";
  }
  if (latest === "uncertain") {
    await journal?.transition(operationId, "acknowledged");
    latest = "acknowledged";
  }
  if (latest === "acknowledged") await journal?.transition(operationId, "applied");
}

async function transitionIfPossible(journal: DurableSyncJournal | undefined, operationId: string, state: JournalOperationState): Promise<void> {
  try { await journal?.transition(operationId, state); } catch { /* preserve the original ambiguous failure */ }
}

function classifyFailure(error: unknown): { readonly status: "paused" | "reconciling" | "conflicted" | "recovery_required"; readonly reason: string } {
  if (error instanceof RunaError) {
    const reason = typeof error.details?.reason === "string" ? error.details.reason : error.code;
    if (
      error.code === "runa.workspace_sync.contract_mismatch" ||
      error.code === "runa.workspace.path_invalid" ||
      error.code === "runa.workspace.path_escape"
    ) return { status: "recovery_required", reason };
    if (error.exitCode === EXIT_CODES.conflict) return { status: "conflicted", reason };
    if (error.exitCode === EXIT_CODES.policy || error.exitCode === EXIT_CODES.usage || error.exitCode === EXIT_CODES.unsupported) {
      return { status: "recovery_required", reason };
    }
    return { status: "paused", reason };
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSPC" || code === "EDQUOT") return { status: "paused", reason: "disk_exhausted" };
  return { status: "paused", reason: "dependency_unavailable" };
}

function isAbort(error: unknown): boolean {
  return error instanceof RunaError && error.details?.reason === "cancelled";
}

function isSameOrInside(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function noFollowFlag(): number {
  return typeof fileConstants.O_NOFOLLOW === "number" ? fileConstants.O_NOFOLLOW : 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function syncFailure(reason: string, exitCode: number, cause?: unknown): RunaError {
  return new RunaError({
    code: "runa.workspace_sync.continuous_failed",
    message: "Continuous workspace synchronization could not preserve its safety contract.",
    exitCode: exitCode as typeof EXIT_CODES[keyof typeof EXIT_CODES],
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolveSleep, rejectSleep) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => finish(signal.reason);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolveSleep();
      else rejectSleep(error);
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
