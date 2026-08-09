import { workspaceError } from "../workspace/errors.js";

export type SyncOperationKind = "create" | "update" | "delete" | "rename";

export interface QueuedSyncOperation {
  readonly operationId: string;
  readonly path: string;
  readonly kind: SyncOperationKind;
  readonly byteLength: number;
  readonly baseGeneration: number;
  readonly acknowledged: boolean;
}

export interface QueueAdmission {
  readonly admitted: boolean;
  readonly coalescedOperationId?: string;
  readonly dirty: boolean;
  readonly reason?: "operation_limit" | "byte_limit";
}

export class BoundedOperationQueue {
  readonly #maximumOperations: number;
  readonly #maximumBytes: number;
  readonly #items: QueuedSyncOperation[] = [];
  #bytes = 0;
  #dirty = false;

  constructor(maximumOperations = 10_000, maximumBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumOperations) || maximumOperations < 1) throw queueFailure("invalid_operation_limit");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw queueFailure("invalid_byte_limit");
    this.#maximumOperations = maximumOperations;
    this.#maximumBytes = maximumBytes;
  }

  get size(): number {
    return this.#items.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get items(): readonly QueuedSyncOperation[] {
    return Object.freeze([...this.#items]);
  }

  enqueue(operation: QueuedSyncOperation): QueueAdmission {
    validateOperation(operation);
    const candidate = this.#coalescingCandidate(operation);
    const replacedBytes = candidate === undefined ? 0 : candidate.item.byteLength;
    const nextSize = this.#items.length + (candidate === undefined ? 1 : 0);
    const nextBytes = this.#bytes - replacedBytes + operation.byteLength;
    if (nextSize > this.#maximumOperations || nextBytes > this.#maximumBytes) {
      this.#dirty = true;
      return Object.freeze({
        admitted: false,
        dirty: true,
        reason: nextSize > this.#maximumOperations ? "operation_limit" : "byte_limit",
      });
    }
    if (candidate === undefined) this.#items.push(Object.freeze(operation));
    else this.#items[candidate.index] = Object.freeze(operation);
    this.#bytes = nextBytes;
    return Object.freeze({
      admitted: true,
      dirty: this.#dirty,
      ...(candidate === undefined ? {} : { coalescedOperationId: candidate.item.operationId }),
    });
  }

  shift(): QueuedSyncOperation | undefined {
    const item = this.#items.shift();
    if (item !== undefined) this.#bytes -= item.byteLength;
    return item;
  }

  markReconciled(): void {
    if (this.#items.length !== 0) throw queueFailure("queue_not_drained");
    this.#dirty = false;
  }

  #coalescingCandidate(operation: QueuedSyncOperation): { readonly index: number; readonly item: QueuedSyncOperation } | undefined {
    if (operation.kind !== "create" && operation.kind !== "update") return undefined;
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index];
      if (item === undefined) continue;
      if (item.path !== operation.path) continue;
      if (item.kind === "delete" || item.kind === "rename" || item.acknowledged) return undefined;
      if (item.baseGeneration !== operation.baseGeneration) return undefined;
      return { index, item };
    }
    return undefined;
  }
}

export type SupervisorState =
  | "recovering"
  | "reconciling"
  | "catching_up"
  | "live_unverified"
  | "converged"
  | "conflicted"
  | "paused"
  | "recovery_required"
  | "unknown";

export interface SupervisorConfiguration {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly canonicalRoot: string;
  readonly policyDigest: string;
  readonly epoch: string;
}

export interface ConvergenceReceipt {
  readonly authority: "runa_workspace_service";
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly epoch: string;
  readonly policyDigest: string;
  readonly localManifestRoot: string;
  readonly canonicalManifestRoot: string;
  readonly canonicalRevision: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface SupervisorSnapshot {
  readonly state: SupervisorState;
  readonly dirty: boolean;
  readonly incrementalApplyPaused: boolean;
  readonly reason?: string;
  readonly canonicalRevision?: string;
  readonly evidenceExpiresAt?: string;
}

export class LocalSyncSupervisor {
  readonly configuration: SupervisorConfiguration;
  readonly operationQueue: BoundedOperationQueue;
  readonly terminalQueue: BoundedOperationQueue;
  readonly #listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  readonly #clock: () => number;
  #snapshot: SupervisorSnapshot = Object.freeze({
    state: "recovering",
    dirty: false,
    incrementalApplyPaused: true,
  });

  constructor(
    configuration: SupervisorConfiguration,
    limits?: {
      readonly syncOperations?: number;
      readonly syncBytes?: number;
      readonly terminalOperations?: number;
      readonly terminalBytes?: number;
      readonly clock?: () => number;
    },
  ) {
    this.configuration = Object.freeze({ ...configuration });
    this.operationQueue = new BoundedOperationQueue(limits?.syncOperations, limits?.syncBytes);
    this.terminalQueue = new BoundedOperationQueue(
      limits?.terminalOperations ?? 1_024,
      limits?.terminalBytes ?? 8 * 1024 * 1024,
    );
    this.#clock = limits?.clock ?? Date.now;
  }

  get snapshot(): SupervisorSnapshot {
    if (
      this.#snapshot.state === "converged" &&
      this.#snapshot.evidenceExpiresAt !== undefined &&
      Date.parse(this.#snapshot.evidenceExpiresAt) <= this.#clock()
    ) {
      return Object.freeze({
        state: "unknown",
        dirty: true,
        incrementalApplyPaused: true,
        reason: "convergence_evidence_expired",
        evidenceExpiresAt: this.#snapshot.evidenceExpiresAt,
      });
    }
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  beginReconciliation(reason: string): void {
    this.#publish({ state: "reconciling", dirty: true, incrementalApplyPaused: true, reason });
  }

  watcherOverflow(): void {
    this.beginReconciliation("watcher_overflow");
  }

  sequenceGap(): void {
    this.beginReconciliation("sequence_gap");
  }

  budgetExhausted(reason: "disk" | "api_quota" | "network" | "queue"): void {
    this.#publish({ state: "paused", dirty: true, incrementalApplyPaused: true, reason: `${reason}_budget_exhausted` });
  }

  conflictObserved(): void {
    this.#publish({ state: "conflicted", dirty: this.snapshot.dirty, incrementalApplyPaused: false, reason: "path_conflict" });
  }

  markLiveUnverified(): void {
    this.#publish({ state: "live_unverified", dirty: this.snapshot.dirty, incrementalApplyPaused: false });
  }

  confirmConvergence(receipt: ConvergenceReceipt, now = Date.now()): void {
    if (
      receipt.authority !== "runa_workspace_service" ||
      receipt.bindingId !== this.configuration.bindingId ||
      receipt.bindingGeneration !== this.configuration.bindingGeneration ||
      receipt.epoch !== this.configuration.epoch ||
      receipt.policyDigest !== this.configuration.policyDigest ||
      receipt.localManifestRoot !== receipt.canonicalManifestRoot ||
      Date.parse(receipt.expiresAt) <= now
    ) {
      this.#publish({ state: "unknown", dirty: true, incrementalApplyPaused: true, reason: "convergence_evidence_invalid" });
      return;
    }
    this.#publish({
      state: "converged",
      dirty: false,
      incrementalApplyPaused: false,
      canonicalRevision: receipt.canonicalRevision,
      evidenceExpiresAt: receipt.expiresAt,
    });
  }

  #publish(snapshot: SupervisorSnapshot): void {
    this.#snapshot = Object.freeze({ ...snapshot });
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export class SyncSupervisorRegistry {
  readonly #supervisors = new Map<string, LocalSyncSupervisor>();

  connect(
    configuration: SupervisorConfiguration,
    clock: () => number = Date.now,
  ): { readonly supervisor: LocalSyncSupervisor; readonly created: boolean } {
    const existing = this.#supervisors.get(configuration.bindingId);
    if (existing !== undefined) {
      if (!sameConfiguration(existing.configuration, configuration)) {
        throw workspaceError(
          "supervisor_conflict",
          "An incompatible supervisor already owns this binding.",
          "conflict",
          "configuration_mismatch",
        );
      }
      return Object.freeze({ supervisor: existing, created: false });
    }
    const supervisor = new LocalSyncSupervisor(configuration, { clock });
    this.#supervisors.set(configuration.bindingId, supervisor);
    return Object.freeze({ supervisor, created: true });
  }

  release(bindingId: string, supervisor: LocalSyncSupervisor): boolean {
    if (this.#supervisors.get(bindingId) !== supervisor) return false;
    return this.#supervisors.delete(bindingId);
  }
}

export type ProgressStage =
  | "enumerating"
  | "hashing"
  | "negotiating"
  | "uploading"
  | "verifying"
  | "committed";

export interface ProgressReceipt {
  readonly authority: "local_manifest" | "runa_workspace_service";
  readonly stage: ProgressStage;
  readonly observedEntries: number;
  readonly observedBytes: number;
  readonly totalEntries?: number;
  readonly totalBytes?: number;
  readonly canonicalRevision?: string;
  readonly observedAt: string;
}

export interface TruthfulProgress {
  readonly stage: ProgressStage;
  readonly observedEntries: number;
  readonly observedBytes: number;
  readonly totalEntries?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly ready: boolean;
  readonly canonicalRevision?: string;
}

export function progressFromReceipt(receipt: ProgressReceipt): TruthfulProgress {
  validateCount(receipt.observedEntries);
  validateCount(receipt.observedBytes);
  if (receipt.totalEntries !== undefined) validateCount(receipt.totalEntries);
  if (receipt.totalBytes !== undefined) validateCount(receipt.totalBytes);
  const committed = receipt.stage === "committed";
  if (committed && (receipt.authority !== "runa_workspace_service" || receipt.canonicalRevision === undefined)) {
    throw workspaceError("progress_unproven", "Committed progress requires a server admission receipt.", "integrity", "authority_missing");
  }
  const percent = receipt.totalBytes !== undefined && receipt.totalBytes > 0
    ? Math.min(100, Math.floor((receipt.observedBytes / receipt.totalBytes) * 100))
    : undefined;
  return Object.freeze({
    stage: receipt.stage,
    observedEntries: receipt.observedEntries,
    observedBytes: receipt.observedBytes,
    ...(receipt.totalEntries === undefined ? {} : { totalEntries: receipt.totalEntries }),
    ...(receipt.totalBytes === undefined ? {} : { totalBytes: receipt.totalBytes }),
    ...(percent === undefined ? {} : { percent }),
    ready: committed,
    ...(receipt.canonicalRevision === undefined ? {} : { canonicalRevision: receipt.canonicalRevision }),
  });
}

function sameConfiguration(left: SupervisorConfiguration, right: SupervisorConfiguration): boolean {
  return left.bindingGeneration === right.bindingGeneration &&
    left.canonicalRoot === right.canonicalRoot &&
    left.policyDigest === right.policyDigest &&
    left.epoch === right.epoch;
}

function validateOperation(operation: QueuedSyncOperation): void {
  if (
    operation.operationId.length === 0 ||
    operation.path.length === 0 ||
    !Number.isSafeInteger(operation.byteLength) ||
    operation.byteLength < 0 ||
    !Number.isSafeInteger(operation.baseGeneration) ||
    operation.baseGeneration < 0
  ) throw queueFailure("invalid_operation");
}

function validateCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw workspaceError("progress_invalid", "A progress receipt contains an invalid measured count.", "integrity", "invalid_count");
  }
}

function queueFailure(reason: string) {
  return workspaceError("queue_invalid", "The bounded synchronization queue cannot accept the operation.", "policy", reason);
}
