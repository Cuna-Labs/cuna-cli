import type { RunaApiClient } from "../api/client.js";

import { runtimeFailure } from "./errors.js";
import type {
  RemoteAgentSessionEvidence,
  TerminalControlPlane,
} from "./terminal-transport.js";

const SUPERVISOR_FRESHNESS_MS = 45_000;

export function createApiTerminalControlPlane(input: {
  readonly client: RunaApiClient;
  readonly clock?: () => number;
}): TerminalControlPlane {
  const clock = input.clock ?? Date.now;
  return Object.freeze({
    discoverCapabilities: (scope, resourceId) =>
      input.client.discoverCapabilities(scope, resourceId),

    async observeAgentSession(agentSessionId): Promise<RemoteAgentSessionEvidence> {
      const [identity, session] = await Promise.all([
        input.client.getIdentity(),
        input.client.getAgentSession(agentSessionId),
      ]);
      if (
        !identity.workspaceAssigned ||
        session.processEpoch === undefined ||
        session.runtimeObservedAt === undefined ||
        (session.processState !== "ready" && session.processState !== "running")
      ) {
        throw runtimeFailure(
          "remote_state_unproven",
          "The AgentSession is not freshly proven ready for terminal attachment.",
        );
      }
      const observedAt = Date.parse(session.runtimeObservedAt);
      if (!Number.isFinite(observedAt) || observedAt > clock() + 5_000) {
        throw runtimeFailure(
          "remote_state_unproven",
          "The AgentSession supervisor observation is malformed or future-dated.",
        );
      }
      return Object.freeze({
        authority: "runa_agent_session_supervisor",
        userId: identity.id,
        machineId: session.machineId,
        agentSessionId: session.id,
        processEpoch: session.processEpoch,
        state: session.processState,
        observedAt: session.runtimeObservedAt,
        expiresAt: new Date(observedAt + SUPERVISOR_FRESHNESS_MS).toISOString(),
        evidenceRevision: `agent-session-row:${session.rowVersion}`,
      });
    },

    async createTerminalConnection(request) {
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
      );
    },
  });
}
