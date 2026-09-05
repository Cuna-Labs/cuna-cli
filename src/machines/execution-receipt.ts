import { createHash } from "node:crypto";
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

function receipt(scope: ExecutionReceiptScope, machineId: string, executionWorkspaceId: string,
  operationId: string): ExecutionReceipt {
  for (const [label, value] of Object.entries({ machineId, executionWorkspaceId, operationId })) assertCanonicalUuid(value, label);
  // No endpoint query, credential, command, output, or command digest is persisted.
  const url = new URL(scope.baseUrl);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol) ||
      !scope.profile || !scope.userId) throw new Error("Invalid execution recovery scope.");
  const identity = createHash("sha256").update(JSON.stringify([url.href, scope.profile, scope.userId])).digest("hex");
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
