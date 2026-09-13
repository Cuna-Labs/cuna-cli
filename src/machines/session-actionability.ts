import type { AgentSession, AgentSessionAuthState, Machine } from "../api/contracts.js";
import { machineProviderAvailability } from "./provider-availability.js";
import { isAgentSessionIntendedActive, readRuntimeWindow } from "./session-visibility.js";

export type SessionBaseState = "attachable" | "starting" | "login-required" | "stale" | "failed" | "terminated" | "unsupported";
export type SessionRefreshStatus = "idle" | "pending";
export type SessionRecoveryAction = "attach" | "wait" | "authenticate" | "refresh" | "show-failure" | "none";
/**
 * `runtime_lease_current` and `runtime_lease_expired` were `runtime_evidence_*`.
 *
 * The word was wrong in a way that mattered. What this classifier tests at the
 * end is the runtime LEASE window, and a lease renewal that carries no fresh
 * observation moves it on its own. Calling the result "evidence current" told a
 * reader that something had recently observed the process, which the row does
 * not say, and the timestamps beside it now let a caller see the difference
 * instead of inferring it from a name.
 *
 * `runtime_evidence_missing` and `runtime_evidence_invalid` keep their names:
 * they really are about the evidence fields, not about the window.
 */
export type SessionActionReasonCode =
  | "runtime_lease_current"
  | "launch_pending"
  | "provider_authentication_required"
  | "runtime_evidence_missing"
  | "runtime_evidence_invalid"
  | "runtime_lease_expired"
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
  /**
   * When the producer last observed this process, and how old that is at `now`.
   * Present only once the runtime timestamps parse. Reported so a caller can
   * show "last seen 4 h ago" beside an open lease; NO threshold is applied to
   * it here, because no producer contract publishes one.
   */
  readonly lastObservedAt?: string;
  readonly observationAgeMs?: number;
  /** The lease window's end. Distinct from the observation above. */
  readonly leaseExpiresAt?: string;
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
  // Carried on every result, not only the attachable one: a `stale` row is
  // exactly where "when was it last seen" is the question being asked.
  const runtimeWindow = readRuntimeWindow(input.session, input.now);
  return Object.freeze({
    ...classified,
    refreshStatus: input.refreshStatus ?? "idle",
    recoveryAction: recoveryFor(classified.baseState),
    observationRevision: input.session.rowVersion,
    canAttach: classified.baseState === "attachable",
    ...(runtimeWindow.lastObservedAt === undefined ? {} : { lastObservedAt: runtimeWindow.lastObservedAt }),
    ...(runtimeWindow.observationAgeMs === undefined ? {} : { observationAgeMs: runtimeWindow.observationAgeMs }),
    ...(runtimeWindow.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: runtimeWindow.leaseExpiresAt }),
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
  if (session.processEpoch === undefined) return result("stale", "runtime_evidence_missing");
  // One parser for both timestamps, shared with `session-visibility.ts`.
  const runtimeWindow = readRuntimeWindow(session, now);
  if (runtimeWindow.kind === "missing") return result("stale", "runtime_evidence_missing");
  if (runtimeWindow.kind === "invalid") return result("stale", "runtime_evidence_invalid");
  // The lease decides whether attaching is worth attempting, exactly as before:
  // the server's capability snapshot and terminal grant remain the authority
  // that admits or refuses the attach, and nothing here is narrowed by the age
  // of the observation carried alongside.
  return runtimeWindow.kind === "lease_current"
    ? result("attachable", "runtime_lease_current")
    : result("stale", "runtime_lease_expired");
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
