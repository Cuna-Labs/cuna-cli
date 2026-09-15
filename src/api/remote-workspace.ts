import { contractViolation } from "../core/validation.js";
import { decodeAgentSessionItem, type AgentSession } from "./contracts.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw contractViolation("exact_remote_workspace_shape");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw contractViolation("canonical_uuid");
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw contractViolation("positive_safe_generation");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw contractViolation("sha256_digest");
  return value;
}
export interface MachineDefaultWorkspace {
  readonly machineId: string; readonly workspaceId: string; readonly projectId: string;
  readonly executionWorkspaceId: string; readonly remoteRoot: string;
  readonly machineGeneration: string; readonly workspaceGeneration: number;
  readonly manifestRoot: string; readonly policyDigest: string;
  readonly publicationStatus: "pending" | "ready" | "conflict" | "failed";
  readonly publicationEpoch: number | null; readonly reason: string | null;
}
export function decodeMachineDefaultWorkspace(value: unknown): MachineDefaultWorkspace {
  const row = object(value, ["machine_id", "workspace_id", "project_id", "execution_workspace_id", "remote_root", "origin", "initialization", "machine_generation", "workspace_generation", "manifest_root", "policy_digest", "publication_status", "publication_epoch", "reason"]);
  const machineId=id(row.machine_id), workspaceId=id(row.workspace_id), projectId=id(row.project_id), executionWorkspaceId=id(row.execution_workspace_id);
  if (new Set([machineId,workspaceId,projectId,executionWorkspaceId]).size !== 4 || row.remote_root !== `/workspace/workspaces/${executionWorkspaceId}` ||
      row.origin !== "machine_create" || row.initialization !== "empty" || typeof row.machine_generation !== "string" ||
      !/^(?:0|[1-9][0-9]{0,18})$/u.test(row.machine_generation)) throw contractViolation("remote_workspace_identity");
  const status=row.publication_status;
  if (status !== "pending" && status !== "ready" && status !== "conflict" && status !== "failed") throw contractViolation("publication_state");
  const epoch=status === "ready" ? positive(row.publication_epoch) : null;
  if ((status !== "ready" && row.publication_epoch !== null) ||
      ((status === "pending" || status === "ready") ? row.reason !== null :
        typeof row.reason !== "string" || !/^workspace\.[a-z0-9_]{1,64}$/u.test(row.reason))) throw contractViolation("publication_evidence");
  return Object.freeze({machineId,workspaceId,projectId,executionWorkspaceId,remoteRoot:row.remote_root,machineGeneration:row.machine_generation,
    workspaceGeneration:positive(row.workspace_generation),manifestRoot:digest(row.manifest_root),policyDigest:digest(row.policy_digest),
    publicationStatus:status,publicationEpoch:epoch,reason:row.reason as string|null});
}
export interface AgentSessionWorkspaceContext {
  readonly agentSessionId: string; readonly machineId: string; readonly executionWorkspaceId: string;
  readonly workspaceGeneration: number; readonly remoteRoot: string;
}
export interface AgentSessionWorkspaceEnvelope extends AgentSessionWorkspaceContext { readonly agentSession: AgentSession; }
export function decodeAgentSessionWorkspaceContext(value: unknown): AgentSessionWorkspaceContext {
  const row=object(value,["agent_session_id","machine_id","execution_workspace_id","workspace_generation","remote_root"]);
  const executionWorkspaceId=id(row.execution_workspace_id);
  const agentSessionId=id(row.agent_session_id), machineId=id(row.machine_id);
  if (new Set([agentSessionId,machineId,executionWorkspaceId]).size !== 3) throw contractViolation("distinct_remote_workspace_identity");
  if (row.remote_root !== `/workspace/workspaces/${executionWorkspaceId}`) throw contractViolation("remote_workspace_root");
  return Object.freeze({agentSessionId,machineId,executionWorkspaceId,workspaceGeneration:positive(row.workspace_generation),remoteRoot:row.remote_root});
}
export function decodeAgentSessionWorkspaceEnvelope(value: unknown): AgentSessionWorkspaceEnvelope {
  const row=object(value,["agent_session","execution_workspace_id","workspace_generation","remote_root"]);
  const agentSession=decodeAgentSessionItem(row.agent_session);
  if (agentSession.workspaceBindingId !== undefined || agentSession.workspaceGeneration !== undefined) throw contractViolation("remote_session_without_local_binding");
  const context=decodeAgentSessionWorkspaceContext({agent_session_id:agentSession.id,machine_id:agentSession.machineId,execution_workspace_id:row.execution_workspace_id,workspace_generation:row.workspace_generation,remote_root:row.remote_root});
  return Object.freeze({...context,agentSession});
}
