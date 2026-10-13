import { isReservedSecretName } from "../core/namespace.js";
/** Metadata-only authority; values and terminal connection proofs never enter errors. */
interface NamedSecretTerminalContext {
  readonly agent_session_id: string;
  readonly machine_id: string;
  readonly process_epoch: string;
  readonly terminal_connection_id: string;
  readonly connect_token: string;
  readonly writer_epoch: number;
}
export type NamedSecretContext = NamedSecretTerminalContext & (
  | Readonly<{ workspace_binding_id: string; execution_workspace_id?: never; execution_workspace_generation?: never }>
  | Readonly<{ execution_workspace_id: string; execution_workspace_generation: number; workspace_binding_id?: never }>
);
export interface NamedSecretReceipt {
  readonly operation_id: string;
  readonly state: "committed" | "rejected";
  readonly secret_id: string | null;
  readonly name: string | null;
  readonly workspace_id: string | null;
  readonly committed_at: string | null;
  readonly reason?: string;
}
export interface NamedSecretCreate {
  readonly operation_id: string;
  readonly name: string;
  readonly password: string;
  readonly context: NamedSecretContext;
}
export class NamedSecretRequestError extends Error {
  constructor(readonly status?: number) { super("Named-secret request did not return verified metadata."); this.name = "NamedSecretRequestError"; }
}
export const NAMED_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
export function validNamedSecretName(name: string): boolean {
  return NAMED_SECRET_NAME.test(name) && !isReservedSecretName(name);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function isNamedSecretUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
export function validNamedSecretScope(value: unknown): boolean {
  if(value===null || typeof value!=="object" || Array.isArray(value)) return false;
  const row=value as Record<string,unknown>, binding=Object.hasOwn(row,"workspace_binding_id"), execution=Object.hasOwn(row,"execution_workspace_id"), generation=Object.hasOwn(row,"execution_workspace_generation");
  return binding ? !execution && !generation && isNamedSecretUuid(row.workspace_binding_id)
    : execution && generation && isNamedSecretUuid(row.execution_workspace_id) && Number.isSafeInteger(row.execution_workspace_generation) && Number(row.execution_workspace_generation)>=1;
}
export function decodeNamedSecretReceipt(value: unknown): NamedSecretReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NamedSecretRequestError();
  const row = value as Record<string, unknown>;
  const required = ["operation_id", "state", "secret_id", "name", "workspace_id", "committed_at"];
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !required.includes(key) && key !== "reason") ||
      !isNamedSecretUuid(row.operation_id) || (row.state !== "committed" && row.state !== "rejected")) throw new NamedSecretRequestError();
  if (row.state === "committed") {
    if (!isNamedSecretUuid(row.secret_id) || !isNamedSecretUuid(row.workspace_id) || typeof row.name !== "string" || !validNamedSecretName(row.name) ||
        typeof row.committed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|\+00:00)$/u.test(row.committed_at) || !Number.isFinite(Date.parse(row.committed_at))) throw new NamedSecretRequestError();
  } else if ([row.secret_id, row.name, row.workspace_id, row.committed_at].some((item) => item !== null)) throw new NamedSecretRequestError();
  if (row.reason !== undefined && (typeof row.reason !== "string" || !/^[a-z][a-z0-9_.]{1,80}$/u.test(row.reason))) throw new NamedSecretRequestError();
  return Object.freeze({ operation_id: row.operation_id, state: row.state, secret_id: row.secret_id as string | null,
    name: row.name as string | null, workspace_id: row.workspace_id as string | null, committed_at: row.committed_at as string | null,
    ...(row.reason === undefined ? {} : { reason: row.reason as string }) });
}
