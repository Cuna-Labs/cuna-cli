import { createHash, randomUUID } from "node:crypto";

import { normalizeWirePath, type FilesystemCapabilities } from "../workspace/paths.js";
import { workspaceError } from "../workspace/errors.js";

export type VectorClock = Readonly<Record<string, number>>;
export type ClockRelation = "equal" | "before" | "after" | "concurrent";

export interface VersionReference {
  readonly kind: "file" | "directory" | "symlink" | "tombstone";
  readonly digest: string | null;
  readonly clock: VectorClock;
  readonly operationId: string;
}

export interface WorkspaceRevision {
  readonly schemaVersion: 2;
  readonly minimumReaderVersion: 1;
  readonly minimumWriterVersion: 2;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly parentIds: readonly string[];
  readonly manifestRoot: string;
  readonly policyDigest: string;
  readonly tree: Readonly<Record<string, VersionReference>>;
}

export type OverlayState =
  | "writable"
  | "sealed"
  | "merge_pending"
  | "merged"
  | "conflicted"
  | "retained";

export interface SessionOverlay {
  readonly overlayId: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly userId: string;
  readonly agentSessionId: string;
  readonly baseRevision: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly state: OverlayState;
  readonly quotaBytes: number;
  readonly admittedBytes: number;
  readonly changes: Readonly<Record<string, VersionReference>>;
  readonly retentionDeadline?: string;
}

export type ConflictClass =
  | "modify_modify"
  | "modify_delete"
  | "create_create"
  | "rename_modify"
  | "rename_rename"
  | "kind_change"
  | "case_collision"
  | "permission_collision";

export type ConflictState = "quarantined" | "previewed" | "resolved" | "retained";

export interface ConflictRecord {
  readonly conflictId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly class: ConflictClass;
  readonly base: VersionReference | null;
  readonly ours: VersionReference;
  readonly theirs: VersionReference;
  readonly generation: number;
  readonly state: ConflictState;
  readonly resolution?: "ours" | "theirs" | "delete" | "merged";
}

export function compareVectorClocks(left: VectorClock, right: VectorClock): ClockRelation {
  let less = false;
  let greater = false;
  const actors = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const actor of actors) {
    const leftValue = left[actor] ?? 0;
    const rightValue = right[actor] ?? 0;
    assertClockValue(leftValue);
    assertClockValue(rightValue);
    less ||= leftValue < rightValue;
    greater ||= leftValue > rightValue;
  }
  if (less && greater) return "concurrent";
  if (less) return "before";
  if (greater) return "after";
  return "equal";
}

export function incrementVectorClock(clock: VectorClock, actorId: string): VectorClock {
  if (actorId.length === 0) throw workspaceError("clock_invalid", "A causal actor is required.", "integrity", "empty_actor");
  return Object.freeze({ ...clock, [actorId]: (clock[actorId] ?? 0) + 1 });
}

export function mergeVectorClocks(...clocks: readonly VectorClock[]): VectorClock {
  const merged: Record<string, number> = {};
  for (const clock of clocks) {
    for (const [actor, value] of Object.entries(clock)) {
      assertClockValue(value);
      merged[actor] = Math.max(merged[actor] ?? 0, value);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))));
}

export function classifyConflict(input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly base: VersionReference | null;
  readonly ours: VersionReference;
  readonly theirs: VersionReference;
  readonly classHint?: ConflictClass;
}): { readonly disposition: "converged" | "ordered" | "conflict"; readonly conflict?: ConflictRecord } {
  if (sameVersion(input.ours, input.theirs)) return Object.freeze({ disposition: "converged" });
  const relation = compareVectorClocks(input.ours.clock, input.theirs.clock);
  if (relation !== "concurrent" && relation !== "equal") return Object.freeze({ disposition: "ordered" });
  const conflictClass = input.classHint ?? inferConflictClass(input.base, input.ours, input.theirs);
  const conflictId = stableDigest("runa-conflict-v2", {
    base: input.base,
    ours: input.ours,
    path: input.path,
    theirs: input.theirs,
    workspaceId: input.workspaceId,
  });
  return Object.freeze({
    disposition: "conflict",
    conflict: Object.freeze({
      conflictId,
      workspaceId: input.workspaceId,
      path: input.path,
      class: conflictClass,
      base: input.base,
      ours: input.ours,
      theirs: input.theirs,
      generation: 1,
      state: "quarantined",
    }),
  });
}

export class ConflictStore {
  readonly #records = new Map<string, ConflictRecord>();

  add(record: ConflictRecord): ConflictRecord {
    const existing = this.#records.get(record.conflictId);
    if (existing !== undefined) return existing;
    this.#records.set(record.conflictId, record);
    return record;
  }

  get(conflictId: string): ConflictRecord | undefined {
    return this.#records.get(conflictId);
  }

  preview(conflictId: string, expectedGeneration: number): ConflictRecord {
    return this.#transition(conflictId, expectedGeneration, "previewed");
  }

  resolve(
    conflictId: string,
    expectedGeneration: number,
    resolution: "ours" | "theirs" | "delete" | "merged",
  ): ConflictRecord {
    const current = this.#required(conflictId);
    if (current.state !== "previewed") {
      throw workspaceError("conflict_state", "The conflict must be previewed before resolution.", "conflict", "preview_required");
    }
    if (current.generation !== expectedGeneration) throw conflictCasFailure();
    const next = Object.freeze({
      ...current,
      generation: current.generation + 1,
      state: "resolved" as const,
      resolution,
    });
    this.#records.set(conflictId, next);
    return next;
  }

  #transition(conflictId: string, expectedGeneration: number, state: ConflictState): ConflictRecord {
    const current = this.#required(conflictId);
    if (current.generation !== expectedGeneration) throw conflictCasFailure();
    const next = Object.freeze({ ...current, generation: current.generation + 1, state });
    this.#records.set(conflictId, next);
    return next;
  }

  #required(conflictId: string): ConflictRecord {
    const record = this.#records.get(conflictId);
    if (record === undefined) {
      throw workspaceError("conflict_unknown", "The conflict reference is unavailable.", "conflict", "not_found");
    }
    return record;
  }
}

export class RevisionOverlayStore {
  readonly #revisions = new Map<string, WorkspaceRevision>();
  readonly #overlays = new Map<string, SessionOverlay>();
  readonly #overlayBySession = new Map<string, string>();
  readonly #overlayPathBytes = new Map<string, Map<string, number>>();
  readonly #conflicts = new ConflictStore();
  #head: string;

  constructor(initialRevision: WorkspaceRevision) {
    this.#revisions.set(initialRevision.revisionId, initialRevision);
    this.#head = initialRevision.revisionId;
  }

  get head(): WorkspaceRevision {
    return this.#requiredRevision(this.#head);
  }

  get conflicts(): ConflictStore {
    return this.#conflicts;
  }

  allocateOverlay(input: {
    readonly workspaceId: string;
    readonly machineId: string;
    readonly userId: string;
    readonly agentSessionId: string;
    readonly baseRevision: string;
    readonly policyDigest: string;
    readonly quotaBytes: number;
    readonly confinementAvailable: boolean;
    readonly atomicRenameAvailable: boolean;
    readonly idFactory?: () => string;
  }): SessionOverlay {
    if (!input.confinementAvailable || !input.atomicRenameAvailable) {
      throw workspaceError(
        "overlay_unsupported",
        "Strong multi-writer mode is unavailable on this platform.",
        "unsupported",
        "confinement_or_atomicity_missing",
      );
    }
    if (this.#overlayBySession.has(input.agentSessionId)) {
      throw workspaceError("overlay_exists", "The AgentSession already owns an overlay.", "conflict", "one_overlay_per_session");
    }
    const base = this.#requiredRevision(input.baseRevision);
    if (base.workspaceId !== input.workspaceId || base.policyDigest !== input.policyDigest) {
      throw workspaceError("overlay_identity", "Overlay identity could not be proven.", "policy", "base_or_policy_mismatch");
    }
    if (!Number.isSafeInteger(input.quotaBytes) || input.quotaBytes < 1) {
      throw workspaceError("overlay_quota", "Overlay quota is invalid.", "policy", "invalid_quota");
    }
    const overlay = Object.freeze({
      overlayId: (input.idFactory ?? randomUUID)(),
      workspaceId: input.workspaceId,
      machineId: input.machineId,
      userId: input.userId,
      agentSessionId: input.agentSessionId,
      baseRevision: input.baseRevision,
      policyDigest: input.policyDigest,
      generation: 1,
      state: "writable" as const,
      quotaBytes: input.quotaBytes,
      admittedBytes: 0,
      changes: Object.freeze({}),
    });
    this.#overlays.set(overlay.overlayId, overlay);
    this.#overlayBySession.set(input.agentSessionId, overlay.overlayId);
    this.#overlayPathBytes.set(overlay.overlayId, new Map());
    return overlay;
  }

  applyChange(input: {
    readonly overlayId: string;
    readonly agentSessionId: string;
    readonly expectedGeneration: number;
    readonly path: string;
    readonly capabilities: FilesystemCapabilities;
    readonly version: VersionReference;
    readonly accountedBytes: number;
  }): SessionOverlay {
    const overlay = this.#requiredOverlay(input.overlayId);
    if (overlay.agentSessionId !== input.agentSessionId) throw nonDisclosingOverlayFailure();
    if (overlay.state !== "writable" || overlay.generation !== input.expectedGeneration) throw overlayCasFailure();
    const path = normalizeWirePath(input.path, input.capabilities);
    if (!Number.isSafeInteger(input.accountedBytes) || input.accountedBytes < 0) {
      throw workspaceError("overlay_quota", "Overlay accounting is invalid.", "integrity", "invalid_accounting");
    }
    const pathBytes = this.#overlayPathBytes.get(input.overlayId);
    if (pathBytes === undefined) throw nonDisclosingOverlayFailure();
    const previousBytes = pathBytes.get(path) ?? 0;
    const admittedBytes = overlay.admittedBytes - previousBytes + input.accountedBytes;
    if (admittedBytes > overlay.quotaBytes) {
      throw workspaceError("overlay_full", "The overlay quota is exhausted.", "policy", "quota_exhausted");
    }
    const next = Object.freeze({
      ...overlay,
      generation: overlay.generation + 1,
      admittedBytes,
      changes: Object.freeze({ ...overlay.changes, [path]: freezeVersion(input.version) }),
    });
    pathBytes.set(path, input.accountedBytes);
    this.#overlays.set(input.overlayId, next);
    return next;
  }

  seal(
    overlayId: string,
    agentSessionId: string,
    expectedGeneration: number,
    retentionDeadline?: string,
  ): SessionOverlay {
    const overlay = this.#requiredOverlay(overlayId);
    if (overlay.agentSessionId !== agentSessionId) throw nonDisclosingOverlayFailure();
    if (overlay.state !== "writable" || overlay.generation !== expectedGeneration) throw overlayCasFailure();
    const next = Object.freeze({
      ...overlay,
      generation: overlay.generation + 1,
      state: "sealed" as const,
      ...(retentionDeadline === undefined ? {} : { retentionDeadline }),
    });
    this.#overlays.set(overlayId, next);
    return next;
  }

  merge(input: {
    readonly overlayId: string;
    readonly agentSessionId: string;
    readonly expectedOverlayGeneration: number;
    readonly expectedHead: string;
    readonly policyDigest: string;
  }): { readonly overlay: SessionOverlay; readonly revision?: WorkspaceRevision; readonly conflicts: readonly ConflictRecord[] } {
    const overlay = this.#requiredOverlay(input.overlayId);
    if (overlay.agentSessionId !== input.agentSessionId) throw nonDisclosingOverlayFailure();
    if (overlay.state !== "sealed" || overlay.generation !== input.expectedOverlayGeneration) throw overlayCasFailure();
    if (input.expectedHead !== this.#head || input.policyDigest !== overlay.policyDigest) {
      throw workspaceError("merge_stale", "The canonical revision or policy changed before merge.", "conflict", "head_or_policy_cas");
    }
    const base = this.#requiredRevision(overlay.baseRevision);
    const head = this.head;
    const conflicts: ConflictRecord[] = [];
    const resultTree: Record<string, VersionReference> = { ...head.tree };
    for (const [path, ours] of Object.entries(overlay.changes).sort(([a], [b]) => a.localeCompare(b))) {
      const baseVersion = base.tree[path] ?? null;
      const theirs = head.tree[path] ?? tombstoneFor(path, head.revisionId);
      if (sameNullableVersion(baseVersion, head.tree[path] ?? null) || sameVersion(ours, theirs)) {
        if (ours.kind === "tombstone") delete resultTree[path];
        else resultTree[path] = ours;
        continue;
      }
      const classification = classifyConflict({
        workspaceId: overlay.workspaceId,
        path,
        base: baseVersion,
        ours,
        theirs,
      });
      if (classification.disposition === "conflict" && classification.conflict !== undefined) {
        conflicts.push(this.#conflicts.add(classification.conflict));
      } else if (classification.disposition === "ordered" && compareVectorClocks(ours.clock, theirs.clock) === "after") {
        if (ours.kind === "tombstone") delete resultTree[path];
        else resultTree[path] = ours;
      }
    }
    if (conflicts.length > 0) {
      const conflicted = this.#setOverlayState(overlay, "conflicted");
      return Object.freeze({ overlay: conflicted, conflicts: Object.freeze(conflicts) });
    }
    const revision = createWorkspaceRevision({
      workspaceId: overlay.workspaceId,
      parentIds: [head.revisionId, ...(base.revisionId === head.revisionId ? [] : [base.revisionId])],
      policyDigest: overlay.policyDigest,
      tree: resultTree,
    });
    this.#revisions.set(revision.revisionId, revision);
    this.#head = revision.revisionId;
    const merged = this.#setOverlayState(overlay, "merged");
    return Object.freeze({ overlay: merged, revision, conflicts: Object.freeze([]) });
  }

  retainAfterExit(
    overlayId: string,
    agentSessionId: string,
    retentionDeadline: string,
  ): SessionOverlay {
    const overlay = this.#requiredOverlay(overlayId);
    if (overlay.agentSessionId !== agentSessionId) throw nonDisclosingOverlayFailure();
    if (overlay.state === "merged") return overlay;
    const next = Object.freeze({
      ...overlay,
      generation: overlay.generation + 1,
      state: "retained" as const,
      retentionDeadline,
    });
    this.#overlays.set(overlayId, next);
    return next;
  }

  #setOverlayState(overlay: SessionOverlay, state: OverlayState): SessionOverlay {
    const next = Object.freeze({ ...overlay, generation: overlay.generation + 1, state });
    this.#overlays.set(overlay.overlayId, next);
    return next;
  }

  #requiredOverlay(overlayId: string): SessionOverlay {
    const overlay = this.#overlays.get(overlayId);
    if (overlay === undefined) throw nonDisclosingOverlayFailure();
    return overlay;
  }

  #requiredRevision(revisionId: string): WorkspaceRevision {
    const revision = this.#revisions.get(revisionId);
    if (revision === undefined) {
      throw workspaceError("revision_unknown", "The workspace revision is unavailable.", "conflict", "not_found");
    }
    return revision;
  }
}

export function createWorkspaceRevision(input: {
  readonly workspaceId: string;
  readonly parentIds: readonly string[];
  readonly policyDigest: string;
  readonly tree: Readonly<Record<string, VersionReference>>;
}): WorkspaceRevision {
  const tree = Object.freeze(Object.fromEntries(
    Object.entries(input.tree)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, version]) => [path, freezeVersion(version)]),
  ));
  const parentIds = Object.freeze([...new Set(input.parentIds)].sort());
  const manifestRoot = stableDigest("runa-revision-tree-v2", tree);
  const revisionId = stableDigest("runa-revision-v2", {
    manifestRoot,
    parentIds,
    policyDigest: input.policyDigest,
    workspaceId: input.workspaceId,
  });
  return Object.freeze({
    schemaVersion: 2 as const,
    minimumReaderVersion: 1,
    minimumWriterVersion: 2,
    workspaceId: input.workspaceId,
    revisionId,
    parentIds,
    manifestRoot,
    policyDigest: input.policyDigest,
    tree,
  });
}

function inferConflictClass(
  base: VersionReference | null,
  ours: VersionReference,
  theirs: VersionReference,
): ConflictClass {
  if (ours.kind !== theirs.kind && ours.kind !== "tombstone" && theirs.kind !== "tombstone") return "kind_change";
  if (ours.kind === "tombstone" || theirs.kind === "tombstone") return "modify_delete";
  if (base === null) return "create_create";
  return "modify_modify";
}

function sameVersion(left: VersionReference, right: VersionReference): boolean {
  return left.kind === right.kind && left.digest === right.digest;
}

function sameNullableVersion(left: VersionReference | null, right: VersionReference | null): boolean {
  if (left === null || right === null) return left === right;
  return sameVersion(left, right);
}

function tombstoneFor(path: string, revisionId: string): VersionReference {
  return Object.freeze({ kind: "tombstone", digest: null, clock: Object.freeze({}), operationId: `absent:${revisionId}:${path}` });
}

function freezeVersion(version: VersionReference): VersionReference {
  return Object.freeze({ ...version, clock: Object.freeze({ ...version.clock }) });
}

function stableDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function assertClockValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw workspaceError("clock_invalid", "A causal revision clock is malformed.", "integrity", "invalid_counter");
  }
}

function conflictCasFailure() {
  return workspaceError("conflict_stale", "The conflict generation changed before resolution.", "conflict", "generation_cas");
}

function overlayCasFailure() {
  return workspaceError("overlay_stale", "The overlay state or generation changed.", "conflict", "generation_cas");
}

function nonDisclosingOverlayFailure() {
  return workspaceError("overlay_unavailable", "The overlay reference is unavailable.", "policy", "not_found_or_forbidden");
}
