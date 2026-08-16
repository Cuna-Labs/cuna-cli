import { createHash } from "node:crypto";
import { lstat, rmdir, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { assertLexicallyInsideRoot } from "./paths.js";
import { workspaceError } from "./errors.js";

export type LocalDataClass = "binding_metadata" | "sync_journal" | "conflict_copy" | "export_artifact";
export type LocalLifecycleState = "active" | "retained" | "deletion_pending" | "held" | "partially_deleted" | "deleted" | "unknown";

export interface LocalDataRecord {
  readonly dataId: string;
  readonly workspaceId: string;
  readonly class: LocalDataClass;
  readonly absoluteLocation: string;
  readonly policyVersion: string;
  readonly retentionDeadline: string;
  readonly legalHold?: {
    readonly authority: string;
    readonly reasonCode: string;
    readonly expiresAt: string;
  };
}

export interface LocalDeletionReceipt {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly inventoryDigest: string;
  readonly completedDataIds: readonly string[];
  readonly pendingDataIds: readonly string[];
  readonly state: LocalLifecycleState;
  readonly observedAt: string;
  readonly evidenceExpiresAt: string;
}

export interface SafeLocalExport {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly records: readonly {
    readonly dataId: string;
    readonly class: LocalDataClass;
    readonly relativeLocation: string;
    readonly policyVersion: string;
    readonly retentionDeadline: string;
  }[];
  readonly digest: string;
}

export function exportSafeLocalState(input: {
  readonly stateRoot: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly records: readonly LocalDataRecord[];
  readonly now?: Date;
}): SafeLocalExport {
  validateInventory(input.stateRoot, input.workspaceId, input.records);
  const records = Object.freeze(input.records
    .map((record) => Object.freeze({
      dataId: record.dataId,
      class: record.class,
      relativeLocation: relative(resolve(input.stateRoot), resolve(record.absoluteLocation)).split(sep).join("/"),
      policyVersion: record.policyVersion,
      retentionDeadline: record.retentionDeadline,
    }))
    .sort((left, right) => left.dataId.localeCompare(right.dataId)));
  const body = {
    schemaVersion: 1 as const,
    workspaceId: input.workspaceId,
    generation: input.generation,
    createdAt: (input.now ?? new Date()).toISOString(),
    records,
  };
  return Object.freeze({ ...body, digest: digest("cuna-local-export-v1", body) });
}

export async function deleteLocalState(input: {
  readonly stateRoot: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly authorized: boolean;
  readonly records: readonly LocalDataRecord[];
  readonly now?: Date;
  readonly evidenceTtlMs?: number;
}): Promise<LocalDeletionReceipt> {
  if (!input.authorized) {
    throw workspaceError("deletion_forbidden", "Local state deletion is not authorized.", "policy", "authorization_required");
  }
  validateInventory(input.stateRoot, input.workspaceId, input.records);
  const now = input.now ?? new Date();
  const inventoryDigest = digest("cuna-local-inventory-v1", input.records.map((record) => ({
    class: record.class,
    dataId: record.dataId,
    location: relative(resolve(input.stateRoot), resolve(record.absoluteLocation)).split(sep).join("/"),
    policyVersion: record.policyVersion,
  })).sort((left, right) => left.dataId.localeCompare(right.dataId)));
  const held = input.records.filter((record) =>
    record.legalHold !== undefined && Date.parse(record.legalHold.expiresAt) > now.getTime());
  if (held.length > 0) {
    return deletionReceipt(input, inventoryDigest, [], held.map((record) => record.dataId), "held", now);
  }
  const completed: string[] = [];
  const pending: string[] = [];
  for (const record of input.records) {
    try {
      const path = assertLexicallyInsideRoot(input.stateRoot, record.absoluteLocation);
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await rmdir(path);
      else await unlink(path);
      completed.push(record.dataId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") completed.push(record.dataId);
      else pending.push(record.dataId);
    }
  }
  return deletionReceipt(
    input,
    inventoryDigest,
    completed,
    pending,
    pending.length === 0 ? "deleted" : "partially_deleted",
    now,
  );
}

function deletionReceipt(
  input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly evidenceTtlMs?: number;
  },
  inventoryDigest: string,
  completedDataIds: readonly string[],
  pendingDataIds: readonly string[],
  state: LocalLifecycleState,
  now: Date,
): LocalDeletionReceipt {
  return Object.freeze({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    inventoryDigest,
    completedDataIds: Object.freeze([...completedDataIds].sort()),
    pendingDataIds: Object.freeze([...pendingDataIds].sort()),
    state,
    observedAt: now.toISOString(),
    evidenceExpiresAt: new Date(now.getTime() + (input.evidenceTtlMs ?? 300_000)).toISOString(),
  });
}

function validateInventory(stateRoot: string, workspaceId: string, records: readonly LocalDataRecord[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.workspaceId !== workspaceId) {
      throw workspaceError("lifecycle_identity", "Local lifecycle inventory crosses workspace identity.", "policy", "workspace_mismatch");
    }
    if (ids.has(record.dataId)) {
      throw workspaceError("lifecycle_inventory", "Local lifecycle inventory contains duplicate data IDs.", "integrity", "duplicate_data_id");
    }
    ids.add(record.dataId);
    assertLexicallyInsideRoot(stateRoot, record.absoluteLocation);
    if (!Number.isFinite(Date.parse(record.retentionDeadline))) {
      throw workspaceError("lifecycle_inventory", "Local lifecycle retention metadata is malformed.", "integrity", "invalid_deadline");
    }
  }
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}
