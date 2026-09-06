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
  readonly machineId: string;
  readonly workspaceId: string;
  readonly agent: "claude-code" | "codex" | "opencode";
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly idempotencyKey?: string;
}): Promise<string> {
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
  await gate("agent_sessions.workspace.create");
  const agentName = input.agent === "claude-code" ? "Claude Code" : input.agent === "opencode" ? "OpenCode" : "Codex";
  input.onProgress?.(`Starting ${agentName} remotely · no local sync`);
  const request = { agent: input.agent, cwd: workspace.remoteRoot, executionWorkspaceId: workspace.executionWorkspaceId,
    workspaceGeneration: workspace.workspaceGeneration, authMode: "interactive_login" as const };
  const create = async () => (await input.client.createAgentSessionInWorkspace(input.machineId, request, key, signal)).agentSession;
  let session: AgentSession;
  try { session = await create(); } catch (error) {
    if (!(error instanceof CunaError) || !(isObservationBudgetCode(error.code) || error.code === "cuna.network.failed") || signal.aborted) throw error;
    try { session = await input.client.inspectAgentSessionCreate(key, signal); } catch (inspectionError) {
      if (!(inspectionError instanceof CunaError) || inspectionError.code !== "agent_session_not_found" || signal.aborted) throw inspectionError;
      session = await create();
    }
  }
  const sessionId = session.id;
  const validate = (value: AgentSession) => {
    if (value.id !== sessionId || value.machineId !== input.machineId || value.agent !== input.agent ||
        value.cwd !== workspace.remoteRoot || value.authMode !== "interactive_login" ||
        value.workspaceBindingId !== undefined || value.workspaceGeneration !== undefined) throw mismatch();
  };
  validate(session);
  await requireCapability({ client: input.client, scope: "agent_session", resourceId: sessionId,
    capabilityId: "agent_sessions.workspace.read", now, signal, allowedInteractions: ["read_only"] });
  const context = await input.client.getAgentSessionWorkspaceContext(sessionId, signal);
  if (context.agentSessionId !== sessionId || context.machineId !== input.machineId || context.executionWorkspaceId !== workspace.executionWorkspaceId ||
      context.workspaceGeneration !== workspace.workspaceGeneration || context.remoteRoot !== workspace.remoteRoot) throw mismatch();
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
