import type {
  AgentSession,
  AgentSessionAuthState,
  AgentSessionProcessObservation,
  Machine,
} from "../api/contracts.js";
import { machineProviderAvailability } from "./provider-availability.js";
import {
  agentSessionProcessObservation,
  AGENT_SESSION_OBSERVATION_NOTE,
  isAgentSessionIntendedActive,
  readRuntimeWindow,
} from "./session-visibility.js";

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
  /**
   * The lease is open AND the producer says nobody established the process
   * state for this epoch. Two codes rather than one, because the producer
   * distinguishes the causes: a lease renewal that settled without observing
   * the child, and no provenance recorded at all.
   *
   * Both keep the base state `attachable`. The lease is still what decides
   * whether attaching is worth attempting, and narrowing the action here would
   * withhold the one thing that can actually answer the question — a lease is
   * not an observation, but neither is a refusal to try.
   */
  | "runtime_lease_current_observation_unproven"
  | "runtime_lease_current_observation_unknown"
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
   * Who established `processState`, carried on every result with absence folded
   * into `unknown` by `session-visibility.ts`. It travels beside the base state
   * rather than inside it: a caller that renders one without the other is how
   * a moving lease came to print the same word as a real observation.
   */
  readonly processObservation: AgentSessionProcessObservation;
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
    processObservation: agentSessionProcessObservation(input.session),
    ...(runtimeWindow.lastObservedAt === undefined ? {} : { lastObservedAt: runtimeWindow.lastObservedAt }),
    ...(runtimeWindow.observationAgeMs === undefined ? {} : { observationAgeMs: runtimeWindow.observationAgeMs }),
    ...(runtimeWindow.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: runtimeWindow.leaseExpiresAt }),
  });
}

/**
 * The one line every list, tree and explorer row prints for a session.
 *
 * Both qualifiers are suffixes and neither can become or replace a base state:
 * `checking` is presentation only, and the observation note is a fact about
 * `processState`'s provenance, not a fourth lifecycle.
 *
 * Why the note is here at all. `attachable` was derived from the runtime lease
 * alone, so a row whose lease kept moving while nothing observed the child
 * printed the byte-identical line to one a supervisor had just looked at. The
 * note is attached only to `attachable`, because that is the only base state
 * whose word a reader takes as "this process is up"; `stale`, `starting`,
 * `failed`, `terminated` and `unsupported` already say the opposite or say
 * nothing, and a provenance note on them would blur three different answers.
 */
export function displaySessionActionability(value: SessionActionability): string {
  const parts = [value.baseState as string];
  const note = value.baseState === "attachable"
    ? AGENT_SESSION_OBSERVATION_NOTE[value.processObservation]
    : undefined;
  if (note !== undefined) parts.push(note);
  if (value.refreshStatus === "pending") parts.push("checking");
  return parts.join(" · ");
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
  if (runtimeWindow.kind !== "lease_current") return result("stale", "runtime_lease_expired");
  // ...and the provenance of the state the lease covers is named rather than
  // absorbed. `stale` would be wrong here: it means the lease lapsed and asks
  // for a refresh, which answers nothing about a row whose lease is open and
  // whose observation nobody established. So the base state, the action and the
  // attach admission are untouched, and only the reason changes.
  switch (agentSessionProcessObservation(session)) {
    case "observed": return result("attachable", "runtime_lease_current");
    case "unproven": return result("attachable", "runtime_lease_current_observation_unproven");
    case "unknown": return result("attachable", "runtime_lease_current_observation_unknown");
  }
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
