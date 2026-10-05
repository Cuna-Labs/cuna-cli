import type { CunaApiClient } from "../api/client.js";
import type { AgentSessionWorkspaceContext } from "../api/remote-workspace.js";
import { admitCapability } from "./capability-gate.js";

import { runtimeFailure } from "./errors.js";
import type {
  RemoteAgentSessionEvidence,
  TerminalControlPlane,
} from "./terminal-transport.js";

export function createApiTerminalControlPlane(input: {
  readonly client: CunaApiClient;
  readonly clock?: () => number;
}): TerminalControlPlane {
  const clock = input.clock ?? Date.now;
  const workspaceContexts = new Map<string, AgentSessionWorkspaceContext>();
  /*
   * The principal this control plane reads for, read once. One attach observes
   * its session three times (preflight, admission, post-grant), and each
   * observation used to re-read `GET /v1/me`, which also computes the account's
   * usage summary: measured 2026-09-30 on Edge v242, one of those reads took
   * 2 847 ms and held "Checking terminal authority" on screen for 4.1 s. The
   * principal behind one credential does not change within one run, and every
   * grant is still authorized by the server on its own.
   */
  let principal: Awaited<ReturnType<CunaApiClient["getIdentity"]>> | undefined;
  const identity = async (signal?: AbortSignal) => principal ?? (principal = await input.client.getIdentity(signal));
  /** The Workspace read: its context is asked for only once its capability is admitted. */
  const readWorkspaceContext = async (agentSessionId: string, signal?: AbortSignal) => {
    const capabilities = await input.client.discoverCapabilities("agent_session", agentSessionId, signal);
    admitCapability(capabilities, { id: "agent_sessions.workspace.read", scope: "agent_session",
      subjectId: agentSessionId, surface: "cli", interaction: "read_only" }, clock());
    return await input.client.getAgentSessionWorkspaceContext(agentSessionId, signal);
  };
  return Object.freeze({
    discoverCapabilities: (scope: "agent_session", resourceId: string, signal?: AbortSignal) =>
      input.client.discoverCapabilities(scope, resourceId, signal),

    async observeAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<RemoteAgentSessionEvidence> {
      const previous = workspaceContexts.get(agentSessionId);
      // A session already known to run in a Workspace is asked for it beside
      // the row, not after it; a first observation needs the row's cwd to know.
      const knownContext = previous === undefined ? undefined : readWorkspaceContext(agentSessionId, signal);
      knownContext?.catch(() => undefined);
      const [account, session] = await Promise.all([
        identity(signal),
        input.client.getAgentSession(agentSessionId, signal),
      ]);
      if (
        !account.workspaceAssigned ||
        session.id !== agentSessionId ||
        session.processEpoch === undefined ||
        session.runtimeObservedAt === undefined ||
        session.runtimeExpiresAt === undefined
      ) {
        throw runtimeFailure(
          "remote_state_unproven",
          "The AgentSession has no process identity for terminal attachment.",
        );
      }
      if (previous !== undefined || session.cwd.startsWith("/workspace/workspaces/")) {
        const context = await (knownContext ?? readWorkspaceContext(agentSessionId, signal));
        if (context.agentSessionId !== agentSessionId || context.machineId !== session.machineId ||
            context.remoteRoot !== `/workspace/workspaces/${context.executionWorkspaceId}` ||
            !(session.cwd === context.remoteRoot || session.cwd.startsWith(`${context.remoteRoot}/`)) ||
            session.cwd.split("/").some((part) => part === "." || part === "..") ||
            (previous !== undefined && (context.executionWorkspaceId !== previous.executionWorkspaceId ||
              context.workspaceGeneration !== previous.workspaceGeneration || context.remoteRoot !== previous.remoteRoot ||
              context.machineId !== previous.machineId))) {
          throw runtimeFailure("session_discontinuous",
            "The AgentSession Workspace changed. Reconnect cannot substitute its admitted Workspace.");
        }
        workspaceContexts.set(agentSessionId, Object.freeze({ ...context }));
      }
      return Object.freeze({
        authority: "cuna_agent_session_supervisor",
        userId: account.id,
        machineId: session.machineId,
        agentSessionId: session.id,
        processEpoch: session.processEpoch,
        workspaceBindingId: session.workspaceBindingId ?? null,
        workspaceBindingGeneration: session.workspaceGeneration ?? null,
        state: session.processState,
        observedAt: session.runtimeObservedAt,
        expiresAt: session.runtimeExpiresAt,
        evidenceRevision: `agent-session-row:${session.rowVersion}`,
        createdAt: session.createdAt,
      });
    },

    async createTerminalConnection(
      request: Parameters<TerminalControlPlane["createTerminalConnection"]>[0],
    ) {
      if (
        request.capabilityEvidence.scope !== "agent_session" ||
        request.capabilityEvidence.subjectId !== request.agentSessionId ||
        request.capabilityEvidence.expiresAt <= clock()
      ) {
        throw runtimeFailure(
          "capability_snapshot_expired",
          "The terminal mutation no longer has fresh capability authority.",
        );
      }
      return input.client.createTerminalConnection(
        request.agentSessionId,
        {
          protocol: request.protocol,
          clientInstanceId: request.clientInstanceId,
          ...(request.resumeHandle === undefined
            ? {}
            : { resumeHandle: request.resumeHandle }),
          ...(request.accessMode === undefined ? {} : { accessMode: request.accessMode }),
          ...(request.expectedWriterEpoch === undefined
            ? {}
            : { expectedWriterEpoch: request.expectedWriterEpoch }),
        },
        request.idempotencyKey,
        request.signal,
      );
    },
    async transferTerminalWriter(
      request: Parameters<TerminalControlPlane["transferTerminalWriter"]>[0],
    ) {
      if (request.capabilityEvidence.capabilityId !== "terminal_writers.transfer" ||
          request.capabilityEvidence.scope !== "agent_session" ||
          request.capabilityEvidence.subjectId !== request.agentSessionId ||
          request.capabilityEvidence.expiresAt <= clock()) {
        throw runtimeFailure("capability_snapshot_expired", "Writer transfer requires a fresh capability for this exact AgentSession.");
      }
      return input.client.transferTerminalWriter(request.agentSessionId, {
        clientInstanceId: request.clientInstanceId,
        ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
        ...(request.expectedWriterEpoch === undefined ? {} : { expectedWriterEpoch: request.expectedWriterEpoch }),
      }, request.signal);
    },
    async cancelTerminalConnection(request: Parameters<TerminalControlPlane["createTerminalConnection"]>[0]) {
      // Recovery of this already-authorized issuance: an expired lease or a
      // failed discovery read must not prevent fencing its unredeemed grant.
      // Server authorization still applies to the same subject and request key.
      return input.client.cancelTerminalConnection(request.agentSessionId, {
        protocol: request.protocol, clientInstanceId: request.clientInstanceId,
        ...(request.resumeHandle === undefined ? {} : { resumeHandle: request.resumeHandle }),
        ...(request.accessMode === undefined ? {} : { accessMode: request.accessMode }),
        ...(request.expectedWriterEpoch === undefined ? {} : { expectedWriterEpoch: request.expectedWriterEpoch }),
      }, request.idempotencyKey, request.signal);
    },
  });
}
