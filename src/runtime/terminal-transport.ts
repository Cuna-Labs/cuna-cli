import type { CapabilitySnapshot } from "../api/contracts.js";
import { TERMINAL_PROTOCOL, type TerminalReadyPayload } from "../terminal/codec.js";

import type { CapabilityAdmission } from "./capability-gate.js";
import { runtimeFailure } from "./errors.js";

export interface RemoteAgentSessionEvidence {
  readonly authority: "runa_agent_session_supervisor";
  readonly userId: string;
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly state: "starting" | "ready" | "running" | "exited" | "failed" | "terminating" | "terminated" | "unknown";
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evidenceRevision: string;
}

export interface TerminalConnectionGrant {
  readonly terminalConnectionId: string;
  readonly resumeHandle: string;
  readonly connectUrl: string;
  readonly connectToken: string;
  readonly protocol: typeof TERMINAL_PROTOCOL;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly attachmentGeneration: number;
}

export interface TerminalControlPlane {
  discoverCapabilities(scope: "agent_session", resourceId: string): Promise<CapabilitySnapshot>;
  observeAgentSession(agentSessionId: string): Promise<RemoteAgentSessionEvidence>;
  createTerminalConnection(input: {
    readonly agentSessionId: string;
    readonly protocol: typeof TERMINAL_PROTOCOL;
    readonly clientInstanceId: string;
    readonly idempotencyKey: string;
    readonly capabilityEvidence: CapabilityAdmission;
    readonly resumeHandle?: string;
  }): Promise<TerminalConnectionGrant>;
}

export interface TerminalWireConnection {
  readonly connectionId: string;
  receive(): AsyncIterable<Uint8Array>;
  send(bytes: Uint8Array): Promise<void>;
  close(input?: { readonly code?: number; readonly reason?: string }): Promise<void>;
}

export interface TerminalConnector {
  connect(input: {
    readonly url: string;
    readonly token: string;
    readonly protocol: typeof TERMINAL_PROTOCOL;
    readonly signal?: AbortSignal;
  }): Promise<TerminalWireConnection>;
}

export function createUnavailableTerminalControlPlane(): TerminalControlPlane {
  const unavailable = async (): Promise<never> => {
    throw runtimeFailure(
      "control_plane_unavailable",
      "This Runa deployment does not expose the AgentSession terminal producer contract.",
    );
  };
  return Object.freeze({
    discoverCapabilities: unavailable,
    observeAgentSession: unavailable,
    createTerminalConnection: unavailable,
  });
}

export function assertRemoteAgentSessionEvidence(input: {
  readonly evidence: RemoteAgentSessionEvidence;
  readonly expectedAgentSessionId: string;
  readonly now?: number;
}): RemoteAgentSessionEvidence {
  const evidence = input.evidence;
  const now = input.now ?? Date.now();
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  if (
    evidence.authority !== "runa_agent_session_supervisor" ||
    evidence.agentSessionId !== input.expectedAgentSessionId ||
    evidence.userId.length === 0 ||
    evidence.machineId.length === 0 ||
    evidence.processEpoch.length === 0 ||
    evidence.evidenceRevision.length === 0 ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt < observedAt ||
    expiresAt <= now ||
    (evidence.state !== "ready" && evidence.state !== "running")
  ) {
    throw runtimeFailure("remote_state_unproven", "The AgentSession is not freshly proven ready for terminal attachment.");
  }
  return evidence;
}

export function validateTerminalGrant(input: {
  readonly grant: TerminalConnectionGrant;
  readonly observation: RemoteAgentSessionEvidence;
  readonly allowedRunaOrigins: readonly string[];
  readonly now?: number;
}): TerminalConnectionGrant {
  const now = input.now ?? Date.now();
  const grant = input.grant;
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    grant.protocol !== TERMINAL_PROTOCOL ||
    !safeIdentifier(grant.terminalConnectionId) ||
    !safeIdentifier(grant.resumeHandle) ||
    grant.connectToken.length < 16 ||
    grant.connectToken.length > 4096 ||
    grant.connectToken.includes("\0") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 60_000 ||
    !Number.isSafeInteger(grant.attachmentGeneration) ||
    grant.attachmentGeneration < 1
  ) {
    throw runtimeFailure(expiresAt <= now ? "grant_expired" : "grant_invalid", "The terminal ConnectionGrant is invalid or expired.");
  }
  if (
    grant.userId !== input.observation.userId ||
    grant.machineId !== input.observation.machineId ||
    grant.agentSessionId !== input.observation.agentSessionId ||
    grant.processEpoch !== input.observation.processEpoch
  ) {
    throw runtimeFailure("grant_scope_mismatch", "The terminal ConnectionGrant targets another resource generation.");
  }
  let url: URL;
  try {
    url = new URL(grant.connectUrl);
  } catch {
    throw runtimeFailure("grant_invalid", "The terminal connection URL is invalid.");
  }
  if (
    url.protocol !== "wss:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.includes("..") ||
    !input.allowedRunaOrigins.some((origin) => toWebSocketOrigin(origin) === url.origin)
  ) {
    throw runtimeFailure("grant_invalid", "The terminal connection URL is not an allowlisted Runa origin.");
  }
  if (grant.connectUrl.includes(grant.connectToken)) {
    throw runtimeFailure("grant_invalid", "The terminal token must not be embedded in the connection URL.");
  }
  return grant;
}

export function assertReadyPayloadMatches(
  payload: Readonly<Record<string, unknown>>,
  observation: RemoteAgentSessionEvidence,
  grant: TerminalConnectionGrant,
): asserts payload is Readonly<Record<string, unknown>> & TerminalReadyPayload {
  if (
    payload.protocol !== TERMINAL_PROTOCOL ||
    payload.agentSessionId !== observation.agentSessionId ||
    payload.processEpoch !== observation.processEpoch ||
    payload.fencingGeneration !== grant.attachmentGeneration
  ) {
    throw runtimeFailure("grant_scope_mismatch", "Terminal readiness evidence targets another AgentSession generation.");
  }
}

function toWebSocketOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    url.protocol = "wss:";
    return url.origin;
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}
