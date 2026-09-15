import { contractViolation } from "../core/validation.js";

function canonicalUuid(value: Record<string, unknown>, key: string): string {
  const id = value[key];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw contractViolation("canonical_uuid", key);
  return id;
}

export interface ExecutionWorkspace {
  readonly executionWorkspaceId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly machineId: string;
  readonly remoteRoot: string;
  readonly activeGeneration: number;
  readonly activeManifestRoot: string;
  readonly exclusionPolicyDigest: string;
  readonly createdAt: string;
}
export interface ExecutionWorkspacePage {
  readonly items: readonly ExecutionWorkspace[];
  readonly nextCursor: string | null;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw contractViolation("exact_execution_workspace_shape");
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw contractViolation("sha256_digest");
  return value;
}
export function decodeExecutionWorkspacePage(value: unknown): ExecutionWorkspacePage {
  const page = object(value, ["items", "next_cursor"]);
  if (!Array.isArray(page.items) || page.items.length > 50) throw contractViolation("bounded_execution_workspace_page");
  let previous = "";
  const items = page.items.map((entry): ExecutionWorkspace => {
    const row = object(entry, ["execution_workspace_id", "workspace_id", "project_id", "machine_id", "remote_root", "active_generation", "active_manifest_root", "exclusion_policy_digest", "created_at"]);
    const executionWorkspaceId = canonicalUuid(row, "execution_workspace_id");
    if (executionWorkspaceId <= previous) throw contractViolation("ascending_unique_execution_workspaces");
    previous = executionWorkspaceId;
    if (row.remote_root !== `/workspace/workspaces/${executionWorkspaceId}`) throw contractViolation("execution_workspace_root");
    if (!Number.isSafeInteger(row.active_generation) || Number(row.active_generation) < 0) throw contractViolation("safe_generation");
    if (typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) throw contractViolation("timestamp");
    return Object.freeze({ executionWorkspaceId, workspaceId: canonicalUuid(row, "workspace_id"),
      projectId: canonicalUuid(row, "project_id"), machineId: canonicalUuid(row, "machine_id"),
      remoteRoot: row.remote_root, activeGeneration: Number(row.active_generation),
      activeManifestRoot: digest(row.active_manifest_root), exclusionPolicyDigest: digest(row.exclusion_policy_digest), createdAt: row.created_at });
  });
  const nextCursor = page.next_cursor === null ? null : canonicalUuid(page, "next_cursor");
  if (nextCursor !== null && (items.length === 0 || nextCursor !== previous)) throw contractViolation("execution_workspace_cursor");
  return Object.freeze({ items: Object.freeze(items), nextCursor });
}
