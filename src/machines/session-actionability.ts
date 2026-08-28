import type { AgentSession, AgentSessionAuthState, Machine } from "../api/contracts.js";
import { machineProviderAvailability } from "./provider-availability.js";
import { isAgentSessionIntendedActive } from "./session-visibility.js";

const MAX_FUTURE_SKEW_MS = 5_000;

export type SessionBaseState = "attachable" | "starting" | "login-required" | "stale" | "failed" | "terminated" | "unsupported";
export type SessionRefreshStatus = "idle" | "pending";
export type SessionRecoveryAction = "attach" | "wait" | "authenticate" | "refresh" | "show-failure" | "none";
export type SessionActionReasonCode =
  | "runtime_evidence_current"
  | "launch_pending"
  | "provider_authentication_required"
  | "runtime_evidence_missing"
  | "runtime_evidence_invalid"
  | "runtime_evidence_expired"
  | "session_failed"
  | "termination_intended"
  | "machine_not_running"
  | "provider_unavailable"
  | "provider_mismatch";

export interface SessionActionability {
  readonly baseState: SessionBaseState;
  readonly refreshStatus: SessionRefreshStatus;
  readonly recoveryAction: SessionRecoveryAction;
  readonly reasonCode: SessionActionReasonCode;
  readonly observationRevision: number;
  readonly canAttach: boolean;
}

export interface SessionActionabilityInput {
  readonly session: AgentSession;
  readonly machine?: Pick<Machine, "id" | "agent" | "state">;
  readonly authState?: AgentSessionAuthState;
  readonly now: number;
  readonly refreshStatus?: SessionRefreshStatus;
}

interface ClassifiedBase {
  readonly baseState: SessionBaseState;
  readonly reasonCode: SessionActionReasonCode;
}

export function classifySessionActionability(input: SessionActionabilityInput): SessionActionability {
  const classified = classifyBase(input);
  return Object.freeze({
    ...classified,
    refreshStatus: input.refreshStatus ?? "idle",
    recoveryAction: recoveryFor(classified.baseState),
    observationRevision: input.session.rowVersion,
    canAttach: classified.baseState === "attachable",
  });
}

/** `checking` is presentation only; it can never become or replace a base state. */
export function displaySessionActionability(value: SessionActionability): string {
  return value.refreshStatus === "pending" ? `${value.baseState} · checking` : value.baseState;
}

/** Missing, equal, or lower revisions cannot replace the confirmed state. */
export function mergeSessionActionabilityObservation(input: Readonly<{
  readonly confirmed: SessionActionability;
  readonly candidate?: SessionActionability;
  readonly refreshStatus: SessionRefreshStatus;
}>): SessionActionability {
  const accepted = input.candidate !== undefined &&
    input.candidate.observationRevision > input.confirmed.observationRevision
    ? input.candidate
    : input.confirmed;
  return Object.freeze({ ...accepted, refreshStatus: input.refreshStatus });
}

function classifyBase(input: SessionActionabilityInput): ClassifiedBase {
  const { session, machine, authState, now } = input;
  if (!isAgentSessionIntendedActive(session) || session.requestState === "terminal" ||
      session.processState === "terminated" || session.processState === "terminating") {
    return result("terminated", "termination_intended");
  }
  if (session.requestState === "failed" || session.processState === "failed" || session.processState === "exited") {
    return result("failed", "session_failed");
  }
  if (machine !== undefined) {
    if (machine.state !== "running") return result("unsupported", "machine_not_running");
    const provider = machineProviderAvailability(machine);
    if (!provider.actionable) return result("unsupported", "provider_unavailable");
    if (provider.agent !== session.agent) return result("unsupported", "provider_mismatch");
  } else if (session.agent !== "claude-code" && session.agent !== "codex" && session.agent !== "opencode") {
    return result("unsupported", "provider_unavailable");
  }
  if (authState === "login_required") return result("login-required", "provider_authentication_required");
  if (authState === "unavailable") return result("unsupported", "provider_unavailable");
  if (session.requestState === "launch_pending" || session.requestState === "runtime_claimed" ||
      session.processState === "unknown" || session.processState === "starting") {
    return result("starting", "launch_pending");
  }
  if (session.processState !== "ready" && session.processState !== "running") {
    return result("stale", "runtime_evidence_invalid");
  }
  if (session.processEpoch === undefined || session.runtimeObservedAt === undefined || session.runtimeExpiresAt === undefined) {
    return result("stale", "runtime_evidence_missing");
  }
  const observedAt = Date.parse(session.runtimeObservedAt);
  const expiresAt = Date.parse(session.runtimeExpiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      observedAt > now + MAX_FUTURE_SKEW_MS || expiresAt <= observedAt) {
    return result("stale", "runtime_evidence_invalid");
  }
  return expiresAt > now
    ? result("attachable", "runtime_evidence_current")
    : result("stale", "runtime_evidence_expired");
}

function result(baseState: SessionBaseState, reasonCode: SessionActionReasonCode): ClassifiedBase {
  return Object.freeze({ baseState, reasonCode });
}

function recoveryFor(state: SessionBaseState): SessionRecoveryAction {
  switch (state) {
    case "attachable": return "attach";
    case "starting": return "wait";
    case "login-required": return "authenticate";
    case "stale": return "refresh";
    case "failed": return "show-failure";
    case "terminated":
    case "unsupported": return "none";
  }
}
