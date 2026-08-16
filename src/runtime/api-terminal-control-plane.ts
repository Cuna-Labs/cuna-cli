import type { CunaApiClient } from "../api/client.js";

import { runtimeFailure } from "./errors.js";
import type {
  RemoteAgentSessionEvidence,
  TerminalControlPlane,
} from "./terminal-transport.js";

const MAX_SUPERVISOR_LEASE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export function createApiTerminalControlPlane(input: {
  readonly client: CunaApiClient;
  readonly clock?: () => number;
}): TerminalControlPlane {
  const clock = input.clock ?? Date.now;
  return Object.freeze({
    discoverCapabilities: (scope: "agent_session", resourceId: string, signal?: AbortSignal) =>
      input.client.discoverCapabilities(scope, resourceId, signal),

    async observeAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<RemoteAgentSessionEvidence> {
      const [identity, session] = await Promise.all([
        input.client.getIdentity(signal),
        input.client.getAgentSession(agentSessionId, signal),
      ]);
      if (
        !identity.workspaceAssigned ||
        session.processEpoch === undefined ||
        session.runtimeObservedAt === undefined ||
        session.runtimeExpiresAt === undefined ||
        (session.processState !== "ready" && session.processState !== "running")
      ) {
        throw runtimeFailure(
          "remote_state_unproven",
          "The AgentSession is not freshly proven ready for terminal attachment.",
        );
      }
      const now = clock();
      const observedAt = Date.parse(session.runtimeObservedAt);
      const expiresAt = Date.parse(session.runtimeExpiresAt);
      if (
        !Number.isFinite(observedAt) ||
        !Number.isFinite(expiresAt) ||
        observedAt > now + MAX_FUTURE_SKEW_MS ||
        expiresAt <= observedAt ||
        expiresAt - observedAt > MAX_SUPERVISOR_LEASE_MS ||
        expiresAt <= now
      ) {
        throw runtimeFailure(
          "remote_state_unproven",
          "The AgentSession supervisor observation has invalid or expired lease authority.",
        );
      }
      return Object.freeze({
        authority: "cuna_agent_session_supervisor",
        userId: identity.id,
        machineId: session.machineId,
        agentSessionId: session.id,
        processEpoch: session.processEpoch,
        state: session.processState,
        observedAt: session.runtimeObservedAt,
        expiresAt: session.runtimeExpiresAt,
        evidenceRevision: `agent-session-row:${session.rowVersion}`,
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
        },
        request.idempotencyKey,
        request.signal,
      );
    },
  });
}
