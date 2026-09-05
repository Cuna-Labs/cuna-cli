import { contractViolation } from "../core/validation.js";

export interface ManagedCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeoutSecs?: number;
}

export interface ManagedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/** Output remains data; the terminal renderer must escape control sequences. */
export function decodeManagedCommandResult(value: unknown): ManagedCommandResult {
  const row = object(value, ["exit_code", "stdout", "stderr", "duration_ms", "stdout_truncated", "stderr_truncated"]);
  if (!Number.isSafeInteger(row.exit_code) || !Number.isSafeInteger(row.duration_ms) || Number(row.duration_ms) < 0 ||
      typeof row.stdout !== "string" || typeof row.stderr !== "string" ||
      typeof row.stdout_truncated !== "boolean" || typeof row.stderr_truncated !== "boolean") {
    throw contractViolation("managed_command_result");
  }
  return Object.freeze({ exitCode: row.exit_code as number, stdout: row.stdout, stderr: row.stderr,
    durationMs: row.duration_ms as number, stdoutTruncated: row.stdout_truncated, stderrTruncated: row.stderr_truncated });
}

export interface ManagedExecution {
  readonly operationId: string;
  readonly machineId: string;
  readonly executionWorkspaceId: string | null;
  readonly leaderState: "admitted" | "running" | "exited" | "refused" | "unknown";
  readonly ownershipState: "pending" | "allocated" | "descendants_live" | "cleanup_pending" | "cleared" | "unknown";
  readonly cancelRequested: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly observedAt: string | null;
}

export interface ManagedExecutionPage {
  readonly machineId: string;
  readonly items: readonly ManagedExecution[];
  readonly nextCursor: string | null;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw contractViolation("exact_managed_execution_shape");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw contractViolation("canonical_uuid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) throw contractViolation("timestamp");
  return value;
}

// A finished leader can still own descendants. These pairs mirror the durable
// producer constraint; neither cancellation acceptance nor exit releases them.
const STATES: Readonly<Record<ManagedExecution["leaderState"], readonly string[]>> = Object.freeze({
  admitted: ["pending", "allocated"],
  running: ["allocated", "cleanup_pending", "unknown"],
  exited: ["descendants_live", "cleanup_pending", "cleared", "unknown"],
  refused: ["cleanup_pending", "cleared", "unknown"],
  unknown: ["unknown", "cleanup_pending", "cleared"],
});

export function decodeManagedExecution(value: unknown): ManagedExecution {
  const row = object(value, ["operation_id", "machine_id", "execution_workspace_id", "leader_state", "ownership_state",
    "cancel_requested", "exit_code", "duration_ms", "reason", "created_at", "observed_at"]);
  if (typeof row.leader_state !== "string" || !Object.hasOwn(STATES, row.leader_state) ||
      typeof row.ownership_state !== "string" ||
      !STATES[row.leader_state as ManagedExecution["leaderState"]].includes(row.ownership_state)) {
    throw contractViolation("managed_execution_state_pair");
  }
  if (typeof row.cancel_requested !== "boolean" ||
      (row.exit_code !== null && !Number.isSafeInteger(row.exit_code)) ||
      (row.duration_ms !== null && (!Number.isSafeInteger(row.duration_ms) || Number(row.duration_ms) < 0)) ||
      (row.reason !== null && (typeof row.reason !== "string" || !/^managed_exec_[a-z_]{1,80}$/u.test(row.reason)))) {
    throw contractViolation("managed_execution_observation");
  }
  return Object.freeze({ operationId: uuid(row.operation_id), machineId: uuid(row.machine_id),
    executionWorkspaceId: row.execution_workspace_id === null ? null : uuid(row.execution_workspace_id),
    leaderState: row.leader_state as ManagedExecution["leaderState"], ownershipState: row.ownership_state as ManagedExecution["ownershipState"],
    cancelRequested: row.cancel_requested, exitCode: row.exit_code as number | null, durationMs: row.duration_ms as number | null,
    reason: row.reason as string | null, createdAt: timestamp(row.created_at), observedAt: row.observed_at === null ? null : timestamp(row.observed_at) });
}

export function decodeManagedExecutionPage(value: unknown): ManagedExecutionPage {
  const page = object(value, ["machine_id", "items", "next_cursor"]);
  const machineId = uuid(page.machine_id);
  if (!Array.isArray(page.items) || page.items.length > 50) throw contractViolation("bounded_managed_execution_page");
  let previous = "";
  const items = page.items.map((entry) => {
    const item = decodeManagedExecution(entry);
    if (item.machineId !== machineId || item.operationId <= previous) throw contractViolation("ordered_scoped_managed_executions");
    previous = item.operationId;
    return item;
  });
  const nextCursor = page.next_cursor === null ? null : uuid(page.next_cursor);
  if (nextCursor !== null && (items.length === 0 || nextCursor !== previous)) throw contractViolation("managed_execution_cursor");
  return Object.freeze({ machineId, items: Object.freeze(items), nextCursor });
}
