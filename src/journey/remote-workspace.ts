import type { ProviderPreset } from "../api/provider-v2.js";
import { randomUUID } from "node:crypto";
import { sessionFailure } from "./session-failure.js";
import { setTimeout as delay } from "node:timers/promises";
import { requireCapability, type CunaApiClient } from "../api/client.js";
import type { AgentSession } from "../api/contracts.js";
import type { MachineDefaultWorkspace } from "../api/remote-workspace.js";
import { CunaError, EXIT_CODES } from "../core/errors.js";
import { isObservationBudgetCode, observationBudgetElapsed, REMOTE_CONVERGENCE_BUDGET_MS } from "../core/observation-budget.js";

/** A remote-only launch never creates a local workspace binding. */
export async function launchRemoteWorkspaceSession(input: {
  readonly client: CunaApiClient;
  readonly preset: ProviderPreset;
  readonly machineId: string;
  readonly workspaceId: string;
  readonly agent: "claude-code" | "codex" | "opencode";
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly idempotencyKey?: string;
}): Promise<string> {
  if (input.agent !== "opencode") throw new CunaError({code:"cuna.provider.v2_unavailable",message:"V2 provider presets currently support OpenCode only.",exitCode:EXIT_CODES.usage});
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const signal = input.signal ?? new AbortController().signal;
  const key = input.idempotencyKey ?? randomUUID();
  const gate = async (capabilityId: string, readOnly = false) => {
    signal.throwIfAborted();
    await requireCapability({ client: input.client, scope: "machine", resourceId: input.machineId,
      capabilityId, now, signal, allowedInteractions: readOnly ? ["read_only"] : ["native"] });
  };
  const mismatch = () => new CunaError({ code: "cuna.journey.remote_workspace_authority_mismatch",
    message: "The remote session or Workspace no longer matches the selected Machine and account.", exitCode: EXIT_CODES.conflict });
  const timeout = (operation: string) => observationBudgetElapsed({ kind: "response", operation,
    budgetMs: REMOTE_CONVERGENCE_BUDGET_MS, settleWith: `cuna agent-sessions list --machine ${input.machineId}` });
  await gate("machines.default_workspace.read", true);
  input.onProgress?.("Preparing remote workspace · no local sync");
  const started = now();
  let workspace: MachineDefaultWorkspace;
  for (;;) {
    signal.throwIfAborted();
    workspace = await input.client.getMachineDefaultWorkspace(input.machineId, signal);
    if (workspace.machineId !== input.machineId || workspace.workspaceId !== input.workspaceId) throw mismatch();
    if (workspace.publicationStatus === "ready") break;
    if (workspace.publicationStatus !== "pending") throw new CunaError({
      code: "cuna.journey.remote_workspace_publication_failed", message: "The runtime could not publish this remote Workspace.",
      exitCode: EXIT_CODES.remote, details: { reason: workspace.reason ?? "unknown" } });
    if (now() - started >= REMOTE_CONVERGENCE_BUDGET_MS) throw timeout("remote Workspace publication");
    await sleep(500, signal);
  }
  const agentName = "OpenCode";
  input.onProgress?.("Starting OpenCode with the selected expected provider preset");
  let session = await createPublishedProviderSessionV2({client:input.client,machineId:input.machineId,preset:input.preset,operationId:key,executionWorkspaceId:workspace.executionWorkspaceId,generation:workspace.workspaceGeneration,cwd:workspace.remoteRoot,signal});
  const sessionId = session.id;
  const validate = (value: AgentSession) => {
    if (value.id !== sessionId || value.machineId !== input.machineId || value.agent !== input.agent ||
        value.cwd !== workspace.remoteRoot || value.authMode !== "interactive_login" ||
        value.workspaceBindingId !== undefined || value.workspaceGeneration !== undefined) throw mismatch();
  };
  validate(session);
  input.onProgress?.(`Waiting for ${agentName} remotely · no local sync`);
  const admittedAt = now();
  for (;;) {
    signal.throwIfAborted();
    session = await input.client.getAgentSession(sessionId, signal);
    validate(session);
    if (session.requestState === "failed" || ["exited", "failed", "terminated"].includes(session.processState)) {
      throw sessionFailure(session, "The remote session ended before attachment.");
    }
    if (session.processState === "ready" || session.processState === "running") return sessionId;
    if (now() - admittedAt >= REMOTE_CONVERGENCE_BUDGET_MS) throw timeout("remote session readiness");
    await sleep(500, signal);
  }
}

/** Shared canonical admission for already published remote or synchronized Workspaces. */
export async function createPublishedProviderSessionV2(input:{client:CunaApiClient;machineId:string;preset:ProviderPreset;operationId:string;executionWorkspaceId:string;generation:number;cwd:string;signal:AbortSignal}):Promise<AgentSession>{
 const request={operation_id:input.operationId,cwd:input.cwd,execution_workspace_id:input.executionWorkspaceId,workspace_generation:input.generation,profile_id:input.preset.profile_id,profile_revision:input.preset.profile_revision};
 const create=async()=>(await input.client.createProviderSessionV2(input.machineId,request,input.signal)).agentSession;
 let session:AgentSession;
 try{session=await create();}catch(error){if(!(error instanceof CunaError)||!(isObservationBudgetCode(error.code)||error.code==='cuna.network.failed')||input.signal.aborted)throw error;session=await create();}
 if(session.machineId!==input.machineId||session.agent!=='opencode'||session.cwd!==input.cwd||session.authMode!=='interactive_login'||session.workspaceBindingId!==undefined||session.workspaceGeneration!==undefined)throw new CunaError({code:'cuna.journey.agent_session_create_authority_mismatch',message:'The admitted session does not match the selected published Workspace.',exitCode:EXIT_CODES.conflict});
 return session;
}
