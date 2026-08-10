import type { CapabilitySnapshot } from "../api/contracts.js";
import type {
  TerminalCapabilityName,
  TerminalConnectionGrant,
} from "../api/contracts.js";
import { TERMINAL_PROTOCOL, type TerminalReadyPayload } from "../terminal/codec.js";

import type { CapabilityAdmission } from "./capability-gate.js";
import { runtimeFailure } from "./errors.js";

const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const MAX_REMOTE_EVIDENCE_TTL_MS = 60_000;
const MAX_REMOTE_EVIDENCE_FUTURE_SKEW_MS = 5_000;

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

/**
 * Immutable authority admitted before a terminal attach begins. The runtime
 * revalidates this exact process generation and capability revision before and
 * after issuing a one-use connection grant.
 */
export interface TerminalAttachmentAdmission {
  readonly observation: RemoteAgentSessionEvidence;
  readonly capability: CapabilityAdmission;
}

export type {
  TerminalConnectionCapability,
  TerminalConnectionGrant,
} from "../api/contracts.js";

export interface TerminalControlPlane {
  discoverCapabilities(scope: "agent_session", resourceId: string, signal?: AbortSignal): Promise<CapabilitySnapshot>;
  observeAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<RemoteAgentSessionEvidence>;
  createTerminalConnection(input: {
    readonly agentSessionId: string;
    readonly protocol: typeof TERMINAL_PROTOCOL;
    readonly clientInstanceId: string;
    readonly idempotencyKey: string;
    readonly capabilityEvidence: CapabilityAdmission;
    readonly resumeHandle?: string;
    readonly signal?: AbortSignal;
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
      "This Cuna deployment does not expose the AgentSession terminal producer contract.",
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
    !CANONICAL_TIMESTAMP.test(evidence.observedAt) ||
    !CANONICAL_TIMESTAMP.test(evidence.expiresAt) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(observedAt).toISOString() !== evidence.observedAt ||
    new Date(expiresAt).toISOString() !== evidence.expiresAt ||
    observedAt > now + MAX_REMOTE_EVIDENCE_FUTURE_SKEW_MS ||
    expiresAt < observedAt ||
    expiresAt - observedAt > MAX_REMOTE_EVIDENCE_TTL_MS ||
    expiresAt <= now ||
    (evidence.state !== "ready" && evidence.state !== "running")
  ) {
    throw runtimeFailure("remote_state_unproven", "The AgentSession is not freshly proven ready for terminal attachment.");
  }
  return evidence;
}

export function validateTerminalGrant(input: {
  readonly grant: TerminalConnectionGrant;
  readonly allowedRunaOrigins: readonly string[];
  readonly requiredCapabilities?: readonly TerminalCapabilityName[];
  readonly now?: number;
}): TerminalConnectionGrant {
  const now = input.now ?? Date.now();
  const grant = input.grant;
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    grant.protocol !== TERMINAL_PROTOCOL ||
    !canonicalUuid(grant.terminalSessionId) ||
    !canonicalUuid(grant.resumeHandle) ||
    !/^runa_tc_[A-Za-z0-9_-]{43}$/u.test(grant.connectToken) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > 60_000
  ) {
    throw runtimeFailure(expiresAt <= now ? "grant_expired" : "grant_invalid", "The terminal ConnectionGrant is invalid or expired.");
  }
  const capabilityNames = new Set<TerminalCapabilityName>();
  for (const capability of grant.capabilities) {
    if (capabilityNames.has(capability.name)) {
      throw runtimeFailure("grant_invalid", "The terminal ConnectionGrant capability set is ambiguous.");
    }
    capabilityNames.add(capability.name);
  }
  if (capabilityNames.size !== 5) {
    throw runtimeFailure("grant_invalid", "The terminal ConnectionGrant capability set is incomplete.");
  }
  for (const required of input.requiredCapabilities ?? []) {
    const matches = grant.capabilities.filter((capability) => capability.name === required);
    if (matches.length !== 1 || matches[0]?.availability === "unknown") {
      throw runtimeFailure("capability_unknown", `Cuna cannot prove terminal capability ${required}.`);
    }
    if (matches[0]?.availability !== "supported") {
      throw runtimeFailure("capability_unsupported", `Terminal capability ${required} is unsupported.`);
    }
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
    url.pathname !== `/v1/terminal-connections/${grant.terminalSessionId}/stream` ||
    !input.allowedRunaOrigins.some((origin) => toWebSocketOrigin(origin) === url.origin)
  ) {
    throw runtimeFailure("grant_invalid", "The terminal connection URL is not an allowlisted Cuna origin.");
  }
  if (grant.connectUrl.includes(grant.connectToken)) {
    throw runtimeFailure("grant_invalid", "The terminal token must not be embedded in the connection URL.");
  }
  return grant;
}

export function assertReadyPayloadMatches(
  payload: Readonly<Record<string, unknown>>,
  observation: RemoteAgentSessionEvidence,
): asserts payload is Readonly<Record<string, unknown>> & TerminalReadyPayload {
  if (
    payload.protocol !== TERMINAL_PROTOCOL ||
    payload.agentSessionId !== observation.agentSessionId ||
    payload.processEpoch !== observation.processEpoch ||
    !Number.isSafeInteger(payload.fencingGeneration) ||
    Number(payload.fencingGeneration) < 1
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

function canonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
