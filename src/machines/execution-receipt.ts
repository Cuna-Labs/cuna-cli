import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformAdapter } from "../platform/adapter.js";
import { assertCanonicalUuid } from "../core/validation.js";

export interface ExecutionReceiptScope {
  readonly baseUrl: string;
  readonly profile: string;
  readonly userId: string;
}
export interface ExecutionReceipt {
  readonly version: 1;
  readonly scope: string;
  readonly operationId: string;
  readonly machineId: string;
  readonly executionWorkspaceId: string;
}
const maximumBytes = 2048;
const receiptName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;

function scopeDigest(scope: ExecutionReceiptScope): string {
  const url = new URL(scope.baseUrl);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol) ||
      !scope.profile || !scope.userId) throw new Error("Invalid execution recovery scope.");
  return createHash("sha256").update(JSON.stringify([url.href, scope.profile, scope.userId])).digest("hex");
}

function receipt(scope: ExecutionReceiptScope, machineId: string, executionWorkspaceId: string,
  operationId: string): ExecutionReceipt {
  for (const [label, value] of Object.entries({ machineId, executionWorkspaceId, operationId })) assertCanonicalUuid(value, label);
  // No endpoint query, credential, command, output, or command digest is persisted.
  const identity = scopeDigest(scope);
  return Object.freeze({ version: 1, scope: identity, machineId, executionWorkspaceId, operationId });
}

/** One immutable identity per file avoids cross-terminal read/modify/write loss. */
export async function saveExecutionReceipt(platform: PlatformAdapter, scope: ExecutionReceiptScope,
  machineId: string, executionWorkspaceId: string, operationId: string): Promise<string> {
  const value = receipt(scope, machineId, executionWorkspaceId, operationId);
  const filename = join(platform.paths.stateDirectory, "executions", value.scope, `${operationId}.json`);
  const text = JSON.stringify(value) + "\n";
  const previous = await platform.readSafeConfig(filename, maximumBytes);
  // A receipt is an attempt marker, not permission to replay a prior operation.
  if (previous.exists) throw new Error("This execution ID already has a recovery record. Inspect it before starting another command.");
  await platform.writeSafeConfig(filename, text, maximumBytes);
  const saved = await platform.readSafeConfig(filename, maximumBytes);
  if (!saved.exists || saved.text !== text) throw new Error("Execution recovery record could not be verified. No command was sent.");
  return filename;
}

/** Local attempts are discovery hints; only server readback establishes execution state. */
export async function listExecutionReceipts(platform: PlatformAdapter, scope: ExecutionReceiptScope,
  machineId: string, signal?: AbortSignal): Promise<readonly ExecutionReceipt[]> {
  signal?.throwIfAborted();
  assertCanonicalUuid(machineId, "machine ID");
  const digest = scopeDigest(scope);
  const root = join(platform.paths.stateDirectory, "executions"), directory = join(root, digest);
  const items: ExecutionReceipt[] = [];
  try {
    for (const target of [root, directory]) {
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Unsafe execution recovery directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw new Error("Local execution recovery records cannot be read safely.");
  }
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    signal?.throwIfAborted();
    if (++scanned > 8192) throw new Error("Too many local recovery files to list safely. No partial result is shown.");
    const match = receiptName.exec(entry.name);
    if (match === null) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe execution recovery record.");
    const snapshot = await platform.readSafeConfig(join(directory, entry.name), maximumBytes);
    let value: unknown;
    try { value = JSON.parse(snapshot.text ?? ""); } catch { throw new Error("A local execution recovery record is unreadable."); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid local execution recovery record.");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "executionWorkspaceId,machineId,operationId,scope,version" ||
      row.version !== 1 || row.scope !== digest || row.operationId !== match[1] ||
      typeof row.machineId !== "string" || typeof row.executionWorkspaceId !== "string") throw new Error("Invalid local execution recovery record.");
    const checked = receipt(scope, row.machineId, row.executionWorkspaceId, match[1]!);
    if (checked.machineId === machineId) items.push(checked);
  }
  signal?.throwIfAborted();
  return Object.freeze(items.sort((a, b) => a.operationId.localeCompare(b.operationId)));
}
